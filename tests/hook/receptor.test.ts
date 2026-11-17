import { afterEach, describe, expect, test } from 'bun:test';
import { leerConfigHook } from '../../src/hook/config';
import { OutboxSqlite } from '../../src/hook/outbox';
import { crearReceptor, type EventForwarder, type ResultadoEntrega } from '../../src/hook/receptor';
import type { Pendiente } from '../../src/hook/outbox';
import type { RutaTienda } from '../../src/hook/config';
import { firmarWebhook } from '../../src/services/oloWebhook.service';

const SECRETO = 'secreto-de-prueba-no-real';
const URL_DESTINO = 'https://hook.example.test/olo/webhook';
const TIENDA_A = '10000000000000001';
const TIENDA_B = '10000000000000002';

class ForwarderFalso implements EventForwarder {
    entregas: { storeId: string; p: Pendiente }[] = [];
    respuestas: ResultadoEntrega[] = [];
    async entregar(ruta: RutaTienda, p: Pendiente): Promise<ResultadoEntrega> {
        this.entregas.push({ storeId: ruta.storeId, p });
        return this.respuestas.shift() ?? { ok: true, status: 200, reintentable: false };
    }
}

function armar(env: Record<string, string> = {}) {
    const cfg = leerConfigHook({
        OLO_WEBHOOK_SECRET: SECRETO,
        OLO_WEBHOOK_URL: URL_DESTINO,
        OLO_HOOK_ROUTES: JSON.stringify({
            [TIENDA_A]: { storeId: 'tienda-a', baseUrl: 'http://a.test', key: 'k-a' },
            [TIENDA_B]: { storeId: 'tienda-b', baseUrl: 'http://b.test', key: 'k-b' }
        }),
        ...env
    });
    const outbox = new OutboxSqlite(':memory:');
    const forwarder = new ForwarderFalso();
    let ahora = 1_000_000;
    const receptor = crearReceptor(cfg, outbox, forwarder, () => ahora);
    return { cfg, outbox, forwarder, receptor, avanzar: (ms: number) => { ahora += ms; } };
}

let n = 0;
function peticion(tipo: string, body: string, o: { secreto?: string; id?: string; path?: string } = {}) {
    const id = o.id ?? `msg-${++n}`;
    const ts = '638670000000000000';
    return new Request(`http://localhost${o.path ?? '/olo/webhook'}`, {
        method: 'POST',
        headers: {
            'X-Olo-Event-Type': tipo,
            'X-Olo-Message-Id': id,
            'X-Olo-Timestamp': ts,
            'X-Olo-Signature': firmarWebhook(o.secreto ?? SECRETO, URL_DESTINO, body, id, ts)
        },
        body
    });
}

const orden = (vendor: string) => `{"id":"0f0e0d0c-0000-4000-8000-000000000001","orderId":12345,"vendorId":${vendor},"vendorIdString":"${vendor}"}`;

let silenciar: () => void;
afterEach(() => silenciar?.());

function silencio() {
    const w = console.warn, e = console.error;
    console.warn = () => {};
    console.error = () => {};
    silenciar = () => { console.warn = w; console.error = e; };
}

describe('receptor de webhooks', () => {

    test('firma valida: 200; firma invalida: 401 y no se persiste', async () => {
        silencio();
        const { receptor, outbox } = armar();
        expect((await receptor.manejar(peticion('OrderPlaced', orden(TIENDA_A)))).status).toBe(200);
        expect((await receptor.manejar(peticion('OrderPlaced', orden(TIENDA_A), { secreto: 'otro' }))).status).toBe(401);
        expect(receptor.metricas.firmasInvalidas).toBe(1);
        const m = outbox.metricas(0);
        expect(m.pendientes + m.entregados).toBe(1);
    });

    test('el evento Test responde 200 si la firma es valida', async () => {
        const { receptor, forwarder } = armar();
        const r = await receptor.manejar(peticion('Test', '{"message":"Olo webhook test!"}'));
        expect(r.status).toBe(200);
        await receptor.entregarPendientes();
        expect(forwarder.entregas).toHaveLength(0);
    });

    test('ack rapido: p99 < 200 ms y el evento ya esta en la outbox cuando se responde', async () => {
        const { receptor, outbox, forwarder } = armar();
        // Un node lento: si la entrega estuviera en el camino del ack, se notaria.
        forwarder.entregar = async (ruta, p) => {
            await new Promise(r => setTimeout(r, 500));
            forwarder.entregas.push({ storeId: ruta.storeId, p });
            return { ok: true, status: 200, reintentable: false };
        };
        const tiempos: number[] = [];
        for (let i = 0; i < 200; i++) {
            const t0 = performance.now();
            const r = await receptor.manejar(peticion('OrderPlaced', orden(TIENDA_A)));
            tiempos.push(performance.now() - t0);
            expect(r.status).toBe(200);
            const m = outbox.metricas(0);
            expect(m.pendientes + m.entregados).toBe(i + 1);
        }
        tiempos.sort((a, b) => a - b);
        expect(tiempos[Math.floor(tiempos.length * 0.99)]).toBeLessThan(200);
    });

    test('duplicados por X-Olo-Message-Id: 200 sin reenviar', async () => {
        const { receptor, forwarder } = armar();
        await receptor.manejar(peticion('OrderPlaced', orden(TIENDA_A), { id: 'dup-1' }));
        const r = await receptor.manejar(peticion('OrderPlaced', orden(TIENDA_A), { id: 'dup-1' }));
        expect(r.status).toBe(200);
        expect(((await r.json()) as any).duplicado).toBe(true);
        await receptor.entregarPendientes();
        expect(forwarder.entregas).toHaveLength(1);
        expect(receptor.metricas.duplicados).toBe(1);
    });

    test('ruteo por vendorIdString y por locationId; un mass 86 mezclado se parte por tienda', async () => {
        const { receptor, forwarder } = armar();
        await receptor.manejar(peticion('OrderPlaced', orden(TIENDA_B)));
        const mezcla = `[{"locationId":${TIENDA_A},"itemEntityType":"Product","itemEntityId":90000000000000011,"isAvailable":false},` +
            `{"locationId":${TIENDA_B},"itemEntityType":"Product","itemEntityId":90000000000000012,"isAvailable":false}]`;
        await receptor.manejar(peticion('MenuItemAvailabilityChanged', mezcla));
        await receptor.entregarPendientes();

        const porTienda = forwarder.entregas.map(e => [e.storeId, e.p.eventType]);
        expect(porTienda).toContainEqual(['tienda-b', 'OrderPlaced']);
        const aA = forwarder.entregas.find(e => e.storeId === 'tienda-a')!;
        expect(aA.p.body).toContain('"90000000000000011"');
        expect(aA.p.body).not.toContain('90000000000000012');
        // El body de una orden viaja intacto (ids sin redondear).
        const ob = forwarder.entregas.find(e => e.p.eventType === 'OrderPlaced')!;
        expect(ob.p.body).toBe(orden(TIENDA_B));
    });

    test('evento sin ruta: 200, advertencia y metrica', async () => {
        silencio();
        const { receptor, forwarder } = armar();
        const r = await receptor.manejar(peticion('OrderPlaced', orden('19999999999999999')));
        expect(r.status).toBe(200);
        expect(receptor.metricas.sinRuta).toBe(1);
        await receptor.entregarPendientes();
        expect(forwarder.entregas).toHaveLength(0);
    });

    test('node caido: reintenta con backoff, mantiene el orden por tienda y no pierde eventos', async () => {
        silencio();
        const { receptor, forwarder, outbox, avanzar } = armar();
        forwarder.respuestas = [
            { ok: false, status: 0, reintentable: true, error: 'ECONNREFUSED' },
            { ok: false, status: 503, reintentable: true, error: 'HTTP 503' }
        ];
        await receptor.manejar(peticion('OrderPlaced', orden(TIENDA_A), { id: 'primero' }));
        await receptor.manejar(peticion('OrderClosed', orden(TIENDA_A), { id: 'segundo' }));

        await receptor.entregarPendientes();
        expect(forwarder.entregas.map(e => e.p.messageId)).toEqual(['primero']);

        // Antes del backoff no se intenta, y el segundo NO se adelanta al primero.
        await receptor.entregarPendientes();
        expect(forwarder.entregas.map(e => e.p.messageId)).toEqual(['primero']);

        avanzar(1_000);
        await receptor.entregarPendientes();
        avanzar(2_000);
        await receptor.entregarPendientes();
        expect(forwarder.entregas.map(e => e.p.messageId)).toEqual(['primero', 'primero', 'primero', 'segundo']);
        expect(outbox.metricas(0).pendientes).toBe(0);
    });

    test('un 404 del node se reintenta: puede ser una baseUrl que apunta a otro servidor', async () => {
        silencio();
        const { receptor, forwarder, outbox, avanzar } = armar();
        forwarder.entregar = async (ruta, p) => {
            forwarder.entregas.push({ storeId: ruta.storeId, p });
            return forwarder.entregas.length === 1
                ? { ok: false, status: 404, reintentable: true, error: 'HTTP 404' }
                : { ok: true, status: 200, reintentable: false };
        };
        await receptor.manejar(peticion('OrderPlaced', orden(TIENDA_A)));
        await receptor.entregarPendientes();
        avanzar(1_000);
        await receptor.entregarPendientes();
        expect(forwarder.entregas).toHaveLength(2);
        expect(outbox.metricas(0).descartados).toBe(0);
    });

    test('un 400 del node se descarta (reintentar no lo arregla) y no bloquea la cola', async () => {
        silencio();
        const { receptor, forwarder, outbox } = armar();
        forwarder.respuestas = [{ ok: false, status: 400, reintentable: false, error: 'HTTP 400' }];
        await receptor.manejar(peticion('OrderPlaced', orden(TIENDA_A), { id: 'malo' }));
        await receptor.manejar(peticion('OrderPlaced', orden(TIENDA_A), { id: 'bueno' }));
        await receptor.entregarPendientes();
        expect(forwarder.entregas.map(e => e.p.messageId)).toEqual(['malo', 'bueno']);
        expect(outbox.metricas(0).descartados).toBe(1);
    });

    test('varios brands: cada path verifica con su propio secreto', async () => {
        silencio();
        const { receptor } = armar({
            OLO_WEBHOOK_SECRET: '', OLO_WEBHOOK_URL: '',
            OLO_HOOK_BRANDS: JSON.stringify([
                { key: 'a', secret: SECRETO, url: URL_DESTINO },
                { key: 'b', secret: 'otro-secreto', url: 'https://hook.example.test/olo/webhook/b' }
            ])
        });
        expect((await receptor.manejar(peticion('OrderPlaced', orden(TIENDA_A), { path: '/olo/webhook/a' }))).status).toBe(200);
        // La firma del brand a no vale en el path del brand b.
        expect((await receptor.manejar(peticion('OrderPlaced', orden(TIENDA_A), { path: '/olo/webhook/b' }))).status).toBe(401);
    });

    test('/healthz y /metrics', async () => {
        const { receptor } = armar();
        await receptor.manejar(peticion('OrderPlaced', orden(TIENDA_A)));
        expect((await receptor.manejar(new Request('http://localhost/healthz'))).status).toBe(200);
        const m: any = await (await receptor.manejar(new Request("http://localhost/metrics"))).json();
        expect(m.recibidos.OrderPlaced).toBe(1);
        expect(m.outbox.pendientes + m.outbox.entregados).toBe(1);
        expect('edadMasViejoMs' in m.outbox).toBe(true);
    });
});
