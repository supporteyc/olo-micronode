import { parsearJsonSeguro } from '../lib/ids';

/**
 * Estado de la tienda completa en Olo (no de items).
 *
 * VendorAvailabilityChanged (Online/Offline, con unos 5 min de demora) y
 * VendorTemporarilyDisabled (Enabled/Disabled) describen la tienda entera. Se
 * guardan y se exponen en /api/status como health.storeOnline, pero NUNCA se
 * traducen a in_stock: una tienda que cierra temprano no tiene el menu agotado,
 * y marcar todo en No dejaria la pantalla llena de "sold out" por un rato.
 *
 * Vive en memoria: al reiniciar se pide GET /restaurants/{id} para partir de
 * un valor real en vez de null.
 */
export class StoreHealthService {
    public online: boolean | null = null;
    public deshabilitada: boolean | null = null;
    public ultimoCambio: Date | null = null;
    public fuente: string | null = null;

    /** storeOnline para /api/status: false si esta offline O deshabilitada. */
    public get storeOnline(): boolean | null {
        if (this.online === null && this.deshabilitada === null) return null;
        if (this.deshabilitada === true) return false;
        return this.online ?? true;
    }

    public aplicarEvento(tipo: string, cuerpo: any, ahora = new Date()): boolean {
        if (tipo === 'VendorAvailabilityChanged') {
            const estado = String(cuerpo?.newStatus ?? '').toLowerCase();
            if (estado !== 'online' && estado !== 'offline') return false;
            this.online = estado === 'online';
            this.registrar(tipo, ahora);
            const log = this.online ? console.log : console.warn;
            log(`🏪 Tienda ${this.online ? 'ONLINE' : 'OFFLINE'} en Olo (VendorAvailabilityChanged). El stock no se toca.`);
            return true;
        }
        if (tipo === 'VendorTemporarilyDisabled') {
            const cambio = String(cuerpo?.change ?? cuerpo?.vendorStatus ?? '').toLowerCase();
            if (cambio !== 'enabled' && cambio !== 'disabled') return false;
            this.deshabilitada = cambio === 'disabled';
            this.registrar(tipo, ahora);
            const log = this.deshabilitada ? console.warn : console.log;
            log(`🏪 Tienda ${this.deshabilitada ? 'DESHABILITADA' : 'HABILITADA'} en Olo. El stock no se toca.`);
            return true;
        }
        return false;
    }

    /** Valor inicial desde GET /restaurants/{id} (isavailable). Best effort. */
    public inicializarDesdeRestaurante(raw: string, ahora = new Date()): void {
        try {
            const r = parsearJsonSeguro(raw);
            if (typeof r?.isavailable === 'boolean') {
                this.online = r.isavailable;
                this.registrar('GET /restaurants', ahora);
            }
        } catch { /* best effort */ }
    }

    private registrar(fuente: string, ahora: Date) {
        this.ultimoCambio = ahora;
        this.fuente = fuente;
    }

    public resumen() {
        return {
            storeOnline: this.storeOnline,
            online: this.online,
            disabled: this.deshabilitada,
            lastChangeAt: this.ultimoCambio?.toISOString() ?? null,
            source: this.fuente
        };
    }
}
