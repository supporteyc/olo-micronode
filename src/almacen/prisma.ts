import { PrismaClient, Prisma } from '@prisma/client';
import type {
    Almacen, CambioStock, EstadoOcbOlo, EstadoRun, EventoWebhook, FilaHistorial,
    FilaRun, ItemMenu, OrdenOcbDb, Pendiente
} from './tipos';
import type { FilaConOrden } from '../services/menuDiff.service';
import type { EntradaHistorial } from '../services/changeLog.service';

type Cliente = PrismaClient | Prisma.TransactionClient;

/**
 * Almacen sobre MySQL con Prisma. Mismas consultas que ec4toast-node
 * (findActiveItemsSorted, upsert por pos_id, deleteMany por id, COUNT del
 * resumen), mas las tablas de sql/004.
 *
 * Un solo PrismaClient para todo el proceso: ec4toast-node creaba uno por
 * servicio, que son cuatro pools de conexiones contra la misma base.
 */
export class AlmacenPrisma implements Almacen {

    constructor(private db: Cliente, private raiz: PrismaClient | null = db as PrismaClient) {}

    public async transaccion<T>(fn: (tx: Almacen) => Promise<T>): Promise<T> {
        if (!this.raiz || !('$transaction' in this.db)) return fn(this);
        return this.raiz.$transaction(
            async tx => fn(new AlmacenPrisma(tx, null)),
            // Un mass 86 de cientos de filas tarda mas que el default de 5 s.
            { timeout: 30_000, maxWait: 30_000 }
        );
    }

    // ---------- menu_items ----------

    async findAllIndexed(): Promise<Map<string, ItemMenu>> {
        const todos = await this.db.menu_items.findMany();
        return new Map(todos.map(i => [i.pos_id, i as ItemMenu]));
    }

    async findActiveItemsSorted(): Promise<ItemMenu[]> {
        return this.db.menu_items.findMany({
            where: { is_active: true, menu_number: { not: null } },
            orderBy: [{ menu_number: 'asc' }, { sort_order: 'asc' }]
        }) as Promise<ItemMenu[]>;
    }

    async upsertFilas(filas: FilaConOrden[], preservarStock: boolean, detectadoEn: Date): Promise<number> {
        let guardadas = 0;
        for (const fila of filas) {
            const datos = {
                menu: fila.menu,
                item_type: fila.item_type,
                category: fila.category,
                parent_group: fila.parent_group,
                name: fila.name,
                description: fila.description,
                price: fila.price,
                in_stock: fila.in_stock,
                out_of_stock_icon: fila.out_of_stock_icon,
                sort_order: fila.sort_order,
                menu_number: fila.menu_number,
                is_active: true,
                miss_count: 0,
                toast_last_modified: detectadoEn,
                updated_at: detectadoEn
            };
            const { in_stock, out_of_stock_icon, ...sinStock } = datos;
            await this.db.menu_items.upsert({
                where: { pos_id: fila.pos_id },
                create: { pos_id: fila.pos_id, ...datos },
                update: preservarStock ? sinStock : datos
            });
            guardadas++;
        }
        return guardadas;
    }

    async borrarPorId(ids: bigint[]): Promise<number> {
        if (ids.length === 0) return 0;
        const { count } = await this.db.menu_items.deleteMany({ where: { id: { in: ids } } });
        return count;
    }

    async escribirStock(cambios: CambioStock[], detectadoEn: Date): Promise<number> {
        // Dos UPDATE ... WHERE pos_id IN (...) en vez de uno por fila: un mass 86
        // de 300 items son 2 sentencias y no 300.
        let n = 0;
        for (const valor of [true, false]) {
            const ids = cambios.filter(c => c.in_stock === valor).map(c => c.pos_id);
            for (let i = 0; i < ids.length; i += 500) {
                const { count } = await this.db.menu_items.updateMany({
                    where: { pos_id: { in: ids.slice(i, i + 500) } },
                    data: { in_stock: valor, out_of_stock_icon: "", updated_at: detectadoEn, toast_last_modified: detectadoEn }
                });
                n += count;
            }
        }
        return n;
    }

    async contarResumen() {
        const [total, activos, agotados] = await Promise.all([
            this.db.menu_items.count(),
            this.db.menu_items.count({ where: { is_active: true } }),
            this.db.menu_items.count({ where: { is_active: true, in_stock: false } })
        ]);
        return { total, activos, agotados };
    }

    // ---------- menu_item_changes ----------

    async registrarHistorial(entradas: EntradaHistorial[]): Promise<number> {
        if (entradas.length === 0) return 0;
        const { count } = await this.db.menu_item_changes.createMany({ data: entradas });
        return count;
    }

    async listarHistorial(limite: number, posId?: string): Promise<FilaHistorial[]> {
        return this.db.menu_item_changes.findMany({
            where: posId ? { pos_id: posId } : undefined,
            orderBy: [{ changed_at: 'desc' }, { id: 'desc' }],
            take: Math.min(Math.max(limite, 1), 1000)
        }) as Promise<FilaHistorial[]>;
    }

    // ---------- sync_runs ----------

    async guardarRun(fila: FilaRun): Promise<void> {
        const { id, ...datos } = fila;
        await this.db.sync_runs.create({ data: datos });
    }

    async listarRuns(limite: number, status?: EstadoRun): Promise<FilaRun[]> {
        return this.db.sync_runs.findMany({
            where: status ? { status } : undefined,
            orderBy: { started_at: 'desc' },
            take: Math.min(Math.max(limite, 1), 500)
        });
    }

    async ultimoRun(): Promise<FilaRun | null> {
        return this.db.sync_runs.findFirst({ orderBy: { started_at: 'desc' } });
    }

    async ultimoRunOk(): Promise<FilaRun | null> {
        return this.db.sync_runs.findFirst({ where: { status: 'ok' }, orderBy: { started_at: 'desc' } });
    }

    // ---------- olo_webhook_events ----------

    async registrarEvento(evento: EventoWebhook): Promise<boolean> {
        // INSERT IGNORE y no try/catch del P2002: dentro de una transaccion de
        // MySQL un error de clave duplicada no aborta la transaccion, pero en
        // Prisma el error si corta el callback. Con IGNORE el resultado dice si
        // se inserto (1) o ya existia (0) sin lanzar.
        const filas = await this.db.$executeRaw`
            INSERT IGNORE INTO olo_webhook_events (message_id, event_type, entity_key, applied, note)
            VALUES (${evento.message_id}, ${evento.event_type}, ${evento.entity_key},
                    ${evento.applied ?? true}, ${evento.note ?? null})`;
        return filas === 1;
    }

    async purgarEventos(antesDe: Date): Promise<number> {
        const { count } = await this.db.olo_webhook_events.deleteMany({ where: { received_at: { lt: antesDe } } });
        return count;
    }

    // ---------- olo_pending_availability ----------

    async guardarPendientes(cambios: CambioStock[], recibidoEn: Date): Promise<void> {
        for (const c of cambios) {
            await this.db.olo_pending_availability.upsert({
                where: { pos_id: c.pos_id },
                create: { pos_id: c.pos_id, in_stock: c.in_stock, received_at: recibidoEn },
                update: { in_stock: c.in_stock, received_at: recibidoEn }
            });
        }
    }

    async listarPendientes(): Promise<Pendiente[]> {
        return this.db.olo_pending_availability.findMany({ orderBy: { received_at: 'asc' } });
    }

    async borrarPendientes(posIds?: string[]): Promise<void> {
        await this.db.olo_pending_availability.deleteMany({
            where: posIds ? { pos_id: { in: posIds } } : undefined
        });
    }

    // ---------- OCB ----------

    async leerEstadoOcb(orderGuid: string): Promise<EstadoOcbOlo | null> {
        return this.db.ocb_olo_state.findUnique({ where: { order_guid: orderGuid } });
    }

    async buscarEstadoOcbPorOrderId(orderIdString: string): Promise<EstadoOcbOlo | null> {
        return this.db.ocb_olo_state.findFirst({ where: { order_id_string: orderIdString } });
    }

    async guardarEstadoOcb(estado: EstadoOcbOlo): Promise<void> {
        const { order_guid, ...resto } = estado;
        await this.db.ocb_olo_state.upsert({
            where: { order_guid },
            create: estado,
            update: resto
        });
    }

    async estadosOcbVencidos(ahora: Date): Promise<EstadoOcbOlo[]> {
        return this.db.ocb_olo_state.findMany({
            where: { OR: [{ hide_at: { lte: ahora } }, { expire_at: { lte: ahora } }] }
        });
    }

    async estadosOcbProgramados(): Promise<EstadoOcbOlo[]> {
        return this.db.ocb_olo_state.findMany({ where: { state: 'SCHEDULED' } });
    }

    async upsertOrdenOcb(orden: OrdenOcbDb): Promise<void> {
        const { items, created_at, updated_at, ...cabecera } = orden;
        const ahora = new Date();
        const existente = await this.db.ocb_orders.findUnique({
            where: { order_guid: orden.order_guid },
            select: { id: true }
        });

        if (existente) {
            // Las lineas se reemplazan enteras: cada evento de Olo trae la orden
            // completa, no un delta. Igual que ocb.service de ec4toast-node.
            await this.db.ocb_order_items.deleteMany({ where: { order_id: existente.id } });
            await this.db.ocb_orders.update({
                where: { id: existente.id },
                data: { ...cabecera, updated_at: ahora, items: { create: items } }
            });
        } else {
            await this.db.ocb_orders.create({
                data: { ...cabecera, created_at: ahora, updated_at: ahora, items: { create: items } }
            });
        }
    }

    async borrarOrdenOcb(orderGuid: string): Promise<void> {
        // ocb_order_items tiene ON DELETE CASCADE.
        await this.db.ocb_orders.deleteMany({ where: { order_guid: orderGuid } });
    }

    async listarOrdenesOcb(restaurantGuid: string, businessDate: number): Promise<OrdenOcbDb[]> {
        const filas = await this.db.ocb_orders.findMany({
            where: { restaurant_guid: restaurantGuid, business_date: businessDate },
            orderBy: { display_number: 'asc' },
            include: { items: true }
        });
        return filas.map(f => ({
            ...f,
            items: f.items.map(i => ({
                name: i.name,
                quantity: i.quantity,
                price: i.price,
                fulfillment_status: i.fulfillment_status,
                modifiers: i.modifiers ?? ""
            }))
        }));
    }
}

let cliente: PrismaClient | null = null;

/** El PrismaClient compartido del proceso. */
export function prismaCompartido(): PrismaClient {
    if (!cliente) cliente = new PrismaClient();
    return cliente;
}
