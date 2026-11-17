import { describe, expect, test } from 'bun:test';
import { changeLogService } from './changeLog.service';
import type { FilaConOrden, FilaModificada } from './menuDiff.service';

/**
 * construirEntradas es lógica pura: arma las filas del historial a partir del
 * plan de cambios. Se prueba sin base de datos.
 */

function fila(over: Partial<FilaConOrden> = {}): FilaConOrden {
    return {
        pos_id: "p1",
        menu: "Ingredients test",
        item_type: "PRODUCT",
        category: "Alitas",
        parent_group: "",
        name: "Wings",
        description: "",
        price: "$10.00",
        in_stock: true,
        out_of_stock_icon: "",
        menu_number: 1,
        sort_order: 1,
        ...over
    };
}

function modificada(cambios: FilaModificada['cambios']): FilaModificada {
    return { fila: fila(), cambios };
}

describe("construcción de entradas del historial", () => {

    test("un alta genera una entrada de tipo created", () => {
        const e = changeLogService.construirEntradas([fila({ pos_id: "p9", name: "Nachos" })], [], []);

        expect(e).toHaveLength(1);
        expect(e[0]).toEqual({
            pos_id: "p9",
            item_name: "Nachos",
            change_type: 'created',
            field: 'item',
            old_value: null,
            new_value: "Nachos"
        });
    });

    test("cada campo modificado genera su propia entrada", () => {
        const e = changeLogService.construirEntradas([], [modificada([
            { campo: 'price', antes: "$10.00", ahora: "$12.50" },
            { campo: 'name',  antes: "Wings",  ahora: "Buffalo Wings" }
        ])], []);

        expect(e).toHaveLength(2);
        expect(e.map(x => x.field)).toEqual(['price', 'name']);
        expect(e[0].old_value).toBe("$10.00");
        expect(e[0].new_value).toBe("$12.50");
        expect(e.every(x => x.change_type === 'updated')).toBe(true);
    });

    test("una baja genera una entrada de tipo deactivated", () => {
        const e = changeLogService.construirEntradas([], [], [{ pos_id: "p3", name: "Soda" }]);

        expect(e).toHaveLength(1);
        expect(e[0].change_type).toBe('deactivated');
        expect(e[0].field).toBe('is_active');
        expect(e[0].old_value).toBe('activo');
        expect(e[0].new_value).toBe('inactivo');
    });

    /**
     * Un ítem ausente se borra, asi que no existe la reaparicion: cuando vuelve
     * entra como fila nueva. Este test fija que no quede ningun camino que
     * vuelva a emitir el tipo viejo.
     */
    test("un ítem que vuelve se registra como alta, no como reaparición", () => {
        const e = changeLogService.construirEntradas(
            [fila({ pos_id: "p9", name: "Nachos" })], [], []
        );

        expect(e).toHaveLength(1);
        expect(e[0].change_type).toBe('created');
        expect(e.some(x => (x.change_type as string) === 'reactivated')).toBe(false);
    });

    test("el nombre se copia en cada entrada, para que el historial sobreviva un borrado", () => {
        const e = changeLogService.construirEntradas([], [], [{ pos_id: "p3", name: "Soda" }]);
        expect(e[0].item_name).toBe("Soda");
    });

    test("un ciclo sin cambios no genera entradas", () => {
        expect(changeLogService.construirEntradas([], [], [])).toEqual([]);
    });

    test("un ciclo mixto genera todas las entradas juntas", () => {
        const e = changeLogService.construirEntradas(
            [fila({ pos_id: "nuevo", name: "Nachos" })],
            [modificada([{ campo: 'price', antes: "$1.00", ahora: "$2.00" }])],
            [{ pos_id: "viejo", name: "Soda" }]
        );

        expect(e.map(x => x.change_type)).toEqual(['created', 'updated', 'deactivated']);
    });
});
