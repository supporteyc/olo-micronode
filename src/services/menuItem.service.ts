import type { Almacen, ItemMenu } from '../almacen/tipos';

/**
 * Freno de mano contra borrados masivos. Copiado de ec4toast-node con los
 * mismos nombres de variable y la misma regla: un ciclo que quiera borrar mas
 * de esta fraccion del menu se cancela entero. Con Olo el riesgo es un Vendor
 * Export truncado o un XML que el parser entendio a medias.
 */
const MAX_DELETE_RATIO = Number(process.env.MAX_DELETE_RATIO || 0.5);
const DELETE_GUARD_MIN_ROWS = Number(process.env.DELETE_GUARD_MIN_ROWS || 10);

export interface ResultadoBajas {
    borradas: { name: string; pos_id: string }[];
    frenado: boolean;
}

/**
 * La decision del freno, separada de la escritura para poder probarla sin base.
 * Por debajo de DELETE_GUARD_MIN_ROWS no se frena nada.
 */
export function hayQueFrenar(ausentes: number, conocidas: number): boolean {
    if (conocidas < DELETE_GUARD_MIN_ROWS) return false;
    return ausentes / conocidas > MAX_DELETE_RATIO;
}

export class MenuItemService {

    /**
     * Un item que deja de llegar se borra (hard delete), salvo que el freno
     * detecte un borrado masivo. Igual que ec4toast-node.
     */
    async borrarAusentes(
        almacen: Almacen,
        posIdsVistos: Set<string>,
        existentes: Map<string, ItemMenu>
    ): Promise<ResultadoBajas> {
        const ausentes = [...existentes.values()].filter(i => !posIdsVistos.has(i.pos_id));
        if (ausentes.length === 0) return { borradas: [], frenado: false };

        if (hayQueFrenar(ausentes.length, existentes.size)) {
            const pct = Math.round((ausentes.length / existentes.size) * 100);
            console.error(
                `🛑 Borrado masivo CANCELADO: ${ausentes.length} de ${existentes.size} ítems ` +
                `(${pct}%) supera el límite de ${Math.round(MAX_DELETE_RATIO * 100)}%. ` +
                `Probable Vendor Export incompleto — no se toca el menú, revisar antes de continuar.`
            );
            return { borradas: [], frenado: true };
        }

        await almacen.borrarPorId(ausentes.map(i => i.id));

        return {
            borradas: ausentes
                .filter(i => i.is_active === true)
                .map(i => ({ name: i.name, pos_id: i.pos_id })),
            frenado: false
        };
    }
}

export const menuItemService = new MenuItemService();
