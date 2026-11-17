import type { ConfigHook, BrandHook, RutaTienda } from './config';
import type { Outbox, EntregaNueva, Pendiente } from './outbox';
import {
    CABECERAS, clavesDeRuteo, filtrarPorTienda, parsearCuerpo, verificarFirmaWebhook, EVENTOS_STOCK
} from '../services/oloWebhook.service';

/**
 * ec4olo-hook: receptor central y delgado de los webhooks de Olo.
 *
 * Solo hace esto, sin logica de negocio:
 *   1. lee el body crudo una vez;
 *   2. verifica X-Olo-Signature con el secreto del brand (401 si no cierra);
 *   3. deduplica por X-Olo-Message-Id;
 *   4. persiste en la outbox durable y RECIEN AHI responde 200;
 *   5. un worker entrega a cada tienda, en orden, con reintentos y backoff.
 */

export interface ResultadoEntrega {
    ok: boolean;
    status: number;
    /** false = no reintentar (el node dijo que el evento no tiene arreglo). */
    reintentable: boolean;
    error?: string;
}

/** Transporte receptor -> tienda, detras de una interfaz. */
export interface EventForwarder {
    entregar(ruta: RutaTienda, p: Pendiente): Promise<ResultadoEntrega>;
}

export class HttpForwarder implements EventForwarder {
    constructor(private timeoutMs: number, private fetchImpl: typeof fetch = fetch) {}

    async entregar(ruta: RutaTienda, p: Pendiente): Promise<ResultadoEntrega> {
        try {
            const r = await this.fetchImpl(`${ruta.baseUrl}/api/olo/events`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-EC4-Key': ruta.key,
                    'X-Olo-Event-Type': p.eventType,
                    'X-Olo-Message-Id': p.messageId,
                    'X-Olo-Timestamp': p.olotimestamp
                },
                body: p.body,
                signal: AbortSignal.timeout(this.timeoutMs)
            });
            const texto = await r.text();
            if (r.ok) return { ok: true, status: r.status, reintentable: false };
            // Solo 400 y 413 se descartan: el node dijo que ese cuerpo no tiene
            // arreglo. Todo lo demas se reintenta, 401 y 404 incluidos: una
            // llave mal puesta, una baseUrl que apunta a otro servidor o un
            // deploy a medias se arreglan sin perder eventos. (Un 404 descartaba
            // eventos en dev:mock cuando el puerto lo tenia otro servidor.)
            const reintentable = r.status !== 400 && r.status !== 413;
            return { ok: false, status: r.status, reintentable, error: `HTTP ${r.status}: ${texto.substring(0, 200)}` };
        } catch (e: any) {
            return { ok: false, status: 0, reintentable: true, error: e.message };
        }
    }
}

export interface Metricas {
    recibidos: Record<string, number>;
    duplicados: number;
    firmasInvalidas: number;
    sinRuta: number;
    entregas: { ok: number; fallos: number; descartes: number };
}

export interface Receptor {
    manejar(req: Request): Promise<Response>;
    /** Una pasada del worker. Devuelve cuantas entregas intento. */
    entregarPendientes(): Promise<number>;
    iniciarWorker(): void;
    detener(): void;
    metricas: Metricas;
}

export function crearReceptor(
    cfg: ConfigHook,
    outbox: Outbox,
    forwarder: EventForwarder,
    reloj: () => number = Date.now
): Receptor {
    const metricas: Metricas = {
        recibidos: {},
        duplicados: 0,
        firmasInvalidas: 0,
        sinRuta: 0,
        entregas: { ok: 0, fallos: 0, descartes: 0 }
    };
    let worker: ReturnType<typeof setInterval> | null = null;
    let enCurso: Promise<number> | null = null;
    let firmasInvalidasSeguidas = 0;

    function brandsCandidatos(path: string): BrandHook[] {
        const m = /^\/olo\/webhook\/([^/]+)\/?$/.exec(path);
        if (m) return cfg.brands.filter(b => b.key === decodeURIComponent(m[1]));
        return cfg.brands;
    }

    function backoff(intentos: number): number {
        return Math.min(1000 * 2 ** intentos, cfg.backoffMaxMs);
    }

    async function manejar(req: Request): Promise<Response> {
        const url = new URL(req.url);

        if (req.method === 'GET' && url.pathname === '/healthz') {
            return Response.json({ status: 'OK', brands: cfg.brands.length, rutas: cfg.rutas.size });
        }
        if (req.method === 'GET' && url.pathname === '/metrics') {
            return Response.json({ ...metricas, outbox: outbox.metricas(reloj()) });
        }
        if (req.method !== 'POST' || !/^\/olo\/webhook(\/[^/]+)?\/?$/.test(url.pathname)) {
            return new Response('Not found', { status: 404 });
        }

        const raw = await req.text();
        const tipo = req.headers.get(CABECERAS.tipo) ?? '';
        const messageId = req.headers.get(CABECERAS.messageId) ?? '';
        const timestamp = req.headers.get(CABECERAS.timestamp) ?? '';
        const firma = req.headers.get(CABECERAS.firma) ?? '';

        const brand = brandsCandidatos(url.pathname)
            .find(b => verificarFirmaWebhook(b.secret, b.url, raw, messageId, timestamp, firma));
        if (!brand) {
            metricas.firmasInvalidas++;
            firmasInvalidasSeguidas++;
            // Sin el body: puede traer PII de ordenes.
            const log = firmasInvalidasSeguidas >= 10 ? console.error : console.warn;
            log(`🔐 Firma invalida (${tipo || 'sin tipo'}, ${messageId || 'sin id'}). ` +
                (firmasInvalidasSeguidas >= 10
                    ? `${firmasInvalidasSeguidas} seguidas: ¿se roto el secreto o cambio la Destination URL?`
                    : ''));
            return new Response('Invalid signature', { status: 401 });
        }
        firmasInvalidasSeguidas = 0;
        metricas.recibidos[tipo] = (metricas.recibidos[tipo] ?? 0) + 1;

        if (tipo === 'Test') {
            outbox.registrar(messageId, tipo, timestamp, [], reloj());
            return Response.json({ ok: true });
        }

        // Desde aca siempre 200: el evento es de Olo y es legitimo. Un 4xx haria
        // que Olo lo reintente 50 veces o, peor, deshabilite la suscripcion.
        let cuerpo: any;
        try {
            cuerpo = parsearCuerpo(raw);
        } catch {
            console.warn(`Evento ${tipo} (${messageId}) con JSON ilegible: se confirma y se descarta`);
            outbox.registrar(messageId, tipo, timestamp, [], reloj());
            return Response.json({ ok: true, descartado: true });
        }

        const entregas: EntregaNueva[] = [];
        for (const clave of clavesDeRuteo(tipo, cuerpo)) {
            const ruta = cfg.rutas.get(clave);
            if (!ruta) {
                metricas.sinRuta++;
                console.warn(`Evento ${tipo} para el restaurante ${clave} sin ruta configurada (OLO_HOOK_ROUTES)`);
                continue;
            }
            // MenuItemAvailabilityChanged puede mezclar tiendas: cada una recibe
            // solo lo suyo. El resto viaja con el body original intacto.
            const body = EVENTOS_STOCK.has(tipo) && Array.isArray(cuerpo)
                ? JSON.stringify(filtrarPorTienda(cuerpo, clave))
                : raw;
            entregas.push({ storeId: ruta.storeId, routingKey: clave, eventType: tipo, body });
        }

        let nuevo: boolean;
        try {
            nuevo = outbox.registrar(messageId, tipo, timestamp, entregas, reloj());
        } catch (e: any) {
            // Sin outbox no se puede prometer la entrega: 500 y que Olo reintente.
            console.error(`❌ No se pudo persistir el evento ${messageId} en la outbox: ${e.message}`);
            return new Response('Outbox unavailable', { status: 500 });
        }
        if (!nuevo) {
            metricas.duplicados++;
            return Response.json({ ok: true, duplicado: true });
        }

        // La entrega va fuera del camino del ack.
        if (entregas.length > 0) queueMicrotask(() => { void entregarPendientes(); });
        return Response.json({ ok: true });
    }

    /**
     * Una sola pasada a la vez (dos pasadas en paralelo entregarian dos veces
     * la misma cabeza). Quien llega con una pasada en vuelo la espera y despues
     * hace la suya: si solo volviera, lo que se encolo mientras tanto quedaria
     * esperando al proximo tick del worker.
     */
    async function entregarPendientes(): Promise<number> {
        while (enCurso) await enCurso;
        enCurso = pasada().finally(() => { enCurso = null; });
        return enCurso;
    }

    async function pasada(): Promise<number> {
        let total = 0;
        for (;;) {
            const lote = outbox.siguientes(reloj());
            if (lote.length === 0) return total;
            // Tiendas en paralelo; dentro de cada tienda, de a uno y en orden.
            await Promise.all(lote.map(async p => {
                const ruta = cfg.rutas.get(p.routingKey);
                if (!ruta) {
                    outbox.descartar(p.id, 'ruta eliminada de la configuracion', reloj());
                    metricas.entregas.descartes++;
                    return;
                }
                const r = await forwarder.entregar(ruta, p);
                if (r.ok) {
                    outbox.marcarEntregado(p.id, reloj());
                    metricas.entregas.ok++;
                } else if (!r.reintentable) {
                    outbox.descartar(p.id, r.error ?? `HTTP ${r.status}`, reloj());
                    metricas.entregas.descartes++;
                    console.error(`❌ ${p.eventType} ${p.messageId} descartado por ${ruta.storeId}: ${r.error}`);
                } else {
                    outbox.marcarFallo(p.id, r.error ?? 'error', reloj() + backoff(p.attempts));
                    metricas.entregas.fallos++;
                    const intentos = p.attempts + 1;
                    const log = intentos === cfg.alertarTrasIntentos ? console.error : console.warn;
                    log(`⚠️ Entrega a ${ruta.storeId} fallo (intento ${intentos}): ${r.error}`);
                }
            }));
            total += lote.length;
            // Si todo lo que habia fallo, se sale: el backoff decide cuando volver.
            if (outbox.siguientes(reloj()).every(p => lote.some(l => l.id === p.id))) return total;
        }
    }

    return {
        manejar,
        entregarPendientes,
        metricas,
        iniciarWorker() {
            if (worker) return;
            worker = setInterval(() => { void entregarPendientes(); }, cfg.workerIntervalMs);
        },
        detener() {
            if (worker) clearInterval(worker);
            worker = null;
        }
    };
}
