import type { FilaConOrden } from '../services/menuDiff.service';
import type { EntradaHistorial } from '../services/changeLog.service';

/**
 * El contrato de datos del servicio, separado de MySQL.
 *
 * En ec4toast-node cada servicio tenia su propio new PrismaClient() (cuatro
 * pools de conexiones contra la misma base) y la logica solo se podia probar
 * con MySQL corriendo. Aca la logica habla con esta interfaz, y hay dos
 * implementaciones con el mismo comportamiento:
 *
 *   - AlmacenPrisma: produccion, sobre el esquema real (sql/001 a 004).
 *   - AlmacenMemoria: tests y modo mock, sin base.
 *
 * Las tablas, columnas y semantica son las mismas que en ec4toast-node. Lo que
 * cambia es solo por donde pasa el acceso.
 */

/** Espejo de la fila de menu_items (mismo nombre y tipo de cada columna). */
export interface ItemMenu {
    id: bigint;
    pos_id: string;
    menu: string;
    item_type: string;
    category: string | null;
    parent_group: string | null;
    name: string;
    description: string | null;
    price: string | null;
    in_stock: boolean | null;
    out_of_stock_icon: string | null;
    sort_order: number | null;
    menu_number: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    last_synced_to_onsign: Date | null;
    is_active: boolean | null;
    toast_last_modified: Date | null;
    onsign_row_id: string | null;
    onsign_version: number | null;
    miss_count: number;
}

export interface CambioStock {
    pos_id: string;
    in_stock: boolean;
}

export type EstadoRun = 'ok' | 'error' | 'skipped';
export type OrigenRun = 'scheduler' | 'manual' | 'webhook';

/** Espejo de la fila de sync_runs. */
export interface FilaRun {
    id?: bigint;
    started_at: Date;
    finished_at: Date | null;
    duration_ms: number | null;
    status: string;
    trigger_source: string;
    reason: string | null;
    source_items: number;
    inventory_guids: number | null;
    sold_out_items: number;
    db_created: number;
    db_updated: number;
    db_deleted: number;
    db_unchanged: number;
    changes_logged: number;
    error_message: string | null;
}

export interface FilaHistorial extends EntradaHistorial {
    id: bigint;
    changed_at: Date;
}

export interface EventoWebhook {
    message_id: string;
    event_type: string;
    entity_key: string | null;
    applied?: boolean;
    note?: string | null;
}

export interface Pendiente {
    pos_id: string;
    in_stock: boolean;
    received_at: Date;
}

/** Espejo de ocb_olo_state. */
export interface EstadoOcbOlo {
    order_guid: string;
    state: string;
    state_rank: number;
    order_id_string: string | null;
    vendor_id_string: string | null;
    pos_ref: string | null;
    time_wanted: Date | null;
    visible_since: Date | null;
    closed_at: Date | null;
    arrived_at: Date | null;
    picked_up_at: Date | null;
    cancelled_at: Date | null;
    hide_at: Date | null;
    expire_at: Date | null;
    replaces_guid: string | null;
    replaced_by_guid: string | null;
    /** JSON de OrdenOcbDb, sin PII. Para armar la fila de una orden programada. */
    board_snapshot: string | null;
    updated_at: Date;
}

export interface ItemOrdenOcb {
    name: string;
    quantity: number;
    price: number;
    fulfillment_status: string;
    modifiers: string;
}

/** Espejo de ocb_orders + sus ocb_order_items. */
export interface OrdenOcbDb {
    order_guid: string;
    display_number: string;
    status: string;
    restaurant_guid: string;
    opened_date: Date | null;
    estimated_fulfillment_date: Date | null;
    total_amount: number;
    payment_status: string | null;
    business_date: number;
    created_at?: Date | null;
    updated_at?: Date | null;
    items: ItemOrdenOcb[];
}

export interface Almacen {
    /** Corre fn de forma atomica: si lanza, no queda ninguna escritura. */
    transaccion<T>(fn: (tx: Almacen) => Promise<T>): Promise<T>;

    // ---------- menu_items ----------
    findAllIndexed(): Promise<Map<string, ItemMenu>>;
    findActiveItemsSorted(): Promise<ItemMenu[]>;
    /** Solo toca columnas del sync; con preservarStock no escribe in_stock ni out_of_stock_icon. */
    upsertFilas(filas: FilaConOrden[], preservarStock: boolean, detectadoEn: Date): Promise<number>;
    borrarPorId(ids: bigint[]): Promise<number>;
    /** Escribe in_stock (y updated_at, toast_last_modified) solo en las filas dadas. */
    escribirStock(cambios: CambioStock[], detectadoEn: Date): Promise<number>;
    contarResumen(): Promise<{ total: number; activos: number; agotados: number }>;

    // ---------- menu_item_changes ----------
    registrarHistorial(entradas: EntradaHistorial[]): Promise<number>;
    listarHistorial(limite: number, posId?: string): Promise<FilaHistorial[]>;

    // ---------- sync_runs ----------
    guardarRun(fila: FilaRun): Promise<void>;
    listarRuns(limite: number, status?: EstadoRun): Promise<FilaRun[]>;
    ultimoRun(): Promise<FilaRun | null>;
    ultimoRunOk(): Promise<FilaRun | null>;

    // ---------- olo_webhook_events ----------
    /** false si el message_id ya existia (evento duplicado). */
    registrarEvento(evento: EventoWebhook): Promise<boolean>;
    purgarEventos(antesDe: Date): Promise<number>;

    // ---------- olo_pending_availability ----------
    guardarPendientes(cambios: CambioStock[], recibidoEn: Date): Promise<void>;
    listarPendientes(): Promise<Pendiente[]>;
    borrarPendientes(posIds?: string[]): Promise<void>;

    // ---------- OCB ----------
    leerEstadoOcb(orderGuid: string): Promise<EstadoOcbOlo | null>;
    buscarEstadoOcbPorOrderId(orderIdString: string): Promise<EstadoOcbOlo | null>;
    guardarEstadoOcb(estado: EstadoOcbOlo): Promise<void>;
    estadosOcbVencidos(ahora: Date): Promise<EstadoOcbOlo[]>;
    estadosOcbProgramados(): Promise<EstadoOcbOlo[]>;
    /** Upsert por order_guid; los items se reemplazan enteros. */
    upsertOrdenOcb(orden: OrdenOcbDb): Promise<void>;
    borrarOrdenOcb(orderGuid: string): Promise<void>;
    listarOrdenesOcb(restaurantGuid: string, businessDate: number): Promise<OrdenOcbDb[]>;
}
