import { Request, Response } from 'express';
import type { Servicios } from '../contenedor';
import { menuConfigSize, menuConfigGrupos, menuConfigOrigen } from '../config/menuConfig';
import { TENANT_NAME, SYNC_INTERVAL_MS, BOOT_TIME, STATUS_SIDE } from '../config/runtime';

type Semaforo = 'ok' | 'warn' | 'error';

/**
 * Lo que el console centralizado consume de esta location. Copiado de
 * ec4toast-node: mismos campos, mismo semaforo, misma regla de no llamar a la
 * API de la fuente. Lo nuevo va SUMADO, sin quitar nada:
 *   health.storeOnline, health.lastWebhookAt, health.lastReconcileAt,
 *   health.lastReconcileCorrected y el bloque olo.
 *
 * health.toastApi se conserva con ese nombre (es contrato con el console) y
 * describe la API de la fuente, que aca es Olo.
 */
export class StatusController {

    constructor(private s: Servicios) {}

    public async getStatus(req: Request, res: Response): Promise<void> {
        try {
            const [ultimo, ultimoOk, menu] = await Promise.all([
                this.s.almacen.ultimoRun(),
                this.s.almacen.ultimoRunOk(),
                this.s.almacen.contarResumen()
            ]);

            const ahora = Date.now();
            const pausado = this.s.menuSync.isSchedulerPaused();
            const gruposConfigurados = menuConfigSize();

            const segundosDesdeUltimoOk = ultimoOk?.finished_at
                ? Math.round((ahora - ultimoOk.finished_at.getTime()) / 1000)
                : null;

            const segundosDesdeUltimo = ultimo?.started_at
                ? Math.round((ahora - ultimo.started_at.getTime()) / 1000)
                : null;

            const intervaloSegundos = Math.round(SYNC_INTERVAL_MS / 1000);
            const atrasado = segundosDesdeUltimo === null || segundosDesdeUltimo > intervaloSegundos * 3;

            // inventory_guids NULL = la linea base de 86 no respondio: el stock
            // en pantalla puede estar viejo.
            const inventarioCaido = ultimo !== null && ultimo.inventory_guids === null;

            const e = this.s.menuSync.estado;

            res.json({
                tenant: TENANT_NAME,
                side: STATUS_SIDE,
                status: this.semaforo({ ultimo, atrasado, pausado, inventarioCaido, gruposConfigurados }),
                now: new Date(ahora).toISOString(),
                bootedAt: BOOT_TIME.toISOString(),
                uptimeSeconds: Math.round((ahora - BOOT_TIME.getTime()) / 1000),

                scheduler: {
                    paused: pausado,
                    intervalSeconds: intervaloSegundos,
                    nextRunInSeconds: pausado || segundosDesdeUltimo === null
                        ? null
                        : Math.max(intervaloSegundos - segundosDesdeUltimo, 0),
                    behind: atrasado
                },

                lastRun: ultimo,
                lastOkRun: ultimoOk
                    ? { finishedAt: ultimoOk.finished_at, secondsAgo: segundosDesdeUltimoOk }
                    : null,

                menu,
                config: {
                    menuGroups: gruposConfigurados,
                    groups: menuConfigGrupos(),
                    source: menuConfigOrigen()
                },
                health: {
                    ...this.diagnosticar(ultimo, gruposConfigurados),
                    storeOnline: this.s.storeHealth.storeOnline,
                    lastWebhookAt: e.lastWebhookAt?.toISOString() ?? null,
                    lastReconcileAt: e.lastReconcileAt?.toISOString() ?? null,
                    lastReconcileCorrected: e.lastReconcileCorrected
                },
                olo: {
                    env: this.s.cfg.env,
                    vendorId: this.s.cfg.vendorId,
                    lastImportAt: e.lastImportAt?.toISOString() ?? null,
                    lastDeltaAt: e.lastDeltaAt?.toISOString() ?? null,
                    reconcileIntervalSeconds: Math.round(this.s.cfg.reconcileIntervalMs / 1000),
                    consecutiveCorrections: e.consecutiveCorrections,
                    deltas: { ...e.deltas },
                    store: this.s.storeHealth.resumen()
                }
            });

        } catch (error: any) {
            res.json({
                tenant: TENANT_NAME,
                side: STATUS_SIDE,
                status: 'error' as Semaforo,
                now: new Date().toISOString(),
                health: { db: 'error', toastApi: 'unknown', inventory: 'unknown', menuConfig: 'unknown' },
                error: error.message
            });
        }
    }

    private diagnosticar(ultimo: any, gruposConfigurados: number) {
        const menuConfig = gruposConfigurados > 0 ? 'ok' : 'error';

        if (!ultimo) {
            return { db: 'ok', toastApi: 'unknown', inventory: 'unknown', menuConfig };
        }

        const inventory = ultimo.inventory_guids === null ? 'error' : 'ok';

        if (ultimo.status === 'ok') {
            return { db: 'ok', toastApi: 'ok', inventory, menuConfig };
        }
        if (ultimo.source_items === 0) {
            return { db: 'ok', toastApi: 'error', inventory, menuConfig };
        }
        return { db: 'error', toastApi: 'ok', inventory, menuConfig };
    }

    private semaforo(ctx: {
        ultimo: any;
        atrasado: boolean;
        pausado: boolean;
        inventarioCaido: boolean;
        gruposConfigurados: number;
    }): Semaforo {
        if (ctx.gruposConfigurados === 0) return 'error';
        if (ctx.ultimo?.status === 'error') return 'error';
        if (!ctx.ultimo) return 'warn';
        if (ctx.atrasado || ctx.pausado || ctx.inventarioCaido) return 'warn';
        return 'ok';
    }

    /** Historial de ciclos. ?limit=N (tope 500), ?status=ok|error|skipped */
    public async getRuns(req: Request, res: Response): Promise<void> {
        try {
            const limite = Number(req.query.limit ?? 50);
            const status = req.query.status as any;
            res.json(await this.s.almacen.listarRuns(Number.isFinite(limite) ? limite : 50, status));
        } catch (error: any) {
            res.status(500).json({
                error: error.message,
                hint: '¿Ya corriste sql/002_create_sync_runs.sql contra la base?'
            });
        }
    }
}
