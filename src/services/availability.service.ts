import type { Almacen, CambioStock, ItemMenu } from '../almacen/tipos';
import type { ConfigOlo } from '../config/olo';
import type { Mutex } from '../lib/mutex';
import { idComoTexto } from '../lib/ids';
import { changeLogService, type EntradaHistorial } from './changeLog.service';
import type { StockEstado } from './stockEstado';

/**
 * Deltas de stock por webhook (MenuItemAvailabilityChanged).
 *
 * Es lo que reemplaza la espera de hasta 78 s de Toast: un 86 en la tienda
 * llega como webhook y se aplica en segundos. La reconciliacion periodica
 * (menuSync.reconciliar) repara lo que estos deltas no alcanzan: webhooks
 * perdidos, duplicados que ya se filtraron y llegadas fuera de orden.
 */

/** pos_id de un elemento del webhook. Product -> id; Choice -> id + "__mod". null si no se reconoce. */
export function posIdDeDelta(item: any): string | null {
    let id: string | null;
    try {
        id = idComoTexto(item?.itemEntityId);
    } catch {
        return null;
    }
    if (!id) return null;
    const tipo = String(item?.itemEntityType ?? '').toLowerCase();
    if (tipo === 'product') return id;
    if (tipo === 'choice') return `${id}__mod`;
    return null;
}

export interface CambioPlanificado {
    pos_id: string;
    name: string;
    antes: boolean;
    ahora: boolean;
}

/**
 * Cambios de stock a escribir: solo los que de verdad cambian. in_stock NULL se
 * lee como "en stock", igual que compararFila de menuDiff (existente.in_stock === true
 * es la lectura de Toast; NULL nunca se escribe desde aca).
 */
export function planificarCambiosStock(
    existentes: Map<string, ItemMenu>,
    deseado: Map<string, boolean>
): { cambios: CambioPlanificado[]; desconocidos: CambioStock[]; sinCambio: number } {
    const cambios: CambioPlanificado[] = [];
    const desconocidos: CambioStock[] = [];
    let sinCambio = 0;

    for (const [posId, inStock] of deseado) {
        const item = existentes.get(posId);
        if (!item) {
            desconocidos.push({ pos_id: posId, in_stock: inStock });
            continue;
        }
        const antes = item.in_stock !== false;
        if (antes === inStock) {
            sinCambio++;
            continue;
        }
        cambios.push({ pos_id: posId, name: item.name, antes, ahora: inStock });
    }
    return { cambios, desconocidos, sinCambio };
}

export function entradasDeCambios(cambios: CambioPlanificado[]): EntradaHistorial[] {
    return cambios.map(c => changeLogService.entradaStock(c.pos_id, c.name, c.antes, c.ahora));
}

export interface ResultadoDeltas {
    duplicado: boolean;
    aplicados: number;
    sinCambio: number;
    ignorados: number;
    desconocidos: number;
    sospechosos: string[];
}

export interface DepsAvailability {
    almacen: Almacen;
    cfg: ConfigOlo;
    mutex: Mutex;
    estado: StockEstado;
    /** Pide una linea base de verificacion (flapping). La programa menuSync. */
    programarVerificacion: (motivo: string) => void;
    ahora?: () => Date;
}

export class AvailabilityService {

    constructor(private d: DepsAvailability) {}

    private ahora(): Date {
        return this.d.ahora ? this.d.ahora() : new Date();
    }

    /**
     * Aplica un MenuItemAvailabilityChanged completo.
     *
     *  - Solo los elementos de esta tienda (locationId == OLO_VENDOR_ID).
     *  - Todo el array en UNA transaccion: el registro del message id, los
     *    cambios de in_stock, el historial y los pendientes. Si algo falla no
     *    queda nada aplicado y el receptor reintenta el mensaje entero.
     *  - Dentro del mismo array, si un pos_id aparece dos veces gana el ultimo.
     *  - Pasa por el mismo candado que la importacion y la linea base: un delta
     *    no puede quedar pisado por una linea base leida antes que el.
     */
    public async aplicar(messageId: string, items: unknown): Promise<ResultadoDeltas> {
        const lista = Array.isArray(items) ? items : [];
        const deseado = new Map<string, boolean>();
        let ignorados = 0;

        for (const item of lista) {
            let location: string | null;
            try {
                location = idComoTexto((item as any)?.locationId);
            } catch {
                location = null;
            }
            if (location !== this.d.cfg.vendorId) {
                ignorados++;
                console.debug?.(`Delta de otra tienda ignorado (locationId ${location ?? '?'})`);
                continue;
            }
            const posId = posIdDeDelta(item);
            const disponible = (item as any)?.isAvailable;
            if (!posId || typeof disponible !== 'boolean') {
                ignorados++;
                console.warn(`Delta ilegible ignorado: ${JSON.stringify(item).substring(0, 200)}`);
                continue;
            }
            deseado.set(posId, disponible);
        }

        const ahora = this.ahora();
        const resultado = await this.d.mutex.ejecutar(() => this.d.almacen.transaccion(async tx => {
            const nuevo = await tx.registrarEvento({
                message_id: messageId,
                event_type: 'MenuItemAvailabilityChanged',
                entity_key: this.d.cfg.vendorId,
                note: `${deseado.size} items, ${ignorados} ignorados`
            });
            if (!nuevo) return null;

            if (deseado.size === 0) return { cambios: [] as CambioPlanificado[], desconocidos: [] as CambioStock[], sinCambio: 0 };

            const existentes = await tx.findAllIndexed();
            const plan = planificarCambiosStock(existentes, deseado);

            await tx.escribirStock(plan.cambios.map(c => ({ pos_id: c.pos_id, in_stock: c.ahora })), ahora);
            await tx.registrarHistorial(entradasDeCambios(plan.cambios));
            if (plan.desconocidos.length > 0) await tx.guardarPendientes(plan.desconocidos, ahora);
            return plan;
        }));

        if (resultado === null) {
            this.d.estado.deltas.duplicados++;
            return { duplicado: true, aplicados: 0, sinCambio: 0, ignorados, desconocidos: 0, sospechosos: [] };
        }

        const e = this.d.estado;
        e.lastDeltaAt = ahora;
        e.deltas.aplicados += resultado.cambios.length;
        e.deltas.sinCambio += resultado.sinCambio;
        e.deltas.ignorados += ignorados;
        e.deltas.desconocidos += resultado.desconocidos.length;

        for (const c of resultado.cambios) {
            console.log(`↳ ${c.ahora ? '✅ 68' : '🚫 86'} ${c.name} (posId: ${c.pos_id})`);
        }
        if (resultado.desconocidos.length > 0) {
            console.warn(
                `↳ ⏳ ${resultado.desconocidos.length} delta(s) para items que aun no existen: ` +
                `quedan pendientes hasta la proxima importacion`
            );
        }

        const sospechosos = e.registrarDeltas([...deseado.keys()], ahora.getTime(), this.d.cfg.flapWindowMs);
        if (sospechosos.length > 0) {
            console.warn(
                `↳ 🔁 ${sospechosos.length} item(s) recibieron dos deltas en menos de ` +
                `${Math.round(this.d.cfg.flapWindowMs / 1000)} s: se programa una linea base de verificacion`
            );
            this.d.programarVerificacion('flapping');
        }

        return {
            duplicado: false,
            aplicados: resultado.cambios.length,
            sinCambio: resultado.sinCambio,
            ignorados,
            desconocidos: resultado.desconocidos.length,
            sospechosos
        };
    }
}
