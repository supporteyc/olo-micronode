import type {
    Almacen, CambioStock, EstadoOcbOlo, EstadoRun, EventoWebhook, FilaHistorial,
    FilaRun, ItemMenu, OrdenOcbDb, Pendiente
} from './tipos';
import type { FilaConOrden } from '../services/menuDiff.service';
import type { EntradaHistorial } from '../services/changeLog.service';

/**
 * Almacen en memoria con la misma semantica que el de MySQL.
 *
 * Existe para dos cosas: que los tests de stock y OCB corran sin MySQL, y que
 * `bun run dev:mock` levante todo sin base. No es para produccion: se pierde
 * todo al reiniciar, y el arranque lo avisa a gritos.
 *
 * Las transacciones son copia-y-cambio: se clona el estado, fn escribe sobre
 * la copia, y solo si termina sin lanzar la copia reemplaza al original. Asi un
 * mass 86 que falla a la mitad no deja nada aplicado, igual que InnoDB.
 */

interface Estado {
    menu: Map<string, ItemMenu>;
    historial: FilaHistorial[];
    runs: FilaRun[];
    eventos: Map<string, EventoWebhook & { received_at: Date }>;
    pendientes: Map<string, Pendiente>;
    estadosOcb: Map<string, EstadoOcbOlo>;
    ordenesOcb: Map<string, OrdenOcbDb>;
    secuencia: { menu: bigint; historial: bigint; run: bigint };
}

function estadoVacio(): Estado {
    return {
        menu: new Map(),
        historial: [],
        runs: [],
        eventos: new Map(),
        pendientes: new Map(),
        estadosOcb: new Map(),
        ordenesOcb: new Map(),
        secuencia: { menu: 0n, historial: 0n, run: 0n }
    };
}

/** MySQL guarda TIMESTAMP(0): sin milisegundos. Se imita para que los tests no mientan. */
function aSegundos(d: Date): Date {
    return new Date(Math.floor(d.getTime() / 1000) * 1000);
}

export class AlmacenMemoria implements Almacen {

    /** Contenedor compartido: la copia de una transaccion reemplaza a .estado. */
    private caja: { estado: Estado };
    private enTx: boolean;

    /** Para tests: falla a proposito despues de N escrituras de stock. */
    public fallarEscrituraStockTras: number | null = null;

    constructor(caja?: { estado: Estado }, enTx = false) {
        this.caja = caja ?? { estado: estadoVacio() };
        this.enTx = enTx;
    }

    private get s(): Estado {
        return this.caja.estado;
    }

    public async transaccion<T>(fn: (tx: Almacen) => Promise<T>): Promise<T> {
        if (this.enTx) return fn(this);

        const copia = { estado: structuredClone(this.caja.estado) };
        const tx = new AlmacenMemoria(copia, true);
        tx.fallarEscrituraStockTras = this.fallarEscrituraStockTras;
        const resultado = await fn(tx);
        this.caja.estado = copia.estado;
        return resultado;
    }

    // ---------- menu_items ----------

    async findAllIndexed(): Promise<Map<string, ItemMenu>> {
        return new Map([...this.s.menu.values()].map(i => [i.pos_id, { ...i }]));
    }

    async findActiveItemsSorted(): Promise<ItemMenu[]> {
        return [...this.s.menu.values()]
            .filter(i => i.is_active === true && i.menu_number !== null)
            .sort((a, b) =>
                (a.menu_number! - b.menu_number!) || ((a.sort_order ?? 0) - (b.sort_order ?? 0)))
            .map(i => ({ ...i }));
    }

    async upsertFilas(filas: FilaConOrden[], preservarStock: boolean, detectadoEn: Date): Promise<number> {
        const ahora = aSegundos(detectadoEn);
        for (const fila of filas) {
            const existente = this.s.menu.get(fila.pos_id);
            const datos = {
                menu: fila.menu,
                item_type: fila.item_type,
                category: fila.category,
                parent_group: fila.parent_group,
                name: fila.name,
                description: fila.description,
                price: fila.price,
                sort_order: fila.sort_order,
                menu_number: fila.menu_number,
                is_active: true,
                miss_count: 0,
                toast_last_modified: ahora
            };
            if (existente) {
                Object.assign(existente, datos, { updated_at: ahora });
                if (!preservarStock) {
                    existente.in_stock = fila.in_stock;
                    existente.out_of_stock_icon = fila.out_of_stock_icon;
                }
            } else {
                this.s.secuencia.menu++;
                this.s.menu.set(fila.pos_id, {
                    id: this.s.secuencia.menu,
                    pos_id: fila.pos_id,
                    ...datos,
                    in_stock: fila.in_stock,
                    out_of_stock_icon: fila.out_of_stock_icon,
                    created_at: ahora,
                    updated_at: ahora,
                    last_synced_to_onsign: null,
                    onsign_row_id: null,
                    onsign_version: null
                });
            }
        }
        return filas.length;
    }

    async borrarPorId(ids: bigint[]): Promise<number> {
        const set = new Set(ids);
        let n = 0;
        for (const [posId, item] of this.s.menu) {
            if (set.has(item.id)) {
                this.s.menu.delete(posId);
                n++;
            }
        }
        return n;
    }

    async escribirStock(cambios: CambioStock[], detectadoEn: Date): Promise<number> {
        const ahora = aSegundos(detectadoEn);
        let n = 0;
        for (const c of cambios) {
            if (this.fallarEscrituraStockTras !== null && n >= this.fallarEscrituraStockTras) {
                throw new Error(`Fallo simulado tras ${n} escrituras de stock`);
            }
            const item = this.s.menu.get(c.pos_id);
            if (!item) continue;
            item.in_stock = c.in_stock;
            item.out_of_stock_icon = "";
            item.updated_at = ahora;
            item.toast_last_modified = ahora;
            n++;
        }
        return n;
    }

    async contarResumen() {
        const todos = [...this.s.menu.values()];
        return {
            total: todos.length,
            activos: todos.filter(i => i.is_active === true).length,
            agotados: todos.filter(i => i.is_active === true && i.in_stock === false).length
        };
    }

    // ---------- menu_item_changes ----------

    async registrarHistorial(entradas: EntradaHistorial[]): Promise<number> {
        const ahora = aSegundos(new Date());
        for (const e of entradas) {
            this.s.secuencia.historial++;
            // Mismo orden de columnas que menu_item_changes en MySQL.
            this.s.historial.push({
                id: this.s.secuencia.historial, pos_id: e.pos_id, item_name: e.item_name, change_type: e.change_type,
                field: e.field, old_value: e.old_value, new_value: e.new_value, changed_at: ahora
            });
        }
        return entradas.length;
    }

    async listarHistorial(limite: number, posId?: string): Promise<FilaHistorial[]> {
        return this.s.historial
            .filter(h => !posId || h.pos_id === posId)
            .sort((a, b) => (b.changed_at.getTime() - a.changed_at.getTime()) || Number(b.id - a.id))
            .slice(0, Math.min(Math.max(limite, 1), 1000))
            .map(h => ({ ...h }));
    }

    // ---------- sync_runs ----------

    async guardarRun(fila: FilaRun): Promise<void> {
        this.s.secuencia.run++;
        this.s.runs.push({ id: this.s.secuencia.run, ...fila });
    }

    private runsOrdenados(): FilaRun[] {
        return [...this.s.runs].sort((a, b) =>
            (b.started_at.getTime() - a.started_at.getTime()) || Number((b.id ?? 0n) - (a.id ?? 0n)));
    }

    async listarRuns(limite: number, status?: EstadoRun): Promise<FilaRun[]> {
        return this.runsOrdenados()
            .filter(r => !status || r.status === status)
            .slice(0, Math.min(Math.max(limite, 1), 500));
    }

    async ultimoRun(): Promise<FilaRun | null> {
        return this.runsOrdenados()[0] ?? null;
    }

    async ultimoRunOk(): Promise<FilaRun | null> {
        return this.runsOrdenados().find(r => r.status === 'ok') ?? null;
    }

    // ---------- olo_webhook_events ----------

    async registrarEvento(evento: EventoWebhook): Promise<boolean> {
        if (this.s.eventos.has(evento.message_id)) return false;
        this.s.eventos.set(evento.message_id, { applied: true, note: null, ...evento, received_at: new Date() });
        return true;
    }

    async purgarEventos(antesDe: Date): Promise<number> {
        let n = 0;
        for (const [id, e] of this.s.eventos) {
            if (e.received_at < antesDe) {
                this.s.eventos.delete(id);
                n++;
            }
        }
        return n;
    }

    // ---------- olo_pending_availability ----------

    async guardarPendientes(cambios: CambioStock[], recibidoEn: Date): Promise<void> {
        for (const c of cambios) {
            this.s.pendientes.set(c.pos_id, { pos_id: c.pos_id, in_stock: c.in_stock, received_at: recibidoEn });
        }
    }

    async listarPendientes(): Promise<Pendiente[]> {
        return [...this.s.pendientes.values()]
            .sort((a, b) => a.received_at.getTime() - b.received_at.getTime())
            .map(p => ({ ...p }));
    }

    async borrarPendientes(posIds?: string[]): Promise<void> {
        if (!posIds) {
            this.s.pendientes.clear();
            return;
        }
        for (const id of posIds) this.s.pendientes.delete(id);
    }

    // ---------- OCB ----------

    async leerEstadoOcb(orderGuid: string): Promise<EstadoOcbOlo | null> {
        const e = this.s.estadosOcb.get(orderGuid);
        return e ? { ...e } : null;
    }

    async buscarEstadoOcbPorOrderId(orderIdString: string): Promise<EstadoOcbOlo | null> {
        const e = [...this.s.estadosOcb.values()].find(x => x.order_id_string === orderIdString);
        return e ? { ...e } : null;
    }

    async guardarEstadoOcb(estado: EstadoOcbOlo): Promise<void> {
        this.s.estadosOcb.set(estado.order_guid, { ...estado });
    }

    async estadosOcbVencidos(ahora: Date): Promise<EstadoOcbOlo[]> {
        return [...this.s.estadosOcb.values()]
            .filter(e => (e.hide_at && e.hide_at <= ahora) || (e.expire_at && e.expire_at <= ahora))
            .map(e => ({ ...e }));
    }

    async estadosOcbProgramados(): Promise<EstadoOcbOlo[]> {
        return [...this.s.estadosOcb.values()].filter(e => e.state === 'SCHEDULED').map(e => ({ ...e }));
    }

    async upsertOrdenOcb(orden: OrdenOcbDb): Promise<void> {
        const previa = this.s.ordenesOcb.get(orden.order_guid);
        const ahora = new Date();
        this.s.ordenesOcb.set(orden.order_guid, {
            ...orden,
            created_at: previa?.created_at ?? ahora,
            updated_at: ahora,
            items: orden.items.map(i => ({ ...i }))
        });
    }

    async borrarOrdenOcb(orderGuid: string): Promise<void> {
        this.s.ordenesOcb.delete(orderGuid);
    }

    async listarOrdenesOcb(restaurantGuid: string, businessDate: number): Promise<OrdenOcbDb[]> {
        return [...this.s.ordenesOcb.values()]
            .filter(o => o.restaurant_guid === restaurantGuid && o.business_date === businessDate)
            // Mismo orden que MySQL sobre VARCHAR: comparacion de texto.
            .sort((a, b) => (a.display_number < b.display_number ? -1 : a.display_number > b.display_number ? 1 : 0))
            .map(o => ({ ...o, items: o.items.map(i => ({ ...i })) }));
    }

    // ---------- solo para tests ----------

    /** Inspeccion directa para asserts, sin pasar por la API. */
    public get interno(): Readonly<Estado> {
        return this.caja.estado;
    }
}
