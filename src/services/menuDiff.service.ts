import type { ItemMenu as menu_items } from '../almacen/tipos';
import type { FilaMenu } from './menuFlatten.service';

export type FilaConOrden = FilaMenu & { sort_order: number };

/**
 * Compara lo que Olo acaba de mandar contra lo que ya hay en la base.
 *
 * El servidor de Spring escribía las filas en cada ciclo sin mirar si algo había
 * cambiado, así que en los logs nunca se veía qué cambió ni cuándo. Acá se compara
 * primero: solo se escribe lo que de verdad es distinto, el log dice qué campo
 * cambió y de qué valor a qué valor, y los cambios quedan guardados en
 * menu_item_changes para poder consultarlos después.
 */

/** Un campo concreto que cambió. Es lo que se persiste en el historial. */
export interface CambioCampo {
    campo: string;
    antes: string;
    ahora: string;
}

/** Campos legibles para el log, en el orden en que interesan al leerlos. */
const CAMPOS_VISIBLES: {
    campo: string;
    etiqueta: string;
    delExistente: (i: menu_items) => string;
    deLaFila: (f: FilaConOrden) => string;
}[] = [
    { campo: 'name',         etiqueta: 'nombre',      delExistente: i => i.name ?? "",         deLaFila: f => f.name },
    { campo: 'price',        etiqueta: 'precio',      delExistente: i => i.price ?? "",        deLaFila: f => f.price ?? "" },
    { campo: 'description',  etiqueta: 'descripción', delExistente: i => i.description ?? "",  deLaFila: f => f.description },
    { campo: 'category',     etiqueta: 'categoría',   delExistente: i => i.category ?? "",     deLaFila: f => f.category },
    { campo: 'parent_group', etiqueta: 'grupo padre', delExistente: i => i.parent_group ?? "", deLaFila: f => f.parent_group },
    { campo: 'menu',         etiqueta: 'menú',        delExistente: i => i.menu ?? "",         deLaFila: f => f.menu },
    { campo: 'item_type',    etiqueta: 'tipo',        delExistente: i => i.item_type ?? "",    deLaFila: f => f.item_type },
    { campo: 'menu_number',  etiqueta: 'nº de menú',  delExistente: i => String(i.menu_number ?? ""), deLaFila: f => String(f.menu_number ?? "") },
];

const ETIQUETAS: Record<string, string> = Object.fromEntries(
    CAMPOS_VISIBLES.map(c => [c.campo, c.etiqueta])
);
ETIQUETAS['in_stock'] = 'stock';

/** Texto para el log a partir de los cambios estructurados. */
export function describirCambios(cambios: CambioCampo[]): string {
    return cambios
        .map(c => `${ETIQUETAS[c.campo] ?? c.campo}: ${c.antes || "(vacío)"} → ${c.ahora || "(vacío)"}`)
        .join(", ");
}

export interface Diferencia {
    /** Los cambios que un humano querría ver. Vacío si la fila está idéntica. */
    cambios: CambioCampo[];
    /** true si hay que escribir, aunque no haya ningún cambio visible. */
    debeEscribir: boolean;
}

/**
 * @param preservarStock cuando el inventario no se pudo consultar no se va a
 *        escribir el stock, así que tampoco tiene sentido compararlo.
 */
export function compararFila(
    existente: menu_items,
    fila: FilaConOrden,
    preservarStock: boolean
): Diferencia {
    const cambios: CambioCampo[] = [];

    for (const campo of CAMPOS_VISIBLES) {
        const antes = campo.delExistente(existente);
        const ahora = campo.deLaFila(fila);
        if (antes !== ahora) {
            cambios.push({ campo: campo.campo, antes, ahora });
        }
    }

    if (!preservarStock) {
        const antesStock = existente.in_stock === true;
        if (antesStock !== fila.in_stock) {
            cambios.push({
                campo: 'in_stock',
                antes: antesStock ? "Yes" : "No",
                ahora: fila.in_stock ? "Yes" : "No"
            });
        }
    }

    // Estos cambian sin que a nadie le interese leerlos, pero obligan a escribir.
    const silenciosos =
        existente.sort_order !== fila.sort_order ||
        (!preservarStock && (existente.out_of_stock_icon ?? "") !== fila.out_of_stock_icon);

    return {
        cambios,
        debeEscribir: cambios.length > 0 || silenciosos
    };
}

export interface FilaModificada {
    fila: FilaConOrden;
    cambios: CambioCampo[];
}

export interface Plan {
    nuevas: FilaConOrden[];
    modificadas: FilaModificada[];
    sinCambios: number;
}

/**
 * Reparte las filas de Olo en: nuevas, modificadas y sin cambios.
 * Solo las dos primeras se escriben.
 */
export function planificar(
    filas: FilaConOrden[],
    existentes: Map<string, menu_items>,
    preservarStock: boolean
): Plan {
    const nuevas: FilaConOrden[] = [];
    const modificadas: FilaModificada[] = [];
    let sinCambios = 0;

    for (const fila of filas) {
        const existente = existentes.get(fila.pos_id);

        if (!existente) {
            nuevas.push(fila);
            continue;
        }

        const { cambios, debeEscribir } = compararFila(existente, fila, preservarStock);
        if (debeEscribir) {
            modificadas.push({ fila, cambios });
        } else {
            sinCambios++;
        }
    }

    return { nuevas, modificadas, sinCambios };
}
