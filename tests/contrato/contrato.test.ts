import { afterEach, describe, expect, test } from 'bun:test';
import { armarTienda, arrayDeltas, delta, P1, P2, type Tienda } from '../helpers';

/**
 * Contrato HTTP con OnSign y el console: la forma de cada respuesta tiene que
 * ser la de ec4toast-node. Las listas de claves salen del codigo de
 * ec4toast-node (toast.controller.ts, status.controller.ts, menuSync.getMenuExport,
 * prisma/schema.prisma), no del prompt: donde el prompt y el codigo difieren,
 * manda el codigo (ver docs/REVISION.md).
 */

let t: Tienda;
afterEach(async () => { await t?.detener(); });

const FILA_MENU_EXPORT = ['pos_id', 'menu_number', 'item_type', 'category', 'parent_group', 'name', 'description', 'price', 'in_stock', 'sold_out_icon'];

const STATUS = ['tenant', 'side', 'status', 'now', 'bootedAt', 'uptimeSeconds', 'scheduler', 'lastRun', 'lastOkRun', 'menu', 'config', 'health'];
const STATUS_SCHEDULER = ['paused', 'intervalSeconds', 'nextRunInSeconds', 'behind'];
const STATUS_HEALTH_TOAST = ['db', 'toastApi', 'inventory', 'menuConfig'];
const STATUS_HEALTH_NUEVOS = ['storeOnline', 'lastWebhookAt', 'lastReconcileAt'];

const SYNC_RUN = ['id', 'started_at', 'finished_at', 'duration_ms', 'status', 'trigger_source', 'reason', 'source_items',
    'inventory_guids', 'sold_out_items', 'db_created', 'db_updated', 'db_deleted', 'db_unchanged', 'changes_logged', 'error_message'];
const MENU_CHANGE = ['id', 'pos_id', 'item_name', 'change_type', 'field', 'old_value', 'new_value', 'changed_at'];

describe('contrato HTTP', () => {

    test('menu-export: misma fila, mismo orden de claves, Yes/No y sold_out_icon', async () => {
        t = await armarTienda();
        t.marcar86([P2]);
        await t.s.menuSync.importar('scheduler');

        const filas = await t.get('/api/toast/menu-export?soldOutIconUrl=https://x.test/i.png');
        expect(filas.length).toBe(5);
        for (const f of filas) expect(Object.keys(f)).toEqual(FILA_MENU_EXPORT);
        expect(filas.every((f: any) => f.in_stock === 'Yes' || f.in_stock === 'No')).toBe(true);
        // Orden: menu_number y sort_order.
        const numeros = filas.map((f: any) => f.menu_number);
        expect([...numeros].sort((a, b) => a - b)).toEqual(numeros);

        const p1 = filas.find((f: any) => f.pos_id === P1);
        expect(p1).toEqual({
            pos_id: P1, menu_number: 1, item_type: 'PRODUCT', category: 'Burgers', parent_group: '',
            name: 'Classic Burger', description: 'Beef, cheese, pickles', price: '$12.50', in_stock: 'Yes', sold_out_icon: ''
        });
        const mod = filas.find((f: any) => f.item_type === 'MODIFIER');
        expect(mod.category).toBe('Choose a Side (Group ID: 40000000000000001)');
        expect(mod.parent_group).toBe('Burgers');

        // withCount envuelve en { totalItems, items } (asi lo hace ec4toast-node).
        const conteo = await t.get('/api/toast/menu-export?withCount=true');
        expect(Object.keys(conteo)).toEqual(['totalItems', 'items']);
        expect(conteo.totalItems).toBe(5);
    });

    test('/api/status conserva todos los campos y agrega los nuevos sin quitar ninguno', async () => {
        t = await armarTienda();
        await t.s.menuSync.importar('scheduler');
        const s = await t.get('/api/status');

        for (const k of STATUS) expect(Object.keys(s)).toContain(k);
        expect(Object.keys(s.scheduler)).toEqual(STATUS_SCHEDULER);
        for (const k of [...STATUS_HEALTH_TOAST, ...STATUS_HEALTH_NUEVOS]) expect(Object.keys(s.health)).toContain(k);
        expect(Object.keys(s.menu)).toEqual(['total', 'activos', 'agotados']);
        expect(Object.keys(s.config)).toEqual(['menuGroups', 'groups', 'source']);
        expect(s.side).toBe('toast');
        expect(s.status).toBe('ok');
        expect(Object.keys(s.lastRun)).toEqual(SYNC_RUN);
    });

    test('/api/runs y /api/toast/menu-changes: columnas de sync_runs y menu_item_changes', async () => {
        t = await armarTienda();
        await t.s.menuSync.importar('scheduler');
        await t.evento('MenuItemAvailabilityChanged', arrayDeltas(delta('Product', P1, false)));
        await t.s.menuSync.esperarCierres();

        const runs = await t.get('/api/runs?limit=5');
        expect(runs.length).toBeGreaterThan(0);
        expect(Object.keys(runs[0])).toEqual(SYNC_RUN);

        const cambios = await t.get(`/api/toast/menu-changes?posId=${P1}`);
        expect(Object.keys(cambios[0]).sort()).toEqual([...MENU_CHANGE].sort());
        expect(cambios[0]).toMatchObject({ pos_id: P1, change_type: 'updated', field: 'in_stock', old_value: 'Yes', new_value: 'No' });
    });

    test('scheduler: pause, status y resume bajo /api/toast/scheduler', async () => {
        t = await armarTienda();
        const r = await fetch(`${t.url}/api/toast/scheduler/pause`, { method: 'POST' });
        expect(await r.json()).toEqual({ paused: true, message: 'Scheduler pausado. Llama /scheduler/resume para reanudar.' });
        expect(await t.get('/api/toast/scheduler/status')).toEqual({ paused: true });
        await fetch(`${t.url}/api/toast/scheduler/resume`, { method: 'POST' });
        expect(await t.get('/api/toast/scheduler/status')).toEqual({ paused: false });
    });

    test('menu-categories: forma de ec4toast-node mas kind, con categorias y optiongroups', async () => {
        t = await armarTienda();
        const c = await t.get('/api/toast/menu-categories');
        expect(Object.keys(c[0])).toEqual(['groupName', 'guid', 'menuPath', 'kind', 'inConfig', 'menuNumber', 'includeItems', 'includeSubGroups']);
        const burgers = c.find((x: any) => x.groupName === 'Burgers');
        expect(burgers).toMatchObject({ kind: 'category', inConfig: true, menuNumber: 1 });
        expect(c.find((x: any) => x.groupName === 'Secret')).toMatchObject({ inConfig: false, menuNumber: null });
        expect(c.find((x: any) => x.groupName === 'Choose a Side')).toMatchObject({ kind: 'optiongroup' });
    });

    test('/health abierto y POST /menu-export/sync responde como ec4toast-node', async () => {
        t = await armarTienda();
        expect(await t.get('/health')).toMatchObject({ status: 'OK' });
        const r: any = await (await fetch(`${t.url}/api/toast/menu-export/sync`, { method: 'POST' })).json();
        expect(r).toMatchObject({ status: 'ok', message: 'Sync completed', success: true });
        expect(Object.keys(r)).toEqual(['status', 'message', 'success', 'guardados', 'desactivados', 'stockActualizado']);
    });

    test('ninguna ruta llama a los endpoints de menu en vivo de Olo', async () => {
        t = await armarTienda();
        await t.s.menuSync.importar('scheduler');
        await t.s.menuSync.reconciliar('scheduler');
        await t.get('/api/toast/menu-categories');
        const paths = t.mock.estado.llamadas.map(l => l.path);
        expect(paths.some(p => /\/restaurants\/\d+\/menu/.test(p))).toBe(false);
    });
});
