import { describe, expect, test } from 'bun:test';
import {
    businessDateDeHoy,
    determinarEstado,
    extraerItems,
    formatearModificadores,
    parsearFechaToast,
    type ItemOcb
} from './ocbFormat.service';

const SIN_GRUPOS = new Map<string, string>();

function item(fulfillmentStatus: string): ItemOcb {
    return { name: "x", quantity: 1, price: 0, fulfillmentStatus, modifiers: [] };
}

describe("estado de la orden", () => {

    test("una orden sin líneas se considera recibida", () => {
        expect(determinarEstado([])).toBe("RECEIVED");
    });

    test("todas las líneas listas → READY", () => {
        expect(determinarEstado([item("READY"), item("READY")])).toBe("READY");
    });

    test("alguna línea enviada a cocina → IN_PREPARATION", () => {
        expect(determinarEstado([item("READY"), item("SENT")])).toBe("IN_PREPARATION");
    });

    test("nada enviado todavía → RECEIVED", () => {
        expect(determinarEstado([item("NEW"), item("HOLD")])).toBe("RECEIVED");
    });

    test("una sola línea sin terminar impide el READY", () => {
        expect(determinarEstado([item("READY"), item("READY"), item("NEW")])).toBe("RECEIVED");
    });
});

describe("fechas de Toast", () => {

    test("convierte el +0000 que manda Toast", () => {
        const f = parsearFechaToast("2026-09-02T15:07:19.000+0000");
        expect(f).not.toBeNull();
        expect(f!.toISOString()).toBe("2026-09-02T15:07:19.000Z");
    });

    test("acepta el formato con Z", () => {
        expect(parsearFechaToast("2026-09-02T15:07:19.000Z")!.toISOString())
            .toBe("2026-09-02T15:07:19.000Z");
    });

    test("null, vacío o basura devuelven null en vez de una fecha inválida", () => {
        expect(parsearFechaToast(null)).toBeNull();
        expect(parsearFechaToast("")).toBeNull();
        expect(parsearFechaToast("no es una fecha")).toBeNull();
    });
});

describe("modificadores", () => {

    test("sin nombres de grupo salen como lista plana", () => {
        const sel = { modifiers: [{ displayName: "Chocolate" }, { displayName: "Vanilla" }] };
        expect(formatearModificadores(sel, SIN_GRUPOS)).toEqual(["Chocolate", "Vanilla"]);
    });

    test("con nombres de grupo se agrupan por grupo", () => {
        const grupos = new Map([["g1", "Box of 4"], ["g2", "Size"]]);
        const sel = {
            modifiers: [
                { displayName: "Chocolate", modifierGroupGuid: "g1" },
                { displayName: "Vanilla",   modifierGroupGuid: "g1" },
                { displayName: "Large",     modifierGroupGuid: "g2" }
            ]
        };
        expect(formatearModificadores(sel, grupos)).toEqual(["Box of 4: Chocolate, Vanilla", "Size: Large"]);
    });

    test("los modificadores anulados se descartan", () => {
        const sel = {
            modifiers: [
                { displayName: "Chocolate" },
                { displayName: "Cancelado", voided: true }
            ]
        };
        expect(formatearModificadores(sel, SIN_GRUPOS)).toEqual(["Chocolate"]);
    });

    test("una línea sin modificadores devuelve lista vacía", () => {
        expect(formatearModificadores({}, SIN_GRUPOS)).toEqual([]);
        expect(formatearModificadores({ modifiers: [] }, SIN_GRUPOS)).toEqual([]);
    });
});

describe("extracción de líneas", () => {

    const orden = {
        checks: [{
            totalAmount: 42.5,
            paymentStatus: "CLOSED",
            selections: [
                { displayName: "Wings", quantity: 2, price: 20, fulfillmentStatus: "SENT" },
                { displayName: "Anulado", quantity: 1, price: 5, voided: true },
                { displayName: "Soda", price: 2.5 }
            ]
        }]
    };

    test("saca las líneas, el total y el estado de pago", () => {
        const { items, totalAmount, paymentStatus } = extraerItems(orden, SIN_GRUPOS);

        expect(items).toHaveLength(2);           // la anulada no cuenta
        expect(totalAmount).toBe(42.5);
        expect(paymentStatus).toBe("CLOSED");
    });

    test("los campos ausentes toman el valor por defecto de Toast", () => {
        const { items } = extraerItems(orden, SIN_GRUPOS);
        const soda = items.find(i => i.name === "Soda")!;

        expect(soda.quantity).toBe(1);              // sin quantity → 1
        expect(soda.fulfillmentStatus).toBe("NEW"); // sin estado → NEW
    });

    test("una orden sin checks no revienta", () => {
        const { items, totalAmount, paymentStatus } = extraerItems({}, SIN_GRUPOS);
        expect(items).toEqual([]);
        expect(totalAmount).toBe(0);
        expect(paymentStatus).toBe("OPEN");
    });
});

describe("businessDate", () => {

    test("formatea aaaammdd como entero", () => {
        expect(businessDateDeHoy(new Date(2026, 8, 2))).toBe(20260902);
    });

    test("rellena con cero el mes y el día de un dígito", () => {
        expect(businessDateDeHoy(new Date(2026, 0, 5))).toBe(20260105);
    });
});
