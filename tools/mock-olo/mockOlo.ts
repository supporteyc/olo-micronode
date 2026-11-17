import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { firmar, mensajeAFirmar } from '../../src/services/oloApi.service';

/**
 * Mock de la Ordering API de Olo, solo lo que usa la integracion:
 *
 *   GET /v1.1/vendorexport/status
 *   GET /v1.1/vendorexport/xml?vendorid=   -> 301 a /__files/export.zip (zip con el XML SYNTHETIC)
 *   GET /v1.1/restaurants/{id}/eightysixeditems   (modos 200, 403, 429, 500)
 *   GET /v1.1/restaurants/{id}
 *
 * Verifica el header Authorization OloSignature completo (recalcula la firma
 * con el mismo secreto de prueba) y la ventana de +/- 5 minutos del Date. Asi
 * los tests prueban la firma de punta a punta, no solo el formato.
 *
 * Admin, para tests y para jugar a mano:
 *   POST /__admin/86     {"products":["9000..."],"choices":["9000..."]}
 *   POST /__admin/modo   {"modo86":"200"|"403"|"429"|"500"}
 *   GET  /__admin/llamadas
 */

export interface EstadoMock {
    modo86: '200' | '403' | '429' | '500' | 'invalido';
    productos86: Set<string>;
    opciones86: Set<string>;
    xml: string;
    llamadas: { metodo: string; path: string; status: number }[];
    tiendaDisponible: boolean;
}

export interface OpcionesMock {
    port?: number;
    clientId?: string;
    clientSecret?: string;
    vendorId?: string;
    xmlPath?: string;
    /** false para aceptar cualquier firma bien formada (depurar a mano). */
    verificarFirma?: boolean;
}

export interface MockOlo {
    url: string;
    baseUrl: string;
    estado: EstadoMock;
    detener(): void;
}

const XML_POR_DEFECTO = join(import.meta.dir, '..', '..', 'fixtures', 'vendor-export', 'synthetic.xml');

function json(status: number, cuerpo: unknown, extra: Record<string, string> = {}): Response {
    return new Response(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo), {
        status,
        headers: { 'Content-Type': 'application/json', ...extra }
    });
}

function errorOlo(status: number, num: number, message: string): Response {
    return json(status, { code: status, num, message });
}

/** Ids como texto crudo en el JSON, sin pasar por number: asi viaja un int64 real. */
function listaIds(ids: Iterable<string>, campoChain: string): string {
    return `[${[...ids].map(id => `{"id":${id},"${campoChain}":${id.replace(/^9/, '8')}}`).join(',')}]`;
}

export function crearMockOlo(o: OpcionesMock = {}): MockOlo {
    const clientId = o.clientId ?? 'mock-client-id';
    const clientSecret = o.clientSecret ?? 'mock-client-secret';
    const vendorId = o.vendorId ?? '10000000000000001';
    const verificar = o.verificarFirma ?? true;

    const estado: EstadoMock = {
        modo86: '200',
        productos86: new Set(),
        opciones86: new Set(),
        xml: readFileSync(o.xmlPath ?? XML_POR_DEFECTO, 'utf-8'),
        llamadas: [],
        tiendaDisponible: true
    };

    function autorizar(req: Request, url: URL): Response | null {
        const auth = req.headers.get('authorization') ?? '';
        const fecha = req.headers.get('date') ?? '';
        const m = /^OloSignature ([^:\s]+):([A-Za-z0-9+/=]+)$/.exec(auth);
        if (!m) return errorOlo(401, 100, 'Authorization debe ser "OloSignature {ClientId}:{firma}"');
        if (m[1] !== clientId) return errorOlo(401, 101, 'ClientId desconocido');

        const t = Date.parse(fecha);
        if (!Number.isFinite(t) || !/GMT$/.test(fecha)) return errorOlo(401, 102, 'Date debe ser RFC1123 GMT');
        if (Math.abs(Date.now() - t) > 5 * 60 * 1000) return errorOlo(401, 103, 'Date fuera de la ventana de 5 minutos');

        if (verificar) {
            const esperada = firmar(clientSecret, mensajeAFirmar({
                clientId, verbo: req.method, contentType: req.headers.get('content-type') ?? '',
                body: '', pathAndQuery: url.pathname + url.search, fecha
            }));
            if (esperada !== m[2]) return errorOlo(401, 104, 'Firma invalida');
        }
        return null;
    }

    const server = Bun.serve({
        port: o.port ?? 0,
        async fetch(req) {
            const url = new URL(req.url);
            const respuesta = await manejar(req, url);
            estado.llamadas.push({ metodo: req.method, path: url.pathname + url.search, status: respuesta.status });
            return respuesta;
        }
    });

    const base = `http://localhost:${server.port}`;

    async function manejar(req: Request, url: URL): Promise<Response> {
        const p = url.pathname;

        // ---------- admin ----------
        if (p === '/__admin/86' && req.method === 'POST') {
            const b = await req.json() as { products?: string[]; choices?: string[] };
            estado.productos86 = new Set((b.products ?? []).map(String));
            estado.opciones86 = new Set((b.choices ?? []).map(String));
            return json(200, { ok: true });
        }
        if (p === '/__admin/modo' && req.method === 'POST') {
            const b = await req.json() as { modo86?: EstadoMock['modo86'] };
            if (b.modo86) estado.modo86 = b.modo86;
            return json(200, { ok: true, modo86: estado.modo86 });
        }
        if (p === '/__admin/llamadas') return json(200, estado.llamadas);

        // URL "prefirmada" del zip: NO acepta Authorization, como un bucket real.
        if (p === '/__files/export.zip') {
            if (req.headers.get('authorization')) {
                return new Response('<Error>Only one auth mechanism allowed</Error>', { status: 400 });
            }
            const zip = zipSync({ 'vendorexport.xml': strToU8(estado.xml) });
            return new Response(zip, { headers: { 'Content-Type': 'application/zip' } });
        }

        // ---------- Ordering API ----------
        if (!p.startsWith('/v1.1/')) return errorOlo(404, 404, 'No encontrado');
        const rechazo = autorizar(req, url);
        if (rechazo) return rechazo;

        if (p === '/v1.1/vendorexport/status') {
            return json(200, `{"brands":[{"id":20000000000000001,"name":"Synthetic Brand","vendors":[{"id":${vendorId},"lastupdate":"${new Date().toISOString()}","lastexport":"${new Date().toISOString()}"}]}]}`);
        }

        if (p === '/v1.1/vendorexport/xml') {
            if (url.searchParams.get('vendorid') !== vendorId) return errorOlo(400, 300, 'vendorid desconocido');
            return new Response(null, { status: 301, headers: { Location: `${base}/__files/export.zip` } });
        }

        const m86 = /^\/v1\.1\/restaurants\/(\d+)\/eightysixeditems$/.exec(p);
        if (m86) {
            if (m86[1] !== vendorId) return errorOlo(400, 200, 'Restaurante desconocido');
            switch (estado.modo86) {
                case '403': return errorOlo(403, 403, 'El cliente no tiene permiso para eightysixeditems');
                case '429': return errorOlo(429, 429, 'Too many requests');
                case '500': return errorOlo(500, 500, 'Error interno');
                case 'invalido': return json(200, '{"products":"no es un array"}');
            }
            return json(200,
                `{"products":${listaIds(estado.productos86, 'chainproductid')},` +
                `"choices":${listaIds(estado.opciones86, 'chainoptionid')}}`);
        }

        const mr = /^\/v1\.1\/restaurants\/(\d+)$/.exec(p);
        if (mr) {
            return json(200, `{"id":${mr[1]},"name":"Synthetic Store","isavailable":${estado.tiendaDisponible},"iscurrentlyopen":true,"timezone":"America/New_York"}`);
        }

        return errorOlo(404, 404, 'No encontrado');
    }

    return {
        url: base,
        baseUrl: `${base}/v1.1/`,
        estado,
        detener: () => server.stop(true)
    };
}
