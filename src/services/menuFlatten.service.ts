import { getMenuConfig } from '../config/menuConfig';
import type { GrupoOpcionesOlo, MenuOlo } from './vendorExport.parser';

/**
 * Aplana el Vendor Export de Olo en filas planas de menu_items.
 *
 * Mismas reglas que el aplanado de Toast en ec4toast-node:
 *  - Una categoria sin entrada en MENU_CONFIG no se exporta. Las categorias de
 *    Olo son planas (no hay subgrupos), asi que includeSubGroups no aplica.
 *  - Un mismo item puede aparecer dos veces: gana el primero que se ve.
 *  - Los modificadores usan pos_id sintetico (id de opcion + "__mod") porque un
 *    Product y un Choice pueden tener el mismo id numerico.
 *  - Un producto exportado se lleva sus modificadores: el optiongroup hereda el
 *    numero de menu del producto y solo lo pisa si esta en MENU_CONFIG. Con
 *    includeItems en false en MENU_CONFIG se excluye el optiongroup.
 *
 * Lo que NO hace, a proposito: decidir stock. El Vendor Export incluye los
 * items 86 y no tiene disponibilidad en tiempo real; isdisabled esta deprecado.
 * Toda fila sale con in_stock = true y el stock lo pone fusionarOchentaYSeis.
 */

export interface FilaMenu {
    pos_id: string;
    menu: string;
    item_type: 'PRODUCT' | 'MODIFIER';
    category: string;
    parent_group: string;
    name: string;
    description: string;
    price: string | null;
    in_stock: boolean;
    out_of_stock_icon: string;
    menu_number: number | null;
}

/** Mismo formato que Toast: "$" + 2 decimales. */
export function formatearPrecio(valor: number | null | undefined): string | null {
    if (valor === null || valor === undefined) return null;
    return Number.isFinite(valor) ? `$${valor.toFixed(2)}` : null;
}

interface Contexto {
    menuNombre: string;
    filas: FilaMenu[];
    vistos: Set<string>;
    profundidadMaxima: number;
}

/**
 * Un optiongroup y, si la profundidad lo permite, los optiongroups anidados
 * dentro de sus opciones. profundidad 1 = solo los del producto.
 * [PEDIR-A-ANDRES] cuantos niveles se quieren en pantalla.
 */
function procesarGrupo(
    grupo: GrupoOpcionesOlo,
    categoriaProducto: string,
    menuNumberHeredado: number,
    nivel: number,
    ctx: Contexto
): void {
    if (nivel > ctx.profundidadMaxima) return;

    const config = getMenuConfig(grupo.nombre);
    if (config && !config.includeItems) return;
    const menuNumber = config?.menuNumber ?? menuNumberHeredado;

    const categoria = grupo.nombre + (grupo.id ? ` (Group ID: ${grupo.id})` : '');

    for (const opcion of grupo.opciones) {
        if (!opcion.id) continue;
        const posId = `${opcion.id}__mod`;

        if (!ctx.vistos.has(posId)) {
            ctx.vistos.add(posId);
            ctx.filas.push({
                pos_id: posId,
                menu: ctx.menuNombre,
                item_type: 'MODIFIER',
                category: categoria,
                parent_group: categoriaProducto,
                name: opcion.nombre,
                description: '',
                price: formatearPrecio(opcion.costo),
                in_stock: true,
                out_of_stock_icon: '',
                menu_number: menuNumber
            });
        }

        for (const anidado of opcion.gruposOpciones) {
            procesarGrupo(anidado, categoriaProducto, menuNumber, nivel + 1, ctx);
        }
    }
}

export function aplanarVendorExport(menu: MenuOlo, profundidadModificadores = 1): FilaMenu[] {
    const ctx: Contexto = {
        menuNombre: menu.vendorNombre || 'Olo',
        filas: [],
        vistos: new Set(),
        profundidadMaxima: profundidadModificadores
    };

    for (const categoria of menu.categorias) {
        const config = getMenuConfig(categoria.nombre);
        if (!config || !config.includeItems) continue;

        for (const producto of categoria.productos) {
            if (!producto.id) continue;
            if (ctx.vistos.has(producto.id)) continue;
            ctx.vistos.add(producto.id);

            ctx.filas.push({
                pos_id: producto.id,
                menu: ctx.menuNombre,
                item_type: 'PRODUCT',
                category: categoria.nombre,
                parent_group: '',
                name: producto.nombre,
                description: producto.descripcion,
                price: formatearPrecio(producto.precio),
                in_stock: true,
                out_of_stock_icon: '',
                menu_number: config.menuNumber
            });

            for (const grupo of producto.gruposOpciones) {
                procesarGrupo(grupo, categoria.nombre, config.menuNumber, 1, ctx);
            }
        }
    }

    return ctx.filas;
}

/**
 * Pone el stock real sobre las filas. Misma forma que fusionarInventario de
 * ec4toast-node, con una diferencia de regla:
 *
 *   Toast: el inventario manda solo si menciona el guid; si no, queda el menu.
 *   Olo:   el conjunto 86 manda SIEMPRE. eightysixeditems devuelve todos los
 *          items 86 del restaurante (la lista es exhaustiva segun la doc;
 *          [VALIDAR-CON-OLO]), asi que una fila fuera del conjunto esta en stock.
 *
 * out_of_stock_icon queda vacio, como lo deja el sync de Toast: el icono lo pone
 * menu-export con el soldOutIconUrl de cada pedido.
 */
export function fusionarOchentaYSeis(
    filas: FilaMenu[],
    agotados: Set<string>
): { filas: FilaMenu[]; agotados: number } {
    let cuenta = 0;
    const fusionadas = filas.map(fila => {
        const inStock = !agotados.has(fila.pos_id);
        if (!inStock) cuenta++;
        if (inStock === fila.in_stock && fila.out_of_stock_icon === '') return fila;
        return { ...fila, in_stock: inStock, out_of_stock_icon: '' };
    });
    return { filas: fusionadas, agotados: cuenta };
}

export interface CategoriaVista {
    groupName: string;
    guid: string;
    menuPath: string;
    kind: 'category' | 'optiongroup';
}

/**
 * Categorias y optiongroups del export, para /menu-categories. Misma forma que
 * recolectarNombresDeGrupo de Toast (groupName, guid, menuPath) mas kind.
 */
export function recolectarCategorias(menu: MenuOlo): CategoriaVista[] {
    const vistos = new Map<string, CategoriaVista>();
    const raiz = menu.vendorNombre || 'Olo';

    const enGrupos = (grupos: GrupoOpcionesOlo[], ruta: string) => {
        for (const g of grupos) {
            const path = `${ruta} > ${g.nombre}`;
            if (!vistos.has(g.nombre)) vistos.set(g.nombre, { groupName: g.nombre, guid: g.id, menuPath: path, kind: 'optiongroup' });
            for (const o of g.opciones) enGrupos(o.gruposOpciones, path);
        }
    };

    for (const c of menu.categorias) {
        const path = `${raiz} > ${c.nombre}`;
        if (!vistos.has(c.nombre)) vistos.set(c.nombre, { groupName: c.nombre, guid: c.id, menuPath: path, kind: 'category' });
        for (const p of c.productos) enGrupos(p.gruposOpciones, path);
    }

    return [...vistos.values()];
}
