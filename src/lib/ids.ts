/**
 * Ids de Olo sin perder precision.
 *
 * Todos los ids de Olo son int64 y superan Number.MAX_SAFE_INTEGER (2^53 - 1,
 * 16 digitos). JSON.parse los convierte a number y redondea en silencio:
 * 10000000000000001 pasa a 10000000000000000, y el 86 se aplica al item
 * equivocado sin que nada avise.
 *
 * La salida es citar como string, ANTES de JSON.parse, todo entero de 16 o mas
 * digitos que aparezca como valor. No se filtra por nombre de clave: ningun
 * precio, cantidad ni total de Olo llega a 16 digitos, y una lista de claves se
 * queda corta el dia que Olo agregue un campo.
 */

/**
 * Un entero de 16+ digitos en posicion de valor: despues de ":" o de "[" o ","
 * dentro de un array, y seguido de un separador. No toca numeros con decimales
 * ni exponentes, ni texto dentro de strings (un string ya lleva comillas antes
 * del primer digito, y el lookbehind exige ":" "[" o "," con espacios).
 */
const ENTERO_GRANDE = /([:\[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g;

export function citarIdsGrandes(json: string): string {
    return json.replace(ENTERO_GRANDE, '$1"$2"');
}

/** JSON.parse que conserva los ids grandes como string. */
export function parsearJsonSeguro<T = any>(texto: string): T {
    return JSON.parse(citarIdsGrandes(texto)) as T;
}

/**
 * Normaliza un id que puede llegar como string o como number chico. Un number
 * que ya no es seguro se rechaza: el dato ya se corrompio antes de llegar aca y
 * usarlo seria aplicar el cambio a otra fila.
 */
export function idComoTexto(valor: unknown): string | null {
    if (valor === null || valor === undefined) return null;
    if (typeof valor === 'string') {
        const t = valor.trim();
        return t === '' ? null : t;
    }
    if (typeof valor === 'bigint') return valor.toString();
    if (typeof valor === 'number') {
        if (!Number.isSafeInteger(valor)) {
            throw new Error(`Id numerico sin precision (${valor}): llego como number y no como string`);
        }
        return String(valor);
    }
    return null;
}
