import type { ConfigOcb } from '../config/olo';
import type { ItemOrdenOcb, OrdenOcbDb } from '../almacen/tipos';
import { businessDateDeHoraOlo, parsearHoraOlo } from '../lib/tiempo';

/**
 * Transformaciones puras del Order Confirmation Board.
 *
 * Portado de formatModifiers / parseToastDate / determineOverallStatus del Java.
 * Copiado de ec4toast-node; al final se agrega el mapeo del Order de Olo.
 * Se separa del servicio para poder probarlo sin base de datos ni API.
 */

export interface ItemOcb {
    name: string;
    quantity: number;
    price: number;
    fulfillmentStatus: string;
    modifiers: string[];
}

function texto(nodo: any, campo: string, porDefecto = ""): string {
    const v = nodo?.[campo];
    return v === null || v === undefined ? porDefecto : String(v);
}

function numero(nodo: any, campo: string, porDefecto: number): number {
    const n = Number(nodo?.[campo]);
    return Number.isFinite(n) ? n : porDefecto;
}

/**
 * Agrupa los modificadores de una línea por su grupo:
 *   ["Box of 4: Chocolate, Vanilla", "Size: Large"]
 *
 * Si no hay nombres de grupo disponibles cae a una lista plana. Hoy es siempre
 * el caso: fetchModifierGroupNames en el Java devuelve un mapa vacío (quedó como
 * stub), así que el agrupado nunca llega a ejercitarse. Se porta igual, para que
 * el día que se resuelvan los nombres funcione sin tocar nada más.
 */
export function formatearModificadores(
    seleccion: any,
    nombresDeGrupo: Map<string, string>
): string[] {
    const porGrupo = new Map<string, string[]>();
    const PLANO = "__flat__";

    for (const mod of seleccion?.modifiers ?? []) {
        if (mod?.voided === true) continue;

        const nombreOpcion = texto(mod, 'displayName');
        const guidGrupo = texto(mod, 'modifierGroupGuid');
        const nombreGrupo = nombresDeGrupo.get(guidGrupo) ?? "";

        const clave = nombreGrupo || PLANO;
        if (!porGrupo.has(clave)) porGrupo.set(clave, []);
        porGrupo.get(clave)!.push(nombreOpcion);
    }

    if (porGrupo.size === 0) return [];

    // Todo cayó en el cajón sin grupo: lista plana.
    if (porGrupo.size === 1 && porGrupo.has(PLANO)) {
        return porGrupo.get(PLANO)!;
    }

    const resultado: string[] = [];
    for (const [grupo, opciones] of porGrupo) {
        const lista = opciones.join(", ");
        resultado.push(grupo === PLANO ? lista : `${grupo}: ${lista}`);
    }
    return resultado;
}

/** Las fechas de Toast vienen con +0000 en vez de Z. Devuelve null si no parsea. */
export function parsearFechaToast(valor: string | null | undefined): Date | null {
    if (!valor) return null;
    const fecha = new Date(valor.replace("+0000", "Z"));
    return Number.isNaN(fecha.getTime()) ? null : fecha;
}

/**
 * Estado de la orden a partir del de sus líneas:
 *   todas READY  → READY
 *   alguna SENT  → IN_PREPARATION
 *   si no        → RECEIVED
 */
export function determinarEstado(items: ItemOcb[]): string {
    if (items.length === 0) return "RECEIVED";

    const todasListas = items.every(i => i.fulfillmentStatus === "READY");
    if (todasListas) return "READY";

    const algunaEnviada = items.some(i => i.fulfillmentStatus === "SENT");
    return algunaEnviada ? "IN_PREPARATION" : "RECEIVED";
}

/** Extrae las líneas de una orden, saltando las anuladas. */
export function extraerItems(orden: any, nombresDeGrupo: Map<string, string>): {
    items: ItemOcb[];
    totalAmount: number;
    paymentStatus: string;
} {
    const items: ItemOcb[] = [];
    let totalAmount = 0;
    let paymentStatus = "OPEN";

    for (const check of orden?.checks ?? []) {
        // Igual que el Java: el último check gana. Con más de uno por orden esto
        // pierde información, pero cambiarlo alteraría los totales que ya se ven
        // en el board.
        totalAmount = numero(check, 'totalAmount', 0);
        paymentStatus = texto(check, 'paymentStatus', "OPEN");

        for (const sel of check?.selections ?? []) {
            if (sel?.voided === true) continue;

            items.push({
                name: texto(sel, 'displayName'),
                quantity: numero(sel, 'quantity', 1),
                price: numero(sel, 'price', 0),
                fulfillmentStatus: texto(sel, 'fulfillmentStatus', "NEW"),
                modifiers: formatearModificadores(sel, nombresDeGrupo)
            });
        }
    }

    return { items, totalAmount, paymentStatus };
}

/** businessDate de Toast: aaaammdd como entero. */
export function businessDateDeHoy(fecha = new Date()): number {
    const y = fecha.getFullYear();
    const m = String(fecha.getMonth() + 1).padStart(2, '0');
    const d = String(fecha.getDate()).padStart(2, '0');
    return Number(`${y}${m}${d}`);
}

// ================================================================
// OLO: del Order de los webhooks a la fila del board
// ================================================================
//
// Lo de arriba es el formato de Toast, copiado tal cual de ec4toast-node (sus
// tests siguen pasando). Lo de abajo arma la misma fila a partir del Order de
// Olo, para que determinarEstado devuelva el mismo status que con Toast.


/** Estado del board -> fulfillmentStatus de las lineas, como lo leeria determinarEstado. */
export function fulfillmentDeEstado(status: string): string {
    if (status === 'READY' || status === 'PICKED_UP') return 'READY';
    if (status === 'IN_PREPARATION') return 'SENT';
    return 'NEW';
}

/** Descripciones de los modificadores, incluidos los anidados, en orden. */
export function modificadoresOlo(nodo: any): string[] {
    const salida: string[] = [];
    for (const m of nodo?.modifiers ?? []) {
        const d = texto(m, 'description') || texto(m, 'name');
        if (d) salida.push(d);
        salida.push(...modificadoresOlo(m));
    }
    return salida;
}

/** Numero visible. [VALIDAR-CON-OLO] cual es el campo que ve el cliente. */
export function numeroVisible(order: any, fuente: ConfigOcb['displayNumberSource']): string {
    const idString = texto(order, 'orderIdString') || texto(order, 'orderId');
    const ultimos4 = idString ? idString.slice(-4) : '';
    if (fuente === 'firstName') return texto(order?.customer, 'firstName') || ultimos4;
    if (fuente === 'orderIdString') return ultimos4;
    return texto(order, 'posRef') || ultimos4;
}

/** "OPEN" si se paga en la tienda, "PAID" si no. [PEDIR-A-ANDRES] */
export function estadoDePago(order: any): string {
    const pagos: any[] = Array.isArray(order?.payments) ? order.payments : [];
    return pagos.some(p => String(p?.type ?? '').toLowerCase() === 'instore') ? 'OPEN' : 'PAID';
}

function totalDe(order: any): number {
    for (const v of [order?.totals?.total, order?.total, order?.totals?.subTotal]) {
        const n = Number(v);
        if (v !== undefined && v !== null && Number.isFinite(n)) return n;
    }
    return 0;
}

/**
 * Fila de ocb_orders para un Order de Olo. Sin PII: el nombre del cliente solo
 * entra como display_number si la tienda lo configura.
 *
 * business_date: fecha local de timePlaced, salvo en ordenes programadas, que
 * usan la de timeWanted. Una orden pedida a las 10 pm para el desayuno de
 * manana tiene que aparecer en el board de manana, no en el de hoy.
 */
export function mapearOrdenOlo(
    order: any,
    status: string,
    cfg: ConfigOcb,
    tz: string,
    programada = false
): OrdenOcbDb {
    const zona = texto(order, 'storeTimeZone') || tz;
    const fulfillment = fulfillmentDeEstado(status);
    const placed = texto(order, 'timePlaced');
    const wanted = texto(order, 'timeWanted');
    const fechaNegocio =
        (programada ? businessDateDeHoraOlo(wanted) : null) ??
        businessDateDeHoraOlo(placed) ??
        businessDateDeHoraOlo(wanted) ??
        0;

    const items: ItemOrdenOcb[] = (Array.isArray(order?.items) ? order.items : []).map((it: any) => ({
        name: (texto(it, 'description') || texto(it, 'name')).substring(0, 500),
        quantity: numero(it, 'quantity', 1),
        price: numero(it, 'sellingPrice', numero(it, 'totalCost', 0)),
        fulfillment_status: fulfillment,
        modifiers: modificadoresOlo(it).join(',').substring(0, 2000)
    }));

    return {
        order_guid: texto(order, 'id'),
        display_number: numeroVisible(order, cfg.displayNumberSource).substring(0, 50),
        status,
        restaurant_guid: texto(order, 'vendorIdString') || texto(order, 'vendorId'),
        opened_date: parsearHoraOlo(placed, zona),
        estimated_fulfillment_date: parsearHoraOlo(texto(order, 'timeReady') || wanted, zona),
        total_amount: totalDe(order),
        payment_status: estadoDePago(order),
        business_date: fechaNegocio,
        items
    };
}
