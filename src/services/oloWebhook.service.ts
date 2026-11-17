import { createHmac, timingSafeEqual } from 'crypto';
import { parsearJsonSeguro } from '../lib/ids';

/**
 * Firma y lectura de los webhooks de Olo (v1.0).
 *
 * El orden del mensaje no esta en la documentacion de Olo: sale del sample
 * oficial publico (Node), y el vector de prueba de abajo lo confirma.
 * [VALIDAR-CON-OLO] con un Test Event real.
 *
 *   firma = base64(HMAC-SHA256(secreto, url + LF + rawBody + LF + messageId + LF + timestamp))
 *
 * url es la Destination URL registrada en el Dashboard (OLO_WEBHOOK_URL), no la
 * que reconstruye el receptor: detras de un proxy el host o el esquema cambian
 * y la firma no cerraria nunca.
 */

export const CABECERAS = {
    tipo: 'x-olo-event-type',
    messageId: 'x-olo-message-id',
    timestamp: 'x-olo-timestamp',
    firma: 'x-olo-signature'
} as const;

export function firmarWebhook(secreto: string, url: string, rawBody: string, messageId: string, timestamp: string): string {
    return createHmac('sha256', Buffer.from(secreto, 'utf8'))
        .update([url, rawBody, messageId, timestamp].join('\n'), 'utf8')
        .digest('base64');
}

/** Compara en tiempo constante. Una firma de otro largo es invalida sin comparar. */
export function verificarFirmaWebhook(
    secreto: string,
    url: string,
    rawBody: string,
    messageId: string,
    timestamp: string,
    firmaRecibida: string
): boolean {
    if (!secreto || !firmaRecibida || !messageId || !timestamp) return false;
    const esperada = Buffer.from(firmarWebhook(secreto, url, rawBody, messageId, timestamp), 'utf8');
    const recibida = Buffer.from(firmaRecibida.trim(), 'utf8');
    if (esperada.length !== recibida.length) return false;
    return timingSafeEqual(esperada, recibida);
}

/** Eventos que la integracion usa. El resto se ignora con log debug. */
export const EVENTOS_STOCK = new Set(['MenuItemAvailabilityChanged']);
export const EVENTOS_MENU = new Set(['VendorMenuExportComplete']);
export const EVENTOS_TIENDA = new Set(['VendorAvailabilityChanged', 'VendorTemporarilyDisabled']);
export const EVENTOS_ORDEN = new Set([
    'OrderPlaced', 'OrderClosed', 'OrderPickedUp', 'OrderCancelled',
    'CustomerArrived', 'ScheduledOrderFired', 'ScheduledOrderFailed', 'OrderAdjusted'
]);

export function parsearCuerpo(rawBody: string): any {
    return parsearJsonSeguro(rawBody);
}

function texto(v: unknown): string | null {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
}

/**
 * Clave de ruteo de un evento: el id del restaurante como string.
 *   ordenes:                  vendorIdString ?? vendorId
 *   VendorMenuExportComplete: vendorId
 *   menu y vendor:            locationId (que es el VendorId)
 *
 * MenuItemAvailabilityChanged es un array y puede mezclar tiendas (un mass 86
 * de brand), asi que devuelve una clave por elemento: el receptor parte el
 * array y manda a cada tienda solo lo suyo.
 */
export function clavesDeRuteo(tipo: string, cuerpo: any): string[] {
    if (Array.isArray(cuerpo)) {
        const claves = cuerpo.map(e => texto(e?.locationId) ?? texto(e?.vendorId)).filter((c): c is string => c !== null);
        return [...new Set(claves)];
    }
    if (!cuerpo || typeof cuerpo !== 'object') return [];
    const clave = texto(cuerpo.vendorIdString) ?? texto(cuerpo.vendorId) ?? texto(cuerpo.locationId);
    return clave ? [clave] : [];
}

/** Para MenuItemAvailabilityChanged: los elementos del array que son de esa tienda. */
export function filtrarPorTienda(cuerpo: any[], clave: string): any[] {
    return cuerpo.filter(e => (texto(e?.locationId) ?? texto(e?.vendorId)) === clave);
}
