import { describe, expect, test } from 'bun:test';
import { compararFila, describirCambios, planificar, type FilaConOrden } from './menuDiff.service';
import type { ItemMenu as menu_items } from '../almacen/tipos';

/**
 * El servidor de Spring reescribía todas las filas en cada ciclo, así que en los
 * logs nunca se veía qué había cambiado. Estos tests fijan la detección: qué
 * cuenta como cambio, qué se reporta al humano y qué se escribe en silencio.
 */

function existente(over: Partial<menu_items> = {}): menu_items {
    return {
        id: 1n,
        pos_id: "p1",
        menu: "Ingredients test",
        item_type: "PRODUCT",
        category: "Alitas",
        parent_group: "",
        name: "Wings",
        description: "Picantes",
        price: "$10.00",
        in_stock: true,
        out_of_stock_icon: "",
        sort_order: 1,
        menu_number: 1,
        created_at: null,
        updated_at: null,
        last_synced_to_onsign: null,
        is_active: true,
        toast_last_modified: null,
        onsign_row_id: null,
        onsign_version: null,
        miss_count: 0,
        ...over
    } as menu_items;
}

function fila(over: Partial<FilaConOrden> = {}): FilaConOrden {
    return {
        pos_id: "p1",
        menu: "Ingredients test",
        item_type: "PRODUCT",
        category: "Alitas",
        parent_group: "",
        name: "Wings",
        description: "Picantes",
        price: "$10.00",
        in_stock: true,
        out_of_stock_icon: "",
        menu_number: 1,
        sort_order: 1,
        ...over
    };
}

describe("detección de cambios", () => {

    test("una fila idéntica no se escribe ni se reporta", () => {
        const d = compararFila(existente(), fila(), false);
        expect(d.debeEscribir).toBe(false);
        expect(d.cambios).toHaveLength(0);
    });

    test("un cambio de precio se reporta con el antes y el después", () => {
        const d = compararFila(existente(), fila({ price: "$12.50" }), false);
        expect(d.debeEscribir).toBe(true);
        expect(describirCambios(d.cambios)).toBe("precio: $10.00 → $12.50");
    });

    test("un cambio de stock se reporta en Yes/No", () => {
        const d = compararFila(existente(), fila({ in_stock: false }), false);
        expect(describirCambios(d.cambios)).toBe("stock: Yes → No");
    });

    test("varios cambios salen juntos en una sola línea", () => {
        const d = compararFila(existente(), fila({ name: "Buffalo Wings", price: "$12.50" }), false);
        expect(describirCambios(d.cambios)).toBe("nombre: Wings → Buffalo Wings, precio: $10.00 → $12.50");
    });

    test("un campo que pasa a vacío se lee como (vacío) y no como cadena suelta", () => {
        const d = compararFila(existente(), fila({ description: "" }), false);
        expect(describirCambios(d.cambios)).toBe("descripción: Picantes → (vacío)");
    });

    /**
     * Antes, una fila con is_active en false generaba un cambio "estado:
     * inactivo -> activo" en cada ciclo. Con dos procesos escribiendo la misma
     * base eso lleno el historial del cliente con 32.000 reapariciones falsas.
     * Ahora is_active no participa del diff.
     */
    test("is_active no genera cambios visibles", () => {
        const d = compararFila(existente({ is_active: false }), fila(), false);
        expect(d.cambios.some(c => c.campo === 'is_active')).toBe(false);
        expect(describirCambios(d.cambios)).toBe("");
    });
});

describe("cambios silenciosos", () => {

    test("un cambio de orden obliga a escribir pero no ensucia el log", () => {
        const d = compararFila(existente(), fila({ sort_order: 5 }), false);
        expect(d.debeEscribir).toBe(true);
        expect(d.cambios).toHaveLength(0);
    });

    /**
     * miss_count era el contador de ausencias del borrado suave. Ya no se usa:
     * un item ausente se borra, asi que ninguna fila viva lo tiene distinto de
     * cero. Que no obligue a escribir es justamente lo que evita el UPDATE
     * eterno que teniamos.
     */
    test("miss_count ya no obliga a escribir", () => {
        const d = compararFila(existente({ miss_count: 3 }), fila(), false);
        expect(d.debeEscribir).toBe(false);
        expect(d.cambios).toHaveLength(0);
    });
});

describe("sin inventario", () => {

    test("no se compara el stock, porque tampoco se va a escribir", () => {
        const d = compararFila(existente({ in_stock: false }), fila({ in_stock: true }), true);
        expect(d.debeEscribir).toBe(false);
        expect(d.cambios).toHaveLength(0);
    });

    test("el resto de campos se sigue comparando igual", () => {
        const d = compararFila(existente({ in_stock: false }), fila({ in_stock: true, price: "$99.00" }), true);
        expect(describirCambios(d.cambios)).toBe("precio: $10.00 → $99.00");
    });
});

describe("planificar", () => {

    test("reparte en nuevas, modificadas y sin cambios", () => {
        const existentes = new Map<string, menu_items>([
            ["p1", existente()],
            ["p2", existente({ pos_id: "p2", name: "Fries", price: "$4.00", sort_order: 2 })]
        ]);

        const plan = planificar(
            [
                fila(),                                                              // idéntica
                fila({ pos_id: "p2", name: "Fries", price: "$5.00", sort_order: 2 }), // cambió el precio
                fila({ pos_id: "p3", name: "Nachos", sort_order: 3 })                 // nueva
            ],
            existentes,
            false
        );

        expect(plan.sinCambios).toBe(1);
        expect(plan.nuevas.map(f => f.pos_id)).toEqual(["p3"]);
        expect(plan.modificadas.map(m => m.fila.pos_id)).toEqual(["p2"]);
        expect(describirCambios(plan.modificadas[0].cambios)).toBe("precio: $4.00 → $5.00");
    });

    test("un menú estable no produce nada para escribir", () => {
        const existentes = new Map<string, menu_items>([["p1", existente()]]);
        const plan = planificar([fila()], existentes, false);

        expect(plan.nuevas).toHaveLength(0);
        expect(plan.modificadas).toHaveLength(0);
        expect(plan.sinCambios).toBe(1);
    });
});
