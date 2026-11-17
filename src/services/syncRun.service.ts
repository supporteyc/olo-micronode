import type { Almacen, EstadoRun, OrigenRun } from '../almacen/tipos';

export type { EstadoRun, OrigenRun };

/**
 * Un ciclo en curso. Copiado de ec4toast-node: vive en memoria mientras el
 * ciclo corre y se persiste UNA sola vez al cerrarlo.
 */
export interface RunEnCurso {
    startedAt: Date;
    trigger: OrigenRun;
    status: EstadoRun;
    reason: string | null;
    sourceItems: number;
    /** null = la fuente viva de stock no respondio y el stock se conservo. */
    inventoryGuids: number | null;
    soldOutItems: number;
    dbCreated: number;
    dbUpdated: number;
    dbDeleted: number;
    dbUnchanged: number;
    changesLogged: number;
    errorMessage: string | null;
    /** Evita que un ciclo se guarde dos veces cuando dos caminos lo intentan cerrar. */
    cerrado: boolean;
}

/**
 * Historial de ciclos. Mismo contrato que en ec4toast-node: guardar el
 * historial nunca debe tumbar un ciclo.
 */
export class SyncRunService {

    public iniciar(trigger: OrigenRun = 'scheduler'): RunEnCurso {
        return {
            startedAt: new Date(),
            trigger,
            status: 'ok',
            reason: null,
            sourceItems: 0,
            inventoryGuids: null,
            soldOutItems: 0,
            dbCreated: 0,
            dbUpdated: 0,
            dbDeleted: 0,
            dbUnchanged: 0,
            changesLogged: 0,
            errorMessage: null,
            cerrado: false
        };
    }

    /** Marca el ciclo como fallido. No lo persiste: de eso se encarga finalizar(). */
    public marcarError(run: RunEnCurso, mensaje: string, status: EstadoRun = 'error') {
        run.status = status;
        run.errorMessage = mensaje;
    }

    /** Persiste el ciclo. Idempotente: la segunda llamada no hace nada. */
    public async finalizar(almacen: Almacen, run: RunEnCurso): Promise<void> {
        if (run.cerrado) return;
        run.cerrado = true;

        const finishedAt = new Date();

        try {
            await almacen.guardarRun({
                started_at: run.startedAt,
                finished_at: finishedAt,
                duration_ms: finishedAt.getTime() - run.startedAt.getTime(),
                status: run.status,
                trigger_source: run.trigger,
                reason: run.reason,
                source_items: run.sourceItems,
                inventory_guids: run.inventoryGuids,
                sold_out_items: run.soldOutItems,
                db_created: run.dbCreated,
                db_updated: run.dbUpdated,
                db_deleted: run.dbDeleted,
                db_unchanged: run.dbUnchanged,
                changes_logged: run.changesLogged,
                error_message: run.errorMessage?.substring(0, 2000) ?? null
            });
        } catch (e: any) {
            // console.error dispara el webhook de alertas. Un fallo al registrar el
            // historial no es una caida del servicio: se avisa como warning.
            console.warn(
                `⚠️ No se pudo guardar el ciclo en sync_runs: ${e.message} ` +
                `(¿corriste sql/002_create_sync_runs.sql?)`
            );
        }
    }
}

export const syncRunService = new SyncRunService();
