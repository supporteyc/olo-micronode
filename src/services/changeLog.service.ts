import type { FilaConOrden, FilaModificada } from './menuDiff.service';
import type { Almacen } from '../almacen/tipos';

/**
 * 'reactivated' ya no existe: un item ausente se borra, asi que cuando vuelve
 * entra como fila nueva y se registra como 'created'. Se deja fuera del tipo a
 * proposito, para que el compilador avise si alguien intenta volver a emitirlo.
 *
 * Un 86 es 'updated' de in_stock Yes -> No; un 68 es 'updated' de No -> Yes.
 */
export type TipoCambio = 'created' | 'updated' | 'deactivated';

export interface EntradaHistorial {
    pos_id: string;
    item_name: string;
    change_type: TipoCambio;
    field: string;
    old_value: string | null;
    new_value: string | null;
}

/** Yes / No, el mismo texto que usa menuDiff para el stock. */
export function textoStock(inStock: boolean): string {
    return inStock ? "Yes" : "No";
}

/**
 * Historial permanente de cambios del menu. Copiado de ec4toast-node: misma
 * forma de las entradas. Lo unico nuevo es entradaStock(), que arma la entrada
 * de un 86/68 que no viene de un plan de menuDiff (webhook o linea base).
 *
 * Guardar el historial nunca debe tumbar un sync: si falla, se avisa y el ciclo
 * sigue. La excepcion son los cambios de stock sueltos (deltas y linea base),
 * que escriben el historial dentro de su transaccion: ahi el historial si es
 * atomico con el cambio, porque el criterio de aceptacion 6 lo exige.
 */
export class ChangeLogService {

    /** Arma las entradas de un ciclo a partir del plan de cambios. */
    public construirEntradas(
        nuevas: FilaConOrden[],
        modificadas: FilaModificada[],
        borradas: { name: string; pos_id: string }[]
    ): EntradaHistorial[] {
        const entradas: EntradaHistorial[] = [];

        for (const fila of nuevas) {
            entradas.push({
                pos_id: fila.pos_id,
                item_name: fila.name,
                change_type: 'created',
                field: 'item',
                old_value: null,
                new_value: fila.name
            });
        }

        for (const { fila, cambios } of modificadas) {
            for (const c of cambios) {
                entradas.push({
                    pos_id: fila.pos_id,
                    item_name: fila.name,
                    change_type: 'updated',
                    field: c.campo,
                    old_value: c.antes,
                    new_value: c.ahora
                });
            }
        }

        for (const d of borradas) {
            entradas.push({
                pos_id: d.pos_id,
                item_name: d.name,
                change_type: 'deactivated',
                field: 'is_active',
                old_value: 'activo',
                new_value: 'inactivo'
            });
        }

        return entradas;
    }

    /** Entrada de un cambio de stock suelto: updated, in_stock, Yes/No. */
    public entradaStock(posId: string, nombre: string, antes: boolean, ahora: boolean): EntradaHistorial {
        return {
            pos_id: posId,
            item_name: nombre,
            change_type: 'updated',
            field: 'in_stock',
            old_value: textoStock(antes),
            new_value: textoStock(ahora)
        };
    }

    /** Persiste las entradas. Devuelve cuantas se guardaron. Nunca lanza. */
    public async registrar(almacen: Almacen, entradas: EntradaHistorial[]): Promise<number> {
        if (entradas.length === 0) return 0;

        try {
            return await almacen.registrarHistorial(entradas);
        } catch (e: any) {
            console.error(
                `⚠️ No se pudo guardar el historial de cambios: ${e.message} ` +
                `(¿corriste sql/001_create_menu_item_changes.sql?)`
            );
            return 0;
        }
    }
}

export const changeLogService = new ChangeLogService();
