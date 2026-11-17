/**
 * MENU_CONFIG - el filtro que decide QUÉ del menú de Toast llega al menú digital.
 *
 * El menú que Toast devuelve para un cliente es enorme y anidado. Este mapa dice,
 * por nombre de grupo, cuál de esos grupos entra y bajo qué número de menú. Un
 * grupo que no esté acá simplemente no se exporta.
 *
 * Espeja la hoja MENU_CONFIG: Filter Value → columna Menu.
 *
 * Portado 1:1 desde CATEGORY_TO_MENU_NUMBER en ToastApiService.java. Los valores
 * son los mismos; lo único que cambia es que acá viven como datos y no dentro de
 * un bloque static.
 */

export interface MenuConfigOption {
    /** Número de menú al que va el grupo. */
    menuNumber: number;
    /** Incluir los ítems que cuelgan directamente del grupo. */
    includeItems: boolean;
    /** Bajar a los subgrupos anidados heredando este número de menú. */
    includeSubGroups: boolean;
}

/**
 * Las claves se guardan normalizadas (ver normalizeMenuConfigKey).
 *
 * Para traer TODO (ítems directos + subgrupos):  ["Nombre", 1, true,  true]
 * Para traer SOLO ítems directos:                ["Nombre", 1, true,  false]
 * Para traer SOLO los subgrupos:                 ["Nombre", 1, false, true]
 */
type ConfigEntry = [string, number, boolean, boolean];

/**
 * Sin MENU_CONFIG no se filtra nada, y el arranque lo grita.
 *
 * Antes aca vivian los grupos de Atomic Wings como red de seguridad, pero
 * heredar en silencio el filtro de otra tienda es peor que no tener ninguno:
 * el dia que un cliente tenga un grupo con el mismo nombre, le exportarias el
 * menu equivocado sin que nada avise. Vacio, el ciclo aborta y se ve.
 */
const CONFIG_POR_DEFECTO: ConfigEntry[] = [];

/**
 * El filtro de esta tienda, leido de la variable MENU_CONFIG.
 *
 * Vivia hardcodeado aca, pero se despliega la misma imagen en cada location y
 * cada cliente tiene sus propios grupos: con el filtro en el codigo, dar de alta
 * un restaurante obligaba a editar el fuente y mantener un build por tienda.
 *
 * Formato: un array JSON de [grupo, numeroDeMenu, incluirItems, incluirSubgrupos]
 *
 *   MENU_CONFIG=[["Coffee",1,true,true],["Pastries",2,true,true]]
 *
 * Para saber que grupos existen en un cliente nuevo, GET /api/toast/menu-categories
 * los lista todos y marca cuales estan en el filtro.
 */
function leerConfigEntries(): ConfigEntry[] {
    const crudo = (process.env.MENU_CONFIG || "").trim();
    if (!crudo) return CONFIG_POR_DEFECTO;

    try {
        const parseado = JSON.parse(crudo);
        if (!Array.isArray(parseado)) throw new Error("no es un array");

        return parseado.map((fila: any, i: number) => {
            if (!Array.isArray(fila) || typeof fila[0] !== "string" || typeof fila[1] !== "number") {
                throw new Error(`la fila ${i} no es ["grupo", numero, bool, bool]`);
            }
            // Los dos booleanos son opcionales: lo normal es querer todo, asi el
            // caso comun se escribe ["Coffee",1] y no ["Coffee",1,true,true].
            return [fila[0], fila[1], fila[2] !== false, fila[3] !== false] as ConfigEntry;
        });

    } catch (e: any) {
        // No se recurre al default: aplicar el filtro de otra tienda dejaria pasar
        // grupos ajenos. Mejor vacio - el ciclo aborta solo antes de tocar el menu.
        console.error(
            `MENU_CONFIG esta mal escrito (${e.message}). No se aplicara ningun filtro y el ` +
            `sync abortara en cada ciclo hasta corregirlo. Formato: [["Grupo",1,true,true], ...]`
        );
        return [];
    }
}

const CONFIG_ENTRIES: ConfigEntry[] = leerConfigEntries();

/** De donde salio el filtro. Se loguea al arrancar para no tener que adivinar. */
export function menuConfigOrigen(): string {
    return (process.env.MENU_CONFIG || "").trim() ? "MENU_CONFIG (env)" : "SIN CONFIGURAR";
}

/** Los grupos configurados, para poder mostrarlos en /api/status. */
export function menuConfigGrupos(): string[] {
    return CONFIG_ENTRIES.map(([nombre]) => nombre);
}

/**
 * Quita acentos, recorta y pasa a minúsculas, para que el nombre del grupo que
 * llega de Toast case con la configuración sin importar tildes ni mayúsculas.
 * Equivalente al Normalizer.Form.NFD + \p{M}+ del Java.
 */
export function normalizeMenuConfigKey(value: string | null | undefined): string {
    if (value === null || value === undefined) return "";
    return value.normalize("NFD").replace(/\p{M}+/gu, "").trim().toLowerCase();
}

const CATEGORY_TO_MENU_NUMBER = new Map<string, MenuConfigOption>(
    CONFIG_ENTRIES.map(([value, menuNumber, includeItems, includeSubGroups]) => [
        normalizeMenuConfigKey(value),
        { menuNumber, includeItems, includeSubGroups }
    ])
);

/** Devuelve la configuración de un grupo, o null si ese grupo no se exporta. */
export function getMenuConfig(groupName: string | null | undefined): MenuConfigOption | null {
    return CATEGORY_TO_MENU_NUMBER.get(normalizeMenuConfigKey(groupName)) ?? null;
}

/** Cuántos grupos hay configurados - se loguea al arrancar para detectar un config vacío. */
export function menuConfigSize(): number {
    return CATEGORY_TO_MENU_NUMBER.size;
}
