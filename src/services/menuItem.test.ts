import { describe, expect, test } from 'bun:test';
import { hayQueFrenar } from './menuItem.service';

/**
 * El freno de borrado, con los valores por defecto: 50% y 10 filas minimas.
 *
 * Estos tests importan mas que la mayoria. Un item ausente ya no se marca
 * inactivo, se borra — y un borrado equivocado no se deshace solo en el ciclo
 * siguiente. Este freno es lo unico que separa una respuesta a medias de Toast
 * de un menu vaciado en la pantalla de un restaurante.
 */
describe("freno de borrado masivo", () => {

    test("deja pasar un borrado chico sobre un menu grande", () => {
        // 5 de 200 se van: un restaurante sacando unos platos.
        expect(hayQueFrenar(5, 200)).toBe(false);
    });

    test("frena cuando se quiere borrar mas de la mitad", () => {
        // El caso real: Toast responde con la mitad del menu.
        expect(hayQueFrenar(120, 200)).toBe(true);
    });

    test("justo en el limite no frena, pasarse por uno si", () => {
        expect(hayQueFrenar(100, 200)).toBe(false); // 50% exacto
        expect(hayQueFrenar(101, 200)).toBe(true);  // 50.5%
    });

    test("un menu chico no dispara el freno aunque el porcentaje sea alto", () => {
        // Con 4 items, borrar 3 es 75% pero puede ser legitimo. Cualquier
        // porcentaje sobre numeros chicos es ruido, no señal.
        expect(hayQueFrenar(3, 4)).toBe(false);
        expect(hayQueFrenar(9, 9)).toBe(false);
    });

    test("a partir del minimo de filas el freno ya aplica", () => {
        expect(hayQueFrenar(10, 10)).toBe(true);
    });

    test("sin ausentes no hay nada que frenar", () => {
        expect(hayQueFrenar(0, 200)).toBe(false);
    });
});
