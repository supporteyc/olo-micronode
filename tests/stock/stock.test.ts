import { afterEach, describe, expect, test } from 'bun:test';
import {
    armarTienda, arrayDeltas, delta, idsSecuenciales, nuevoMessageId, xmlConProductos,
    O1, O2, OTRA_TIENDA, P1, P2, P3, P4, type Tienda
} from '../helpers';

/**
 * Criterios de aceptacion de stock (seccion 11.1 del prompt). Un test por
 * criterio, con el numero en el nombre. Corren sobre el almacen en memoria
 * (misma semantica que MySQL) y el mock de Olo por HTTP, con firma real.
 */

const ICONO = 'https://cdn.example.test/sold-out.png';
let t: Tienda;

afterEach(async () => {
    await t?.detener();
});

async function item(posId: string) {
    return (await t.almacen.findAllIndexed()).get(posId);
}

function historialDe(posId: string) {
    return t.almacen.interno.historial.filter(h => h.pos_id === posId);
}

function stockDe(posId: string) {
    return historialDe(posId).filter(h => h.field === 'in_stock');
}

async function ultimoRun() {
    await t.s.menuSync.esperarCierres();
    return t.almacen.ultimoRun();
}

describe('stock: linea base e importacion', () => {

    test('1. linea base 86: tras importar, eightysixeditems decide el stock', async () => {
        t = await armarTienda();
        t.marcar86([P2], [O1]);

        const r = await t.s.menuSync.importar('scheduler');
        expect(r.success).toBe(true);

        expect((await item(P1))!.in_stock).toBe(true);
        expect((await item(P2))!.in_stock).toBe(false);
        expect((await item(`${O1}__mod`))!.in_stock).toBe(false);

        expect(stockDe(P2).map(h => [h.change_type, h.old_value, h.new_value])).toEqual([['updated', 'Yes', 'No']]);
        expect(stockDe(`${O1}__mod`).map(h => [h.change_type, h.old_value, h.new_value])).toEqual([['updated', 'Yes', 'No']]);
        expect(stockDe(P1)).toHaveLength(0);

        const run = await ultimoRun();
        expect(run!.inventory_guids).toBe(2);
        expect(run!.sold_out_items).toBe(2);
        expect(run!.status).toBe('ok');

        const exportado = await t.get(`/api/toast/menu-export?soldOutIconUrl=${encodeURIComponent(ICONO)}`);
        const p2 = exportado.find((f: any) => f.pos_id === P2);
        const p1 = exportado.find((f: any) => f.pos_id === P1);
        expect(p2.in_stock).toBe('No');
        expect(p2.sold_out_icon).toBe(ICONO);
        expect(p1.in_stock).toBe('Yes');
        expect(p1.sold_out_icon).toBe('');
    });

    test('2. el export no decide stock: isdisabled en P1 no cambia in_stock', async () => {
        t = await armarTienda();
        await t.s.menuSync.importar('scheduler');
        // P1 trae isdisabled="true" en el fixture y no esta en eightysixeditems.
        expect(t.mock.estado.xml).toContain(`id="${P1}"`);
        expect(t.mock.estado.xml).toMatch(/isdisabled="true"/);
        expect((await item(P1))!.in_stock).toBe(true);

        // Solo eightysixeditems lo cambia.
        t.marcar86([P1]);
        await t.s.menuSync.reconciliar('manual');
        expect((await item(P1))!.in_stock).toBe(false);
    });

    test('10. linea base caida (403, 429, 500): no cambia ningun in_stock y el semaforo queda en warn', async () => {
        t = await armarTienda();
        t.marcar86([P2]);
        await t.s.menuSync.importar('scheduler');
        const antes = [...(await t.almacen.findAllIndexed()).values()].map(i => [i.pos_id, i.in_stock]);

        for (const modo of ['403', '429', '500'] as const) {
            t.mock.estado.modo86 = modo;
            t.marcar86([]); // si se leyera, todo volveria a stock
            const r = await t.s.menuSync.reconciliar('scheduler');
            expect(r.success).toBe(false);

            const despues = [...(await t.almacen.findAllIndexed()).values()].map(i => [i.pos_id, i.in_stock]);
            expect(despues).toEqual(antes);

            const run = await ultimoRun();
            expect(run!.inventory_guids).toBeNull();
            expect(run!.status).toBe('ok');

            const status = await t.get('/api/status');
            expect(status.status).toBe('warn');
            expect(status.health.inventory).toBe('error');
        }

        // Tambien en la importacion: preservarStock.
        t.mock.estado.modo86 = '500';
        const r = await t.s.menuSync.importar('scheduler');
        expect(r.success).toBe(true);
        expect((await item(P2))!.in_stock).toBe(false);
        expect((await ultimoRun())!.inventory_guids).toBeNull();

        // Una respuesta 200 con forma rara tampoco se lee como "nada agotado".
        t.mock.estado.modo86 = 'invalido';
        await t.s.menuSync.reconciliar('scheduler');
        expect((await item(P2))!.in_stock).toBe(false);
    });

    test('15. freno de borrado: un export con menos de la mitad de las filas no borra nada', async () => {
        const ids = idsSecuenciales(12);
        t = await armarTienda({}, xmlConProductos(ids));
        await t.s.menuSync.importar('scheduler');
        expect((await t.almacen.findAllIndexed()).size).toBe(12);

        t.mock.estado.xml = xmlConProductos(ids.slice(0, 3));
        const r = await t.s.menuSync.importar('scheduler');
        expect(r.success).toBe(true);
        expect((await t.almacen.findAllIndexed()).size).toBe(12);

        const run = await ultimoRun();
        expect(run!.reason).toBe('BORRADO_FRENADO');
        expect(run!.db_deleted).toBe(0);
        expect(t.errores.some(e => e.includes('Borrado masivo CANCELADO'))).toBe(true);
    });

    test('13. dayparts no son 86: un producto con availability de horario sigue en stock', async () => {
        t = await armarTienda();
        expect(t.mock.estado.xml).toMatch(new RegExp(`id="${P3}"[^>]*availability=`));
        await t.s.menuSync.importar('scheduler');
        expect((await item(P3))!.in_stock).toBe(true);
        // Y la categoria fuera de MENU_CONFIG no entra.
        expect(await item(P4)).toBeUndefined();
    });
});

describe('stock: deltas por webhook', () => {

    test('3. delta 86: un Product pasa a agotado con un solo registro de historial', async () => {
        t = await armarTienda();
        await t.s.menuSync.importar('scheduler');
        const antes = (await item(P1))!.toast_last_modified!;

        t.reloj.avanzar(5_000);
        const r = await t.evento('MenuItemAvailabilityChanged', arrayDeltas(delta('Product', P1, false)));
        expect(r.status).toBe(200);
        expect(r.body.aplicados).toBe(1);

        const p1 = (await item(P1))!;
        expect(p1.in_stock).toBe(false);
        expect(p1.toast_last_modified!.getTime()).toBeGreaterThan(antes.getTime());
        expect(stockDe(P1).map(h => [h.old_value, h.new_value])).toEqual([['Yes', 'No']]);
    });

    test('4. delta 68: la reactivacion es updated No -> Yes, sin created ni reactivated', async () => {
        t = await armarTienda();
        await t.s.menuSync.importar('scheduler');
        await t.evento('MenuItemAvailabilityChanged', arrayDeltas(delta('Product', P1, false)));
        t.reloj.avanzar(120_000);
        await t.evento('MenuItemAvailabilityChanged', arrayDeltas(delta('Product', P1, true)));

        expect((await item(P1))!.in_stock).toBe(true);
        const h = historialDe(P1).filter(x => x.change_type !== 'created' || x.field !== 'item');
        expect(h.map(x => [x.change_type, x.field, x.old_value, x.new_value])).toEqual([
            ['updated', 'in_stock', 'Yes', 'No'],
            ['updated', 'in_stock', 'No', 'Yes']
        ]);
        expect(t.almacen.interno.historial.some(x => (x.change_type as string) === 'reactivated')).toBe(false);
        expect(historialDe(P1).filter(x => x.change_type === 'created')).toHaveLength(1); // solo el alta de la importacion
    });

    test('5. Choice 86 afecta solo a la opcion; Product y Choice con el mismo id no se pisan', async () => {
        t = await armarTienda();
        await t.s.menuSync.importar('scheduler');

        await t.evento('MenuItemAvailabilityChanged', arrayDeltas(delta('Choice', O1, false)));
        expect((await item(`${O1}__mod`))!.in_stock).toBe(false);
        expect((await item(P1))!.in_stock).toBe(true);
        expect((await item(P2))!.in_stock).toBe(true);

        // Un Choice con el mismo id numerico que P1 va a P1__mod, nunca a P1.
        await t.evento('MenuItemAvailabilityChanged', arrayDeltas(delta('Choice', P1, false)));
        expect((await item(P1))!.in_stock).toBe(true);
        expect((await t.almacen.listarPendientes()).map(p => p.pos_id)).toEqual([`${P1}__mod`]);
    });

    test('6. mass 86: 300 items en una sola transaccion, todo o nada', async () => {
        const ids = idsSecuenciales(300);
        t = await armarTienda({}, xmlConProductos(ids));
        // 20 ya estan agotados: no deben generar historial.
        t.marcar86(ids.slice(0, 20));
        await t.s.menuSync.importar('scheduler');
        const historialAntes = t.almacen.interno.historial.length;

        const cuerpo = arrayDeltas(...ids.map(id => delta('Product', id, false)));

        // Falla a la mitad: no queda nada aplicado, ni siquiera el message id.
        t.almacen.fallarEscrituraStockTras = 150;
        const idMensaje = nuevoMessageId();
        const fallo = await t.evento('MenuItemAvailabilityChanged', cuerpo, idMensaje);
        expect(fallo.status).toBe(500);
        const tras = await t.almacen.findAllIndexed();
        expect(ids.slice(20).every(id => tras.get(id)!.in_stock === true)).toBe(true);
        expect(t.almacen.interno.historial.length).toBe(historialAntes);

        // El receptor reintenta el mismo mensaje y ahora entra entero.
        t.almacen.fallarEscrituraStockTras = null;
        const ok = await t.evento('MenuItemAvailabilityChanged', cuerpo, idMensaje);
        expect(ok.status).toBe(200);
        expect(ok.body.aplicados).toBe(280);
        expect(ok.body.sinCambio).toBe(20);

        const final = await t.almacen.findAllIndexed();
        expect(ids.every(id => final.get(id)!.in_stock === false)).toBe(true);
        for (const id of ids.slice(20)) expect(stockDe(id).filter(h => h.new_value === 'No')).toHaveLength(1);
        // Los 20 que ya estaban agotados tienen solo el registro de la importacion.
        for (const id of ids.slice(0, 20)) expect(stockDe(id)).toHaveLength(1);
    });

    test('7. duplicado: mismo message id = un efecto; otro id con el mismo contenido = sin cambios', async () => {
        t = await armarTienda();
        await t.s.menuSync.importar('scheduler');
        const cuerpo = arrayDeltas(delta('Product', P2, false));
        const id = nuevoMessageId();

        const a = await t.evento('MenuItemAvailabilityChanged', cuerpo, id);
        const b = await t.evento('MenuItemAvailabilityChanged', cuerpo, id);
        expect(a.body.duplicado).toBe(false);
        expect(b.body.duplicado).toBe(true);
        expect(stockDe(P2)).toHaveLength(1);

        t.reloj.avanzar(120_000);
        const c = await t.evento('MenuItemAvailabilityChanged', cuerpo);
        expect(c.body.duplicado).toBe(false);
        expect(c.body.aplicados).toBe(0);
        expect(stockDe(P2)).toHaveLength(1);
    });

    test('8. fuera de orden: el 86 viejo reintentado gana hasta que la verificacion por flapping lo corrige', async () => {
        t = await armarTienda({ OLO_FLAP_WINDOW_MS: '60000' });
        await t.s.menuSync.importar('scheduler');

        // Orden real en Olo: 86 y despues 68 (P1 esta disponible). Llega primero
        // el 68 y despues el reintento del 86 viejo.
        await t.evento('MenuItemAvailabilityChanged', arrayDeltas(delta('Product', P1, true)));
        t.reloj.avanzar(10_000);
        const viejo = await t.evento('MenuItemAvailabilityChanged', arrayDeltas(delta('Product', P1, false)));

        expect((await item(P1))!.in_stock).toBe(false); // el ultimo aplicado
        expect(viejo.body.sospechosos).toEqual([P1]);

        // La verificacion programada lee eightysixeditems (P1 no esta) y corrige.
        expect(await t.s.menuSync.ejecutarVerificacionPendiente()).toBe(true);
        expect((await item(P1))!.in_stock).toBe(true);
        expect(stockDe(P1).map(h => [h.old_value, h.new_value])).toEqual([['Yes', 'No'], ['No', 'Yes']]);
    });

    test('11. item desconocido: queda pendiente y se aplica tras la importacion; la linea base gana', async () => {
        // (a) Linea base caida en la importacion: el pendiente se aplica.
        t = await armarTienda({}, xmlConProductos([P1, P2]));
        await t.s.menuSync.importar('scheduler');
        await t.evento('MenuItemAvailabilityChanged', arrayDeltas(delta('Product', P3, false)));
        expect(await item(P3)).toBeUndefined();
        expect((await t.almacen.listarPendientes()).map(p => [p.pos_id, p.in_stock])).toEqual([[P3, false]]);

        t.mock.estado.xml = xmlConProductos([P1, P2, P3]);
        t.mock.estado.modo86 = '500';
        await t.s.menuSync.importar('scheduler');
        expect((await item(P3))!.in_stock).toBe(false);
        expect(stockDe(P3).map(h => [h.old_value, h.new_value])).toEqual([['Yes', 'No']]);
        expect(await t.almacen.listarPendientes()).toHaveLength(0);
        await t.detener();

        // (b) Linea base sana que lo contradice: gana la linea base.
        t = await armarTienda({}, xmlConProductos([P1, P2]));
        await t.s.menuSync.importar('scheduler');
        await t.evento('MenuItemAvailabilityChanged', arrayDeltas(delta('Product', P3, false)));
        t.mock.estado.xml = xmlConProductos([P1, P2, P3]);
        t.marcar86([]); // Olo dice que P3 esta disponible
        await t.s.menuSync.importar('scheduler');
        expect((await item(P3))!.in_stock).toBe(true);
        expect(await t.almacen.listarPendientes()).toHaveLength(0);
    });

    test('12. otra tienda: un delta con otro locationId no cambia nada', async () => {
        t = await armarTienda();
        await t.s.menuSync.importar('scheduler');
        const historial = t.almacen.interno.historial.length;

        const r = await t.evento('MenuItemAvailabilityChanged',
            arrayDeltas(delta('Product', P1, false, OTRA_TIENDA), delta('Choice', O2, false, OTRA_TIENDA)));
        expect(r.body.ignorados).toBe(2);
        expect((await item(P1))!.in_stock).toBe(true);
        expect((await item(`${O2}__mod`))!.in_stock).toBe(true);
        expect(t.almacen.interno.historial.length).toBe(historial);
    });

    test('14. tienda offline: cambia health.storeOnline y no toca el stock', async () => {
        t = await armarTienda();
        await t.s.menuSync.importar('scheduler');
        const antes = [...(await t.almacen.findAllIndexed()).values()].map(i => i.in_stock);

        await t.evento('VendorAvailabilityChanged',
            `{"storeNumber":"001","locationId":10000000000000001,"newStatus":"Offline","changeTime":"20261117 10:00"}`);
        const status = await t.get('/api/status');
        expect(status.health.storeOnline).toBe(false);
        expect([...(await t.almacen.findAllIndexed()).values()].map(i => i.in_stock)).toEqual(antes);

        await t.evento('VendorTemporarilyDisabled',
            `{"change":"Disabled","timestamp":"2026-11-17T15:00:00Z","vendorId":10000000000000001,"vendorStatus":"Disabled"}`);
        await t.evento('VendorAvailabilityChanged',
            `{"storeNumber":"001","locationId":10000000000000001,"newStatus":"Online","changeTime":"20261117 10:05"}`);
        expect((await t.get('/api/status')).health.storeOnline).toBe(false); // sigue deshabilitada
        expect([...(await t.almacen.findAllIndexed()).values()].map(i => i.in_stock)).toEqual(antes);
    });

    test('16. precision: ids de 17 digitos llegan intactos de webhook y de eightysixeditems', async () => {
        t = await armarTienda();
        // Sin el parseo seguro, JSON.parse redondea estos ids.
        expect(String(JSON.parse(`{"x":${P1}}`).x)).not.toBe(P1);
        expect(String(JSON.parse(`{"x":${O1}}`).x)).not.toBe(O1);

        t.marcar86([P2], [O1]);
        await t.s.menuSync.importar('scheduler');
        expect((await item(P2))!.in_stock).toBe(false);
        expect((await item(`${O1}__mod`))!.in_stock).toBe(false);

        await t.evento('MenuItemAvailabilityChanged', arrayDeltas(delta('Product', P1, false)));
        expect((await item(P1))!.pos_id).toBe(P1);
        expect((await item(P1))!.in_stock).toBe(false);
        // Ninguna fila con un id redondeado.
        const ids = [...(await t.almacen.findAllIndexed()).keys()];
        expect(ids.every(id => [P1, P2, P3, `${O1}__mod`, `${O2}__mod`].includes(id))).toBe(true);
    });
});

describe('stock: reconciliacion y ciclo de salud', () => {

    test('9. la reconciliacion repara un webhook perdido y alerta si corrige demasiado', async () => {
        t = await armarTienda({ OLO_RECONCILE_ALERT_ROWS: '1' });
        await t.s.menuSync.importar('scheduler');

        // P2 y O2 se 86ean en Olo y el webhook nunca llega.
        t.marcar86([P2], [O2]);
        const r = await t.s.menuSync.reconciliar('scheduler');
        expect(r.success).toBe(true);
        expect((await item(P2))!.in_stock).toBe(false);
        expect((await item(`${O2}__mod`))!.in_stock).toBe(false);
        expect(stockDe(P2).map(h => [h.old_value, h.new_value])).toEqual([['Yes', 'No']]);

        const run = await ultimoRun();
        expect(run!.db_updated).toBe(2);
        expect(run!.inventory_guids).toBe(2);
        expect(run!.reason).toBe('HAY_CAMBIOS');
        expect(t.errores.some(e => e.includes('corrigió 2 filas'))).toBe(true);
    });

    test('17. ciclo de salud: cada tick escribe un run ok con el inventory_guids de la ultima linea base', async () => {
        t = await armarTienda({ OLO_RECONCILE_INTERVAL_MS: '600000' });
        t.marcar86([P2], [O1]);
        await t.s.menuSync.importar('scheduler');
        const llamadas = t.mock.estado.llamadas.length;

        for (let i = 0; i < 3; i++) {
            t.reloj.avanzar(78_000);
            await t.s.menuSync.autoSync();
        }
        // El tick no llama a Olo.
        expect(t.mock.estado.llamadas.length).toBe(llamadas);

        const runs = await t.almacen.listarRuns(3);
        expect(runs.every(r => r.status === 'ok' && r.reason === 'SIN_CAMBIOS' && r.inventory_guids === 2)).toBe(true);
        expect((await t.get('/api/status')).status).toBe('ok');

        // Si la ultima linea base fallo, el tick arrastra el NULL y queda en warn.
        t.mock.estado.modo86 = '500';
        await t.s.menuSync.reconciliar('scheduler');
        t.reloj.avanzar(78_000);
        await t.s.menuSync.autoSync();
        expect((await ultimoRun())!.inventory_guids).toBeNull();
        expect((await t.get('/api/status')).status).toBe('warn');
    });

    test('18. reconciliaciones seguidas que corrigen filas alertan; /api/status expone las metricas', async () => {
        t = await armarTienda({ OLO_RECONCILE_ALERT_CONSECUTIVE: '3', OLO_RECONCILE_ALERT_ROWS: '50' });
        await t.s.menuSync.importar('scheduler');
        await t.evento('Test', '{"message":"Olo webhook test!"}');

        const conjuntos = [[P1], [P1, P2], [P2]];
        for (const c of conjuntos) {
            t.marcar86(c);
            t.reloj.avanzar(600_000);
            await t.s.menuSync.reconciliar('scheduler');
        }
        expect(t.errores.some(e => e.includes('3 reconciliaciones seguidas corrigieron filas'))).toBe(true);

        const status = await t.get('/api/status');
        expect(status.health.lastWebhookAt).not.toBeNull();
        expect(status.health.lastReconcileAt).not.toBeNull();
        expect(status.health.lastReconcileCorrected).toBe(1);

        // Una reconciliacion sin diferencias corta la racha.
        t.reloj.avanzar(600_000);
        await t.s.menuSync.reconciliar('scheduler');
        expect((await t.get('/api/status')).olo.consecutiveCorrections).toBe(0);
    });
});
