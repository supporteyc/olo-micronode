/**
 * Prueba de humo de AlmacenPrisma contra un MySQL real, con el mock de Olo.
 *
 *   DATABASE_URL="mysql://usuario:password@localhost:3306/ec4olo_smoke" bun run scripts/smoke-mysql.ts
 *
 * La suite de bun test corre sobre AlmacenMemoria. Esto cubre lo que ella no:
 * que sql/001 a 004 se apliquen, que las consultas de Prisma hagan lo mismo y
 * que las transacciones de MySQL sean todo o nada.
 *
 * USAR UNA BASE VACIA DE PRUEBA: crea tablas y escribe filas. Se niega a correr
 * si menu_items ya tiene datos.
 */
import { prismaCompartido, AlmacenPrisma } from '../src/almacen/prisma';
import { asegurarEsquema } from '../src/services/schema.service';
import { crearServicios } from '../src/contenedor';
import { leerConfigOcb, leerConfigOlo } from '../src/config/olo';
import { crearMockOlo } from '../tools/mock-olo/mockOlo';
import { readFileSync } from 'node:fs';

if (!process.env.DATABASE_URL) {
    console.error('Define DATABASE_URL apuntando a una base MySQL VACIA de prueba.');
    process.exit(1);
}
if (!process.env.MENU_CONFIG) process.env.MENU_CONFIG = '[["Burgers",1],["Drinks",2]]';

const P2 = '90000000000000012';
const O1 = '90000000000000021';
const prisma = prismaCompartido();
let fallos = 0;

function verificar(nombre: string, ok: boolean, detalle = '') {
    console.log(`${ok ? 'OK   ' : 'FALLA'} ${nombre}${detalle ? `  (${detalle})` : ''}`);
    if (!ok) fallos++;
}

await asegurarEsquema();
if ((await prisma.menu_items.count()) > 0) {
    console.error('menu_items ya tiene filas: esta prueba necesita una base vacia.');
    process.exit(1);
}

const mock = crearMockOlo();
const almacen = new AlmacenPrisma(prisma);
const s = crearServicios({
    almacen,
    cfg: leerConfigOlo({ OLO_ENV: 'mock', OLO_BASE_URL: mock.baseUrl, OLO_MAX_RETRIES: '0', OLO_EXPORT_DAILY_AT: '' }),
    cfgOcb: leerConfigOcb({}),
    dormir: async () => {}
});

try {
    // Importacion con linea base.
    mock.estado.productos86 = new Set([P2]);
    mock.estado.opciones86 = new Set([O1]);
    const r = await s.menuSync.importar('manual');
    await s.menuSync.esperarCierres();
    const p2 = await prisma.menu_items.findUnique({ where: { pos_id: P2 } });
    verificar('importacion + linea base', r.success && p2?.in_stock === false, `P2.in_stock=${p2?.in_stock}`);
    const run = await prisma.sync_runs.findFirst({ orderBy: { id: 'desc' } });
    verificar('sync_runs', run?.inventory_guids === 2 && run?.sold_out_items === 2);

    // Delta en transaccion + dedup (INSERT IGNORE).
    const delta = `[{"locationId":10000000000000001,"itemEntityType":"Product","itemEntityId":${P2},"isAvailable":true}]`;
    const a = await s.eventos.procesar({ tipo: 'MenuItemAvailabilityChanged', messageId: 'smoke-1', rawBody: delta });
    const b = await s.eventos.procesar({ tipo: 'MenuItemAvailabilityChanged', messageId: 'smoke-1', rawBody: delta });
    verificar('delta 68 aplicado una vez', (a.body as any).aplicados === 1 && (b.body as any).duplicado === true);

    // Transaccion todo o nada: un fallo despues de escribir no deja nada.
    const antes = await prisma.menu_items.findUnique({ where: { pos_id: P2 } });
    await almacen.transaccion(async tx => {
        await tx.escribirStock([{ pos_id: P2, in_stock: false }], new Date());
        throw new Error('rollback a proposito');
    }).catch(() => {});
    const despues = await prisma.menu_items.findUnique({ where: { pos_id: P2 } });
    verificar('rollback de MySQL', despues?.in_stock === antes?.in_stock);

    // OCB.
    const orden = readFileSync('fixtures/webhooks/OrderPlaced.json', 'utf-8');
    await s.eventos.procesar({ tipo: 'OrderPlaced', messageId: 'smoke-ord-1', rawBody: orden });
    const board = await s.ocb.getOrderStatusBoard(undefined, 20261117);
    verificar('OCB escribe ocb_orders y ocb_olo_state', board.totalOrders === 1 && board.orders[0].items.length === 1);

    // Reconciliacion.
    mock.estado.productos86 = new Set();
    mock.estado.opciones86 = new Set();
    await s.menuSync.reconciliar('manual');
    const o1 = await prisma.menu_items.findUnique({ where: { pos_id: `${O1}__mod` } });
    verificar('reconciliacion', o1?.in_stock === true);
} finally {
    await s.menuSync.esperarCierres();
    mock.detener();
    await prisma.$disconnect();
}

console.log(fallos === 0 ? '\nTodo OK.' : `\n${fallos} verificacion(es) fallaron.`);
process.exit(fallos === 0 ? 0 : 1);
