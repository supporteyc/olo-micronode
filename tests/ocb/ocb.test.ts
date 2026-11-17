import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { armarTienda, nuevoMessageId, VENDOR, type Tienda } from '../helpers';

/**
 * OCB: un test por regla de la seccion 8.3, con el reloj de la tienda fijo en
 * 2026-11-17 10:00 de Nueva York (15:00 UTC).
 */

const FIXTURES = join(import.meta.dir, '..', '..', 'fixtures', 'webhooks');
const base = (tipo: string) => readFileSync(join(FIXTURES, `${tipo}.json`), 'utf-8').trim();

const ORIGINAL = '6f1c2d3e-0000-4000-8000-000000000001';
const MIN = 60_000;

let t: Tienda;
afterEach(async () => { await t?.detener(); });

/** Fixture con campos pisados. Se edita el texto, sin JSON.parse, para no tocar los ids. */
function orden(tipo: string, cambios: Record<string, string> = {}): string {
    let s = base(tipo);
    for (const [campo, valor] of Object.entries(cambios)) {
        const re = new RegExp(`"${campo}":("[^"]*"|-?[\\d.]+|true|false|null|\\{[^}]*\\})`);
        s = re.test(s) ? s.replace(re, `"${campo}":${valor}`) : s.replace(/^\{/, `{"${campo}":${valor},`);
    }
    return s;
}

const guid = (n: number) => `6f1c2d3e-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function board() {
    return t.get('/api/toast/ocb');
}

async function enviar(tipo: string, cambios: Record<string, string> = {}, messageId?: string) {
    const r = await t.evento(tipo, orden(tipo, cambios), messageId);
    expect(r.status).toBe(200);
    return r.body;
}

describe('OCB: ciclo de vida', () => {

    test('ciclo normal: placed -> closed (READY) -> picked up -> se retira tras X minutos', async () => {
        t = await armarTienda({ OCB_PICKED_UP_HIDE_AFTER_MIN: '2' });

        await enviar('OrderPlaced');
        let b = await board();
        expect(b.orders).toHaveLength(1);
        expect(b.orders[0].status).toBe('IN_PREPARATION');
        expect(b.inPreparationCount).toBe(1);

        t.reloj.avanzar(15 * MIN);
        await enviar('OrderClosed');
        b = await board();
        expect(b.orders[0].status).toBe('READY');
        expect(b.orders[0].items[0].fulfillmentStatus).toBe('READY');

        // timePickedUp 10:18 (fixture): se ve hasta las 10:20.
        t.reloj.avanzar(3 * MIN); // 10:18
        await enviar('OrderPickedUp');
        expect((await board()).orders[0].status).toBe('READY');

        t.reloj.avanzar(1 * MIN); // 10:19
        expect((await board()).orders).toHaveLength(1);
        t.reloj.avanzar(1 * MIN); // 10:20
        expect((await board()).orders).toHaveLength(0);
        expect((await t.almacen.leerEstadoOcb(ORIGINAL))!.state).toBe('PICKED_UP');
    });

    test('mapeo: numero visible, horas en UTC, total, items y modificadores anidados', async () => {
        t = await armarTienda();
        await enviar('OrderPlaced');
        const o = (await board()).orders[0];
        expect(o.orderGuid).toBe(ORIGINAL);
        expect(o.displayNumber).toBe('1042');
        expect(o.openedDate).toBe('2026-11-17T15:00:00.000Z');
        expect(o.estimatedFulfillmentDate).toBe('2026-11-17T15:15:00.000Z');
        expect(o.totalAmount).toBe(26.5);
        expect(o.paymentStatus).toBe('PAID');
        expect(o.items).toEqual([{
            name: 'Classic Burger', quantity: 2, price: 12.5, fulfillmentStatus: 'SENT',
            modifiers: ['Fries', 'Large Fries']
        }]);
        // Sin PII en la base.
        expect(JSON.stringify([...t.almacen.interno.ordenesOcb.values()])).not.toContain('Cliente');
        expect(JSON.stringify([...t.almacen.interno.estadosOcb.values()])).not.toContain('example.test');
    });

    test('sin posRef cae a los ultimos 4 digitos de orderIdString; pago en tienda = OPEN', async () => {
        t = await armarTienda();
        await enviar('OrderPlaced', { posRef: 'null', payments: '[{"type":"instore"}]' });
        const o = (await board()).orders[0];
        expect(o.displayNumber).toBe('0101');
    });

    test('OCB_PLACED_STATUS=RECEIVED muestra la orden como recibida', async () => {
        t = await armarTienda({ OCB_PLACED_STATUS: 'RECEIVED' });
        await enviar('OrderPlaced');
        const b = await board();
        expect(b.orders[0].status).toBe('RECEIVED');
        expect(b.receivedCount).toBe(1);
    });
});

describe('OCB: retiros', () => {

    test('cancelada: se borra de inmediato', async () => {
        t = await armarTienda();
        await enviar('OrderPlaced');
        t.reloj.avanzar(5 * MIN);
        await enviar('OrderCancelled');
        expect((await board()).orders).toHaveLength(0);
        expect((await t.almacen.leerEstadoOcb(ORIGINAL))!.state).toBe('CANCELLED');
    });

    test('cancelada con OCB_EXTENDED_STATUS: CANCELLED hasta timeCancelled + X min', async () => {
        t = await armarTienda({ OCB_EXTENDED_STATUS: 'true', OCB_CANCELLED_HIDE_AFTER_MIN: '1' });
        await enviar('OrderPlaced');
        t.reloj.avanzar(5 * MIN); // 10:05 = timeCancelled del fixture
        await enviar('OrderCancelled');
        expect((await board()).orders[0].status).toBe('CANCELLED');
        t.reloj.avanzar(1 * MIN);
        expect((await board()).orders).toHaveLength(0);
    });

    test('TTL: una orden que nunca recibe otro evento se retira a los OCB_MAX_TTL_MIN', async () => {
        t = await armarTienda({ OCB_MAX_TTL_MIN: '120' });
        await enviar('OrderPlaced');
        t.reloj.avanzar(119 * MIN);
        expect((await board()).orders).toHaveLength(1);
        t.reloj.avanzar(1 * MIN);
        expect((await board()).orders).toHaveLength(0);
        expect((await t.almacen.leerEstadoOcb(ORIGINAL))!.state).toBe('EXPIRED');
    });

    test('tienda sin Expo: OCB_HIDE_ON_CLOSED_AFTER_MIN retira desde OrderClosed', async () => {
        t = await armarTienda({ OCB_HIDE_ON_CLOSED_AFTER_MIN: '5' });
        await enviar('OrderPlaced');
        t.reloj.avanzar(15 * MIN); // 10:15 = timeReady
        await enviar('OrderClosed');
        expect((await board()).orders[0].status).toBe('READY');
        t.reloj.avanzar(5 * MIN);
        expect((await board()).orders).toHaveLength(0);
    });

    test('terminal tardio: un OrderPickedUp cuyo hide_at ya paso nunca aparece', async () => {
        t = await armarTienda({ OCB_PICKED_UP_HIDE_AFTER_MIN: '2' });
        t.reloj.avanzar(40 * MIN); // 10:40; timePickedUp fue 10:18
        await enviar('OrderPickedUp', {}, nuevoMessageId());
        expect((await board()).orders).toHaveLength(0);
        expect(t.almacen.interno.ordenesOcb.size).toBe(0);
    });

    test('deliveryMethod que no se retira en el mostrador no se muestra', async () => {
        t = await armarTienda();
        await enviar('OrderPlaced', { deliveryMethod: '"dispatch"' });
        expect((await board()).orders).toHaveLength(0);
        // Y un evento posterior de la misma orden tampoco la muestra.
        await enviar('OrderClosed', { deliveryMethod: '"dispatch"' });
        expect((await board()).orders).toHaveLength(0);
    });
});

describe('OCB: orden de llegada, duplicados y reemplazos', () => {

    test('el estado nunca baja: OrderPickedUp antes de OrderPlaced crea la fila y el Placed tardio no la reabre', async () => {
        t = await armarTienda({ OCB_PICKED_UP_HIDE_AFTER_MIN: '2' });
        t.reloj.avanzar(18 * MIN); // 10:18
        await enviar('OrderPickedUp');
        expect((await board()).orders[0].status).toBe('READY');

        await enviar('OrderPlaced');
        expect((await board()).orders[0].status).toBe('READY');
        expect((await t.almacen.leerEstadoOcb(ORIGINAL))!.state).toBe('PICKED_UP');
    });

    test('OrderClosed y despues un OrderPlaced reintentado: sigue READY', async () => {
        t = await armarTienda();
        await enviar('OrderClosed');
        await enviar('OrderPlaced');
        expect((await board()).orders[0].status).toBe('READY');
    });

    test('duplicados: el mismo message id no tiene efecto', async () => {
        t = await armarTienda();
        const id = nuevoMessageId();
        await enviar('OrderPlaced', {}, id);
        const r = await enviar('OrderCancelled', {}, id); // mismo id, otro contenido
        expect(r.duplicado).toBe(true);
        expect((await board()).orders).toHaveLength(1);
    });

    test('reemplazo despues del original: la original sale y queda la nueva', async () => {
        t = await armarTienda();
        await enviar('OrderPlaced');
        await enviar('OrderPlaced', {
            id: `"${guid(2)}"`, orderId: '30000000000000102', orderIdString: '"30000000000000102"', posRef: '"1043"',
            isReplacement: 'true', replacementDetails: `{"originalId":"${ORIGINAL}"}`
        });
        const b = await board();
        expect(b.orders.map((o: any) => o.orderGuid)).toEqual([guid(2)]);
        expect((await t.almacen.leerEstadoOcb(ORIGINAL))!.state).toBe('REPLACED');
        expect((await t.almacen.leerEstadoOcb(guid(2)))!.replaces_guid).toBe(ORIGINAL);
    });

    test('reemplazo antes del original: la lapida impide que el original reviva', async () => {
        t = await armarTienda();
        await enviar('OrderPlaced', {
            id: `"${guid(2)}"`, orderId: '30000000000000102', orderIdString: '"30000000000000102"',
            isReplacement: 'true', replacementDetails: `{"originalId":"${ORIGINAL}"}`
        });
        await enviar('OrderPlaced'); // el original, tarde
        await enviar('OrderClosed'); // y un evento mas del original
        const b = await board();
        expect(b.orders.map((o: any) => o.orderGuid)).toEqual([guid(2)]);
    });

    test('reemplazo por orderId numerico: la lapida se encuentra por orderIdString', async () => {
        t = await armarTienda();
        await enviar('OrderPlaced', {
            id: `"${guid(2)}"`, orderId: '30000000000000102', orderIdString: '"30000000000000102"',
            isReplacement: 'true', replacementDetails: '{"originalId":30000000000000101}'
        });
        await enviar('OrderPlaced');
        expect((await board()).orders.map((o: any) => o.orderGuid)).toEqual([guid(2)]);
    });
});

describe('OCB: ordenes programadas', () => {

    const programada = { timePlaced: '"20261116 22:00"', timeWanted: '"20261117 13:00"', timeReady: '"20261117 13:00"' };

    test('con ScheduledOrderFired: no se ve hasta que se dispara, y usa el dia de timeWanted', async () => {
        t = await armarTienda();
        await enviar('OrderPlaced', programada);
        expect((await board()).orders).toHaveLength(0);
        expect((await t.almacen.leerEstadoOcb(ORIGINAL))!.state).toBe('SCHEDULED');

        t.reloj.avanzar(2 * 60 * MIN); // 12:00
        await enviar('ScheduledOrderFired', programada);
        const b = await board(); // board de hoy (20261117)
        expect(b.orders).toHaveLength(1);
        expect(b.orders[0].status).toBe('IN_PREPARATION');
    });

    test('sin ScheduledOrderFired: el barrido la promueve OCB_ADVANCE_THRESHOLD_MIN antes de timeWanted', async () => {
        t = await armarTienda({ OCB_ADVANCE_THRESHOLD_MIN: '45' });
        await enviar('OrderPlaced', programada);

        t.reloj.avanzar(2 * 60 * MIN + 14 * MIN); // 12:14
        expect((await board()).orders).toHaveLength(0);
        t.reloj.avanzar(1 * MIN); // 12:15 = 13:00 - 45 min
        const b = await board();
        expect(b.orders).toHaveLength(1);
        expect(b.orders[0].status).toBe('IN_PREPARATION');
        expect(b.orders[0].items[0].modifiers).toEqual(['Fries', 'Large Fries']);
        expect((await t.almacen.leerEstadoOcb(ORIGINAL))!.state).toBe('PLACED');
    });

    test('ScheduledOrderFailed solo se registra', async () => {
        t = await armarTienda();
        await enviar('OrderPlaced', programada);
        await enviar('ScheduledOrderFailed', programada);
        expect((await t.almacen.leerEstadoOcb(ORIGINAL))!.state).toBe('SCHEDULED');
    });
});

describe('OCB: contrato del GET', () => {

    test('GET /api/toast/ocb devuelve exactamente la forma RespuestaOcb de ec4toast-node', async () => {
        t = await armarTienda();
        await enviar('OrderPlaced', { posRef: '"2"' });
        await enviar('OrderPlaced', { id: `"${guid(3)}"`, orderIdString: '"30000000000000103"', posRef: '"1"' });
        const b = await board();
        expect(Object.keys(b)).toEqual([
            'restaurantGuid', 'generatedAt', 'totalOrders', 'receivedCount', 'inPreparationCount', 'readyCount', 'orders'
        ]);
        expect(Object.keys(b.orders[0])).toEqual([
            'orderGuid', 'displayNumber', 'status', 'openedDate', 'estimatedFulfillmentDate', 'totalAmount', 'paymentStatus', 'items'
        ]);
        expect(Object.keys(b.orders[0].items[0])).toEqual(['name', 'quantity', 'price', 'fulfillmentStatus', 'modifiers']);
        expect(b.restaurantGuid).toBe(VENDOR);
        expect(b.totalOrders).toBe(2);
        expect(b.orders.map((o: any) => o.displayNumber)).toEqual(['1', '2']); // por display_number
    });

    test('businessDate invalido: 400; otro dia: board vacio', async () => {
        t = await armarTienda();
        await enviar('OrderPlaced');
        const r = await fetch(`${t.url}/api/toast/ocb?businessDate=2026-11-17`);
        expect(r.status).toBe(400);
        expect((await t.get('/api/toast/ocb?businessDate=20261116')).orders).toHaveLength(0);
        expect((await t.get('/api/toast/ocb?businessDate=20261117')).orders).toHaveLength(1);
    });
});
