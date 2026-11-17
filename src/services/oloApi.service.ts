import { createHash, createHmac } from 'crypto';
import { unzipSync, strFromU8 } from 'fflate';
import type { ConfigOlo } from '../config/olo';
import { parsearJsonSeguro, idComoTexto } from '../lib/ids';

/**
 * Cliente de la Ordering API v1.1 de Olo, solo lectura.
 *
 * Reemplaza a toastApi.service. Diferencias de fondo con Toast:
 *  - No hay token: cada peticion se firma (Signature Authorization, plataforma
 *    ThirdParty), que es lo que exige el Vendor Export.
 *  - No hay polling de menu: los endpoints de menu en vivo son solo para
 *    interaccion de usuario. Este cliente no los expone, a proposito.
 *  - Los ids son int64: todo JSON se parsea con parsearJsonSeguro.
 */

/** Error de Olo que conserva el status y el `num` del cuerpo (usar num para la logica). */
export class OloHttpError extends Error {
    public num: number | null;
    constructor(public status: number, public body: string) {
        super(`Olo respondio HTTP ${status}: ${body.substring(0, 300)}`);
        this.name = 'OloHttpError';
        let num: number | null = null;
        try {
            const n = JSON.parse(body)?.num;
            num = typeof n === 'number' ? n : null;
        } catch { /* cuerpo no JSON */ }
        this.num = num;
    }
}

const SHA256_VACIO = createHash('sha256').update('').digest('base64');

export interface PartesFirma {
    clientId: string;
    verbo: string;
    contentType: string;
    body: string;
    pathAndQuery: string;
    fecha: string;
}

/**
 * El mensaje que se firma: seis valores separados por LF (nunca CRLF).
 *   ClientId, HttpVerb, ContentType, Base64(SHA256(body)), PathAndQuery, Timestamp
 * Sin body, ContentType es cadena vacia y el hash es el de la cadena vacia.
 */
export function mensajeAFirmar(p: PartesFirma): string {
    const hash = p.body === '' ? SHA256_VACIO : createHash('sha256').update(p.body, 'utf8').digest('base64');
    const contentType = p.body === '' ? '' : p.contentType;
    return [p.clientId, p.verbo.toUpperCase(), contentType, hash, p.pathAndQuery, p.fecha].join('\n');
}

/** HMAC-SHA256 en base64 con el Client Secret como clave. */
export function firmar(secreto: string, mensaje: string): string {
    return createHmac('sha256', secreto).update(mensaje, 'utf8').digest('base64');
}

/**
 * PathAndQuery tal como se firma. URL ya codifica los espacios como %20 (en el
 * path y en la query), que es lo que pide Olo. Con firmarConVersion = false se
 * quita el prefijo de version de la base. [VALIDAR-CON-OLO]
 */
export function pathParaFirmar(url: URL, baseUrl: string, firmarConVersion: boolean): string {
    let path = url.pathname + url.search;
    if (!firmarConVersion) {
        const prefijo = new URL(baseUrl).pathname.replace(/\/$/, '');
        if (prefijo && path.startsWith(prefijo)) path = path.substring(prefijo.length) || '/';
    }
    return path.replace(/ /g, '%20');
}

/** Fecha RFC1123 GMT: "Mon, 16 Nov 2026 17:05:44 GMT". */
export function fechaRfc1123(d = new Date()): string {
    return d.toUTCString();
}

export function cabecerasFirmadas(
    cfg: ConfigOlo,
    verbo: string,
    url: URL,
    body = '',
    contentType = 'application/json',
    ahora = new Date()
): Record<string, string> {
    const fecha = fechaRfc1123(ahora);
    const firma = firmar(cfg.clientSecret, mensajeAFirmar({
        clientId: cfg.clientId,
        verbo,
        contentType,
        body,
        pathAndQuery: pathParaFirmar(url, cfg.baseUrl, cfg.firmarConVersion),
        fecha
    }));
    const h: Record<string, string> = {
        'Authorization': `OloSignature ${cfg.clientId}:${firma}`,
        'Date': fecha,
        'Accept': 'application/json',
        // [VALIDAR-CON-OLO] cuales headers son obligatorios en solo lectura.
        'User-Agent': cfg.userAgent
    };
    if (body !== '') h['Content-Type'] = contentType;
    return h;
}

export interface OchentaYSeis {
    /** pos_id agotados: String(products[].id) y String(choices[].id) + "__mod". */
    posIds: Set<string>;
    /** Cantidad de entradas que devolvio Olo (va a sync_runs.inventory_guids). */
    entradas: number;
    /** chain id -> pos_id, por si hay que cruzar entre tiendas. */
    porChainId: Map<string, string>;
}

/**
 * Convierte la respuesta de eightysixeditems en el conjunto de pos_id agotados.
 * Lanza si la forma no es la esperada: una respuesta rara NUNCA se interpreta
 * como "nada esta agotado".
 */
export function parsearOchentaYSeis(texto: string): OchentaYSeis {
    let raiz: any;
    try {
        raiz = parsearJsonSeguro(texto);
    } catch {
        throw new Error('eightysixeditems devolvio un JSON ilegible');
    }
    if (!raiz || typeof raiz !== 'object' || !Array.isArray(raiz.products) || !Array.isArray(raiz.choices)) {
        throw new Error('eightysixeditems no trae products[] y choices[]');
    }

    const posIds = new Set<string>();
    const porChainId = new Map<string, string>();

    for (const p of raiz.products) {
        const id = idComoTexto(p?.id);
        if (!id) throw new Error('eightysixeditems trae un producto sin id');
        posIds.add(id);
        const chain = idComoTexto(p?.chainproductid);
        if (chain) porChainId.set(`P:${chain}`, id);
    }
    for (const c of raiz.choices) {
        const id = idComoTexto(c?.id);
        if (!id) throw new Error('eightysixeditems trae una opcion sin id');
        posIds.add(`${id}__mod`);
        const chain = idComoTexto(c?.chainoptionid);
        if (chain) porChainId.set(`C:${chain}`, `${id}__mod`);
    }

    return { posIds, entradas: raiz.products.length + raiz.choices.length, porChainId };
}

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class OloApiService {

    constructor(
        private cfg: ConfigOlo,
        private fetchImpl: FetchFn = fetch,
        /** Inyectable para que los tests de reintento no esperen de verdad. */
        private dormir: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))
    ) {}

    public get vendorId(): string {
        return this.cfg.vendorId;
    }

    private url(pathAndQuery: string): URL {
        return new URL(pathAndQuery.replace(/^\//, ''), this.cfg.baseUrl);
    }

    /**
     * GET firmado. Reintenta ante 429 y 5xx con backoff exponencial (respeta
     * Retry-After si viene). Un 4xx que no es 429 no se reintenta: es un error
     * de permisos o de firma y repetirlo solo ensucia.
     *
     * Devuelve la Response cruda para que el llamador decida (el Vendor Export
     * responde 301 y hay que seguirlo a mano).
     */
    private async getCrudo(pathAndQuery: string): Promise<Response> {
        let intento = 0;
        for (;;) {
            const url = this.url(pathAndQuery);
            let respuesta: Response;
            try {
                respuesta = await this.fetchImpl(url, {
                    method: 'GET',
                    headers: cabecerasFirmadas(this.cfg, 'GET', url),
                    redirect: 'manual',
                    signal: AbortSignal.timeout(this.cfg.timeoutMs)
                });
            } catch (e: any) {
                if (intento >= this.cfg.maxReintentos) throw new Error(`Olo no respondio (${e.message})`);
                await this.dormir(this.espera(intento, null));
                intento++;
                continue;
            }

            const reintentable = respuesta.status === 429 || respuesta.status >= 500;
            if (!reintentable || intento >= this.cfg.maxReintentos) return respuesta;

            await respuesta.body?.cancel();
            await this.dormir(this.espera(intento, respuesta.headers.get('retry-after')));
            intento++;
        }
    }

    private espera(intento: number, retryAfter: string | null): number {
        const segundos = Number(retryAfter);
        if (Number.isFinite(segundos) && segundos > 0) return Math.min(segundos * 1000, 60_000);
        return Math.min(1000 * 2 ** intento, 30_000) + Math.floor(Math.random() * 250);
    }

    public async get(pathAndQuery: string): Promise<string> {
        const r = await this.getCrudo(pathAndQuery);
        const body = await r.text();
        if (!r.ok) throw new OloHttpError(r.status, body);
        return body;
    }

    // ---------- endpoints concretos ----------

    /** GET /vendorexport/status. changedsince opcional en yyyyMMdd. */
    public getVendorExportStatusRaw(changedsince?: string): Promise<string> {
        const q = changedsince ? `?changedsince=${encodeURIComponent(changedsince)}` : '';
        return this.get(`vendorexport/status${q}`);
    }

    /**
     * Descarga el Vendor Export de un vendor y devuelve el XML.
     *
     * Olo responde 301 con Location hacia una URL firmada que vive 10 minutos
     * y entrega un zip. La redireccion se sigue A MANO y SIN los headers de
     * Olo: fetch los reenviaria, y un almacenamiento con URL prefirmada rechaza
     * una peticion que trae ademas un Authorization propio.
     */
    public async descargarVendorExport(vendorId = this.cfg.vendorId): Promise<string> {
        const r = await this.getCrudo(`vendorexport/xml?vendorid=${encodeURIComponent(vendorId)}`);

        if (r.status !== 301 && r.status !== 302 && r.status !== 307) {
            const body = await r.text();
            if (!r.ok) throw new OloHttpError(r.status, body);
            throw new Error(`vendorexport/xml respondio ${r.status} sin redireccion`);
        }

        const destino = r.headers.get('location');
        await r.body?.cancel();
        if (!destino) throw new Error('vendorexport/xml respondio 301 sin header Location');

        const zip = await this.fetchImpl(new URL(destino, this.cfg.baseUrl), {
            signal: AbortSignal.timeout(Math.max(this.cfg.timeoutMs, 60_000))
        });
        if (!zip.ok) throw new OloHttpError(zip.status, await zip.text());

        return extraerXmlDelZip(new Uint8Array(await zip.arrayBuffer()));
    }

    /** Lista cruda de productos y opciones 86 del restaurante. Requiere permiso especial. */
    public getEightySixedRaw(vendorId = this.cfg.vendorId): Promise<string> {
        return this.get(`restaurants/${encodeURIComponent(vendorId)}/eightysixeditems`);
    }

    public async fetchOchentaYSeis(vendorId = this.cfg.vendorId): Promise<OchentaYSeis> {
        return parsearOchentaYSeis(await this.getEightySixedRaw(vendorId));
    }

    /** GET /restaurants/{id}: isavailable, iscurrentlyopen, timezone. */
    public getRestaurantRaw(vendorId = this.cfg.vendorId): Promise<string> {
        return this.get(`restaurants/${encodeURIComponent(vendorId)}`);
    }

    /** Prueba de firma: vendorexport/status es la llamada mas barata que exige Signature Authorization. */
    public async testAuthentication(): Promise<{ ok: boolean; message: string }> {
        try {
            await this.getVendorExportStatusRaw();
            return { ok: true, message: `Firma aceptada por Olo (${this.cfg.env}).` };
        } catch (e: any) {
            return { ok: false, message: e.message };
        }
    }
}

/** El zip del Vendor Export trae un XML. Si trae varios, se toma el primero .xml. */
export function extraerXmlDelZip(bytes: Uint8Array): string {
    let archivos: Record<string, Uint8Array>;
    try {
        archivos = unzipSync(bytes);
    } catch (e: any) {
        throw new Error(`El Vendor Export no es un zip valido: ${e.message}`);
    }
    const nombre = Object.keys(archivos).sort().find(n => n.toLowerCase().endsWith('.xml'));
    if (!nombre) throw new Error('El zip del Vendor Export no trae ningun .xml');
    return strFromU8(archivos[nombre]);
}
