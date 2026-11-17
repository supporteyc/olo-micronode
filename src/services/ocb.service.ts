import type { Almacen, EstadoOcbOlo, OrdenOcbDb } from '../almacen/tipos';
import type { ConfigOcb } from '../config/olo';
import { businessDateEnZona, parsearHoraOlo, sumarMinutos } from '../lib/tiempo';
import { idComoTexto } from '../lib/ids';
import { mapearOrdenOlo, type ItemOcb } from './ocbFormat.service';

/**
 * Order Confirmation Board alimentado por webhooks de Olo.
 *
 * Con Toast el GET hacia pull de ordersBulk y escribia. Con Olo los webhooks
 * escriben ocb_orders y el GET solo lee (y corre el barrido). La respuesta del
 * GET es exactamente la RespuestaOcb de ec4toast-node.
 *
 * El estado interno vive en ocb_olo_state; ocb_orders es solo lo que se ve.
 * Una orden que ya no debe verse se BORRA de ocb_orders, como hoy con voided.
 */

export interface OrdenOcb {
    orderGuid: string;
    displayNumber: string;
    status: string;
    openedDate: string | null;
    estimatedFulfillmentDate: string | null;
    totalAmount: number;
    paymentStatus: string | null;
    items: ItemOcb[];
}

/** Forma real de ec4toast-node (ocb.service.ts). Es contrato con la pantalla. */
export interface RespuestaOcb {
    restaurantGuid: string;
    generatedAt: string;
    totalOrders: number;
    receivedCount: number;
    inPreparationCount: number;
    readyCount: number;
    orders: OrdenOcb[];
}

export type EstadoInterno =
    'SCHEDULED' | 'PLACED' | 'READY_WINDOW' | 'PICKED_UP' | 'CANCELLED' | 'REPLACED' | 'EXPIRED' | 'HIDDEN';

/** El estado nunca baja de rango. */
export const RANGO: Record<EstadoInterno, number> = {
    SCHEDULED: 0,
    PLACED: 1,
    READY_WINDOW: 2,
    PICKED_UP: 3,
    CANCELLED: 3,
    REPLACED: 3,
    EXPIRED: 3,
    HIDDEN: 3
};

const EVENTO_A_ESTADO: Record<string, EstadoInterno | null> = {
    OrderPlaced: 'PLACED',            // o SCHEDULED, se decide con los tiempos
    ScheduledOrderFired: 'PLACED',
    OrderClosed: 'READY_WINDOW',
    OrderPickedUp: 'PICKED_UP',
    OrderCancelled: 'CANCELLED',
    CustomerArrived: null,
    OrderAdjusted: null,
    ScheduledOrderFailed: null
};

export interface ContextoOcb {
    cfg: ConfigOcb;
    tz: string;
    ahora: Date;
}

/** Hora de un campo del payload: "yyyymmdd hh:mm" local, o ISO como respaldo. */
export function horaDelPayload(valor: unknown, tz: string): Date | null {
    const local = parsearHoraOlo(valor, tz);
    if (local) return local;
    if (typeof valor === 'string' && /\d{4}-\d{2}-\d{2}T/.test(valor)) {
        const d = new Date(valor);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
}

/** Programada si entre que se pidio y para cuando se quiere hay mas que el umbral. */
export function esProgramada(order: any, ctx: ContextoOcb): boolean {
    const tz = String(order?.storeTimeZone || ctx.tz);
    const placed = horaDelPayload(order?.timePlaced, tz);
    const wanted = horaDelPayload(order?.timeWanted, tz);
    if (!placed || !wanted) return false;
    return (wanted.getTime() - placed.getTime()) / 60000 > ctx.cfg.advanceThresholdMin;
}

function estadoVacio(guid: string, ahora: Date): EstadoOcbOlo {
    return {
        order_guid: guid,
        state: 'HIDDEN',
        state_rank: -1,
        order_id_string: null,
        vendor_id_string: null,
        pos_ref: null,
        time_wanted: null,
        visible_since: null,
        closed_at: null,
        arrived_at: null,
        picked_up_at: null,
        cancelled_at: null,
        hide_at: null,
        expire_at: null,
        replaces_guid: null,
        replaced_by_guid: null,
        board_snapshot: null,
        updated_at: ahora
    };
}

export interface Transicion {
    estado: EstadoOcbOlo;
    /** Que hacer con la fila de ocb_orders. */
    fila: { accion: 'upsert'; orden: OrdenOcbDb } | { accion: 'borrar' } | { accion: 'nada' };
    nota: string;
}

/** Status visible para cada estado interno. null = no se muestra. */
function statusVisible(estado: EstadoInterno, ctx: ContextoOcb): string | null {
    switch (estado) {
        case 'PLACED': return ctx.cfg.placedStatus;
        case 'READY_WINDOW': return ctx.cfg.showReadyOnClosed ? 'READY' : ctx.cfg.placedStatus;
        case 'PICKED_UP': return ctx.cfg.extendedStatus ? 'PICKED_UP' : 'READY';
        case 'CANCELLED': return ctx.cfg.extendedStatus ? 'CANCELLED' : null;
        default: return null;
    }
}

/**
 * La maquina de estados, pura: estado previo + evento -> estado nuevo y que
 * hacer con la fila del board. Sin base ni reloj propio, para probar cada
 * regla de la seccion 8.3 por separado.
 */
export function calcularTransicion(
    previo: EstadoOcbOlo | null,
    tipo: string,
    order: any,
    ctx: ContextoOcb
): Transicion {
    const { ahora, cfg } = ctx;
    const tz = String(order?.storeTimeZone || ctx.tz);
    const guid = String(order?.id);
    const e: EstadoOcbOlo = previo ? { ...previo } : estadoVacio(guid, ahora);
    e.updated_at = ahora;
    e.order_id_string ??= idComoTexto(order?.orderIdString) ?? idComoTexto(order?.orderId);
    e.vendor_id_string ??= idComoTexto(order?.vendorIdString) ?? idComoTexto(order?.vendorId);
    e.pos_ref = (order?.posRef ? String(order.posRef) : e.pos_ref)?.substring(0, 64) ?? null;
    e.time_wanted = horaDelPayload(order?.timeWanted, tz) ?? e.time_wanted;

    // Se mira el rango guardado y no RANGO[state]: un estado recien creado (el
    // de la orden nueva en un reemplazo) es HIDDEN con rango -1, y no es terminal.
    if (previo && previo.state_rank >= 3) {
        return { estado: e, fila: { accion: 'nada' }, nota: `${tipo} ignorado: la orden ya esta en ${previo.state}` };
    }

    // Destino segun el evento. Un evento sin destino propio (CustomerArrived,
    // OrderAdjusted) sobre una orden que no conocemos la crea como un
    // OrderPlaced: cualquier evento trae el Order completo.
    let destino: EstadoInterno | null = EVENTO_A_ESTADO[tipo] ?? null;
    if (tipo === 'OrderPlaced' || (destino === null && !previo && tipo !== 'ScheduledOrderFailed')) {
        destino = esProgramada(order, ctx) ? 'SCHEDULED' : 'PLACED';
    }

    if (tipo === 'CustomerArrived') {
        e.arrived_at = horaDelPayload(order?.arrivalDetails?.timeArrived, tz) ?? ahora;
    }

    const rangoPrevio = previo ? previo.state_rank : -1;
    if (destino !== null && RANGO[destino] >= rangoPrevio) {
        if (!(previo && destino === previo.state)) e.state = destino;
        e.state_rank = RANGO[e.state as EstadoInterno];
    }
    const estado = e.state as EstadoInterno;

    // Horas y retiros por estado.
    if (estado !== 'SCHEDULED' && estado !== 'HIDDEN') {
        e.visible_since ??= ahora;
        e.expire_at ??= sumarMinutos(e.visible_since, cfg.maxTtlMin);
    }
    if (estado === 'READY_WINDOW' && tipo === 'OrderClosed') {
        e.closed_at = horaDelPayload(order?.timeReady, tz) ?? ahora;
        if (cfg.hideOnClosedAfterMin !== null) e.hide_at = sumarMinutos(e.closed_at, cfg.hideOnClosedAfterMin);
    }
    if (estado === 'PICKED_UP' && tipo === 'OrderPickedUp') {
        e.picked_up_at = horaDelPayload(order?.pickUpDetails?.timePickedUp, tz) ?? ahora;
        e.hide_at = sumarMinutos(e.picked_up_at, cfg.pickedUpHideAfterMin);
    }
    if (estado === 'CANCELLED' && tipo === 'OrderCancelled') {
        e.cancelled_at = horaDelPayload(order?.timeCancelled, tz) ?? ahora;
        e.hide_at = cfg.extendedStatus ? sumarMinutos(e.cancelled_at, cfg.cancelledHideAfterMin) : ahora;
    }

    const status = statusVisible(estado, ctx);
    const vencida = (e.hide_at !== null && e.hide_at <= ahora) || (e.expire_at !== null && e.expire_at <= ahora);
    // Una orden que fue programada usa la fecha de timeWanted como business_date.
    const programada = estado === 'SCHEDULED' || previo?.state === 'SCHEDULED';
    const orden = mapearOrdenOlo(order, status ?? cfg.placedStatus, cfg, ctx.tz, programada);

    if (estado === 'SCHEDULED') {
        e.board_snapshot = JSON.stringify(orden);
        return { estado: e, fila: { accion: 'nada' }, nota: 'orden programada: no se muestra todavia' };
    }
    e.board_snapshot = null;

    if (status === null || vencida) {
        // Un evento terminal tardio cuyo hide_at ya paso nunca aparece.
        return { estado: e, fila: { accion: 'borrar' }, nota: `${tipo}: fuera del board` };
    }
    return { estado: e, fila: { accion: 'upsert', orden }, nota: `${tipo}: ${status}` };
}

export interface ResultadoOcb {
    duplicado: boolean;
    nota: string;
}

export class OcbService {

    constructor(
        private almacen: Almacen,
        private cfg: ConfigOcb,
        private tz: string,
        private vendorId: string,
        private reloj: () => Date = () => new Date()
    ) {}

    private ctx(): ContextoOcb {
        return { cfg: this.cfg, tz: this.tz, ahora: this.reloj() };
    }

    private metodoVisible(order: any): boolean {
        if (this.cfg.deliveryMethods.length === 0) return true;
        const metodo = String(order?.deliveryMethod ?? '').toLowerCase();
        return metodo === '' || this.cfg.deliveryMethods.includes(metodo);
    }

    /**
     * Aplica un evento de orden. El INSERT en olo_webhook_events y el cambio de
     * estado van en una sola transaccion: clave duplicada = ya procesado.
     */
    public async procesarEvento(tipo: string, messageId: string, order: any): Promise<ResultadoOcb> {
        const guid = order?.id ? String(order.id) : '';
        if (!guid) return { duplicado: false, nota: `${tipo} sin Order.id: ignorado` };
        const ctx = this.ctx();

        return this.almacen.transaccion(async tx => {
            const nuevo = await tx.registrarEvento({ message_id: messageId, event_type: tipo, entity_key: guid.substring(0, 64) });
            if (!nuevo) return { duplicado: true, nota: 'duplicado' };

            let previo = await tx.leerEstadoOcb(guid);

            // Lapida: el reemplazo llego antes que el original.
            if (!previo) {
                const idString = idComoTexto(order?.orderIdString) ?? idComoTexto(order?.orderId);
                const lapida = idString ? await tx.buscarEstadoOcbPorOrderId(idString) : null;
                if (lapida?.state === 'REPLACED') {
                    return { duplicado: false, nota: `${tipo} ignorado: la orden ya fue reemplazada` };
                }
            }

            if (!previo && !this.metodoVisible(order)) {
                const oculto = estadoVacio(guid, ctx.ahora);
                oculto.state = 'HIDDEN';
                oculto.state_rank = RANGO.HIDDEN;
                await tx.guardarEstadoOcb(oculto);
                return { duplicado: false, nota: `deliveryMethod ${order?.deliveryMethod} no se muestra en el board` };
            }

            if (tipo === 'OrderPlaced' && order?.isReplacement === true) {
                await this.reemplazar(tx, order, guid, ctx.ahora);
                previo = await tx.leerEstadoOcb(guid);
            }

            const t = calcularTransicion(previo, tipo, order, ctx);
            await tx.guardarEstadoOcb(t.estado);
            if (t.fila.accion === 'upsert') await tx.upsertOrdenOcb(t.fila.orden);
            if (t.fila.accion === 'borrar') await tx.borrarOrdenOcb(guid);
            return { duplicado: false, nota: t.nota };
        });
    }

    /**
     * Una orden modificada NO genera OrderCancelled: llega un OrderPlaced con
     * isReplacement y replacementDetails.originalId. La original sale del board.
     * Si la original aun no llego, se deja una lapida para que no reviva.
     *
     * [VALIDAR-CON-OLO] si originalId es el Order.id (uuid) o el orderId numerico:
     * se busca por los dos.
     */
    private async reemplazar(tx: Almacen, order: any, nuevoGuid: string, ahora: Date) {
        const originalId = idComoTexto(order?.replacementDetails?.originalId);
        if (!originalId) return;

        const original = (await tx.leerEstadoOcb(originalId)) ?? (await tx.buscarEstadoOcbPorOrderId(originalId));
        const lapida = original ? { ...original } : estadoVacio(
            /^\d+$/.test(originalId) ? `orderid:${originalId}` : originalId, ahora);
        if (!original && /^\d+$/.test(originalId)) lapida.order_id_string = originalId;

        lapida.state = 'REPLACED';
        lapida.state_rank = RANGO.REPLACED;
        lapida.replaced_by_guid = nuevoGuid;
        lapida.hide_at = null;
        lapida.expire_at = null;
        lapida.board_snapshot = null;
        lapida.updated_at = ahora;
        await tx.guardarEstadoOcb(lapida);
        await tx.borrarOrdenOcb(lapida.order_guid);

        const nuevo = (await tx.leerEstadoOcb(nuevoGuid)) ?? estadoVacio(nuevoGuid, ahora);
        nuevo.replaces_guid = lapida.order_guid;
        await tx.guardarEstadoOcb(nuevo);
    }

    /**
     * Barrido: retira lo vencido (hide_at o expire_at) y promueve las
     * programadas a las que les llego la hora sin ScheduledOrderFired.
     * Corre cada OCB_SWEEP_INTERVAL_MS y en cada GET.
     */
    public async barrer(): Promise<{ retiradas: number; promovidas: number }> {
        const ahora = this.reloj();
        let retiradas = 0;
        let promovidas = 0;

        for (const e of await this.almacen.estadosOcbVencidos(ahora)) {
            await this.almacen.transaccion(async tx => {
                const vencidaPorTtl = e.expire_at !== null && e.expire_at <= ahora && !(e.hide_at && e.hide_at <= ahora);
                const actualizado: EstadoOcbOlo = {
                    ...e,
                    state: e.state_rank >= 3 ? e.state : (vencidaPorTtl ? 'EXPIRED' : 'HIDDEN'),
                    state_rank: 3,
                    hide_at: null,
                    expire_at: null,
                    updated_at: ahora
                };
                await tx.guardarEstadoOcb(actualizado);
                await tx.borrarOrdenOcb(e.order_guid);
            });
            retiradas++;
        }

        for (const e of await this.almacen.estadosOcbProgramados()) {
            if (!e.time_wanted || !e.board_snapshot) continue;
            const momento = sumarMinutos(e.time_wanted, -this.cfg.advanceThresholdMin);
            if (momento > ahora) continue;

            await this.almacen.transaccion(async tx => {
                const orden: OrdenOcbDb = JSON.parse(e.board_snapshot!, (k, v) =>
                    (k === 'opened_date' || k === 'estimated_fulfillment_date') && v ? new Date(v) : v);
                orden.status = this.cfg.placedStatus;
                for (const i of orden.items) i.fulfillment_status = orden.status === 'IN_PREPARATION' ? 'SENT' : 'NEW';
                await tx.guardarEstadoOcb({
                    ...e,
                    state: 'PLACED',
                    state_rank: RANGO.PLACED,
                    visible_since: ahora,
                    expire_at: sumarMinutos(ahora, this.cfg.maxTtlMin),
                    board_snapshot: null,
                    updated_at: ahora
                });
                await tx.upsertOrdenOcb(orden);
            });
            console.warn(`OCB: orden programada ${e.order_guid} promovida sin ScheduledOrderFired`);
            promovidas++;
        }

        return { retiradas, promovidas };
    }

    /**
     * El board. Mismos parametros que ec4toast-node; el dia por defecto es el de
     * la tienda (OLO_STORE_TIMEZONE), no el del servidor.
     */
    public async getOrderStatusBoard(restaurantId?: string, businessDate?: number): Promise<RespuestaOcb> {
        await this.barrer();

        const restaurantGuid = restaurantId || this.vendorId;
        const dia = businessDate ?? businessDateEnZona(this.reloj(), this.tz);
        const filas = await this.almacen.listarOrdenesOcb(restaurantGuid, dia);

        const orders: OrdenOcb[] = filas.map(f => ({
            orderGuid: f.order_guid,
            displayNumber: f.display_number,
            status: f.status,
            openedDate: f.opened_date ? f.opened_date.toISOString() : null,
            estimatedFulfillmentDate: f.estimated_fulfillment_date ? f.estimated_fulfillment_date.toISOString() : null,
            totalAmount: f.total_amount,
            paymentStatus: f.payment_status,
            items: f.items.map(i => ({
                name: i.name,
                quantity: i.quantity,
                price: i.price,
                fulfillmentStatus: i.fulfillment_status,
                modifiers: i.modifiers ? i.modifiers.split(",").filter(m => m.length > 0) : []
            }))
        }));

        const cuenta = (estado: string) => orders.filter(o => o.status === estado).length;

        return {
            restaurantGuid,
            generatedAt: new Date().toISOString(),
            totalOrders: orders.length,
            receivedCount: cuenta("RECEIVED"),
            inPreparationCount: cuenta("IN_PREPARATION"),
            readyCount: cuenta("READY"),
            orders
        };
    }
}
