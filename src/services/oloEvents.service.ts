import type { Almacen } from '../almacen/tipos';
import type { ConfigOlo } from '../config/olo';
import { idComoTexto } from '../lib/ids';
import type { AvailabilityService } from './availability.service';
import type { MenuSyncService } from './menuSync.service';
import type { OcbService } from './ocb.service';
import type { StoreHealthService } from './storeHealth.service';
import { EVENTOS_MENU, EVENTOS_ORDEN, EVENTOS_STOCK, EVENTOS_TIENDA, parsearCuerpo } from './oloWebhook.service';

/**
 * Lo que hace ec4olo-node con un evento que le reenvia el receptor
 * (POST /api/olo/events). La firma de Olo ya la verifico el receptor; aca se
 * confia en el X-EC4-Key de serviceAuth.
 *
 * Responde 200 solo cuando el efecto quedo escrito: si algo falla devuelve 500
 * y el receptor reintenta. La idempotencia por message id evita el doble efecto.
 */

export interface EventoEntrante {
    tipo: string;
    messageId: string;
    rawBody: string;
}

export interface RespuestaEvento {
    status: number;
    body: Record<string, unknown>;
}

export interface DepsEventos {
    almacen: Almacen;
    cfg: ConfigOlo;
    menuSync: MenuSyncService;
    availability: AvailabilityService;
    ocb: OcbService;
    storeHealth: StoreHealthService;
}

export class OloEventsService {

    constructor(private d: DepsEventos) {}

    public async procesar(evento: EventoEntrante): Promise<RespuestaEvento> {
        const { tipo, messageId } = evento;
        if (!tipo || !messageId) {
            return { status: 400, body: { error: 'Faltan X-Olo-Event-Type o X-Olo-Message-Id' } };
        }

        let cuerpo: any;
        try {
            cuerpo = parsearCuerpo(evento.rawBody);
        } catch {
            // 400 y no 500: reintentar un JSON roto no lo arregla.
            console.warn(`Evento ${tipo} (${messageId}) con JSON ilegible: descartado`);
            return { status: 400, body: { error: 'JSON ilegible' } };
        }

        this.d.menuSync.estado.lastWebhookAt = new Date();

        if (tipo === 'Test') {
            return { status: 200, body: { ok: true, message: 'Test recibido' } };
        }

        if (EVENTOS_STOCK.has(tipo)) {
            const r = await this.d.availability.aplicar(messageId, cuerpo);
            return { status: 200, body: { ok: true, ...r } };
        }

        if (EVENTOS_ORDEN.has(tipo)) {
            const r = await this.d.ocb.procesarEvento(tipo, messageId, cuerpo);
            return { status: 200, body: { ok: true, ...r } };
        }

        if (EVENTOS_MENU.has(tipo)) {
            return this.exportCompleto(messageId, cuerpo);
        }

        if (EVENTOS_TIENDA.has(tipo)) {
            const nuevo = await this.d.almacen.registrarEvento({
                message_id: messageId, event_type: tipo, entity_key: this.d.cfg.vendorId
            });
            if (nuevo) this.d.storeHealth.aplicarEvento(tipo, cuerpo);
            return { status: 200, body: { ok: true, duplicado: !nuevo } };
        }

        console.debug?.(`Evento ${tipo} ignorado (no lo usa esta integracion)`);
        return { status: 200, body: { ok: true, ignorado: true } };
    }

    /**
     * VendorMenuExportComplete: si el menu cambio, importar. La importacion
     * tarda (descarga + zip), asi que corre en segundo plano y se responde 202:
     * el receptor no tiene por que esperarla. Si falla, el respaldo diario y el
     * proximo export la cubren.
     */
    private async exportCompleto(messageId: string, cuerpo: any): Promise<RespuestaEvento> {
        const vendor = idComoTexto(cuerpo?.vendorId);
        if (vendor !== this.d.cfg.vendorId) {
            return { status: 200, body: { ok: true, ignorado: true, motivo: 'otra tienda' } };
        }
        const nuevo = await this.d.almacen.registrarEvento({
            message_id: messageId, event_type: 'VendorMenuExportComplete', entity_key: vendor,
            note: `hasMenuChanges=${cuerpo?.hasMenuChanges}`
        });
        if (!nuevo) return { status: 200, body: { ok: true, duplicado: true } };

        if (cuerpo?.hasMenuChanges !== true) {
            console.log('📦 VendorMenuExportComplete sin cambios de menu: no se importa.');
            return { status: 200, body: { ok: true, importa: false } };
        }

        console.log('📦 VendorMenuExportComplete con cambios de menu: se importa.');
        void this.d.menuSync.importar(this.d.cfg.webhookTriggerSource);
        return { status: 202, body: { ok: true, importa: true } };
    }
}
