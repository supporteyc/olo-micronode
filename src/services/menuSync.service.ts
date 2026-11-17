import type { Almacen } from '../almacen/tipos';
import type { ConfigOlo } from '../config/olo';
import { getMenuConfig, menuConfigSize } from '../config/menuConfig';
import { Mutex } from '../lib/mutex';
import { businessDateEnZona, horaMinutoEnZona } from '../lib/tiempo';
import { OloApiService, OloHttpError, type OchentaYSeis } from './oloApi.service';
import { vendorExportParser, type MenuOlo, type VendorExportParser } from './vendorExport.parser';
import { aplanarVendorExport, fusionarOchentaYSeis, recolectarCategorias } from './menuFlatten.service';
import { planificar, describirCambios } from './menuDiff.service';
import { changeLogService } from './changeLog.service';
import { menuItemService } from './menuItem.service';
import { syncRunService, type OrigenRun, type RunEnCurso } from './syncRun.service';
import { entradasDeCambios, planificarCambiosStock } from './availability.service';
import { StockEstado } from './stockEstado';

export interface ResultadoSync {
    success: boolean;
    guardados: number;
    desactivados: number;
    stockActualizado: number;
    error?: string;
}

export interface DepsMenuSync {
    almacen: Almacen;
    oloApi: OloApiService;
    cfg: ConfigOlo;
    parser?: VendorExportParser;
    mutex?: Mutex;
    estado?: StockEstado;
    ahora?: () => Date;
}

/**
 * El ciclo del menu y del stock, lado Olo.
 *
 * En ec4toast-node un solo ciclo cada 78 s leia menu + inventario y escribia.
 * Con Olo el polling de menu no esta permitido, asi que el ciclo se parte en
 * tres caminos que escriben en las mismas tablas con la misma logica:
 *
 *   importar()     Vendor Export + linea base de 86, por el pipeline de Toast
 *                  (aplanar, fusionar, planificar, upsert, borrar con freno,
 *                  historial). Al arrancar, en VendorMenuExportComplete, en el
 *                  respaldo diario y a mano.
 *   reconciliar()  Solo la linea base de 86 sobre lo que ya hay en la base.
 *                  Cada OLO_RECONCILE_INTERVAL_MS, por flapping y por silencio.
 *   tick()         El ciclo de salud: no llama a Olo; escribe sync_runs para
 *                  que el semaforo del console siga funcionando y decide si
 *                  toca reconciliar o importar.
 *
 * Los tres (y los deltas por webhook) pasan por el mismo candado FIFO.
 */
export class MenuSyncService {

    public readonly estado: StockEstado;
    public readonly mutex: Mutex;

    private SCHEDULER_PAUSED = false;
    private importando = false;
    private importPendiente: OrigenRun | null = null;
    private ultimoMenu: MenuOlo | null = null;
    private verificacionProgramada: ReturnType<typeof setTimeout> | null = null;
    private silencioAvisado = false;

    constructor(private d: DepsMenuSync) {
        this.estado = d.estado ?? new StockEstado();
        this.mutex = d.mutex ?? new Mutex();
    }

    private get almacen() { return this.d.almacen; }
    private get cfg() { return this.d.cfg; }
    private get parser() { return this.d.parser ?? vendorExportParser; }
    private ahora(): Date { return this.d.ahora ? this.d.ahora() : new Date(); }

    public pauseScheduler() { this.SCHEDULER_PAUSED = true; }
    public resumeScheduler() { this.SCHEDULER_PAUSED = false; }
    public isSchedulerPaused() { return this.SCHEDULER_PAUSED; }

    /** Lo que llama el setInterval. Mismo nombre que en ec4toast-node. */
    public async autoSync(): Promise<void> {
        if (this.SCHEDULER_PAUSED) {
            console.log("⏸️ Scheduler pausado, skip sync.");
            return;
        }
        await this.tick();
    }

    /** Primer ciclo al arrancar: importacion con linea base; si el export falla, al menos la linea base. */
    public async arrancar(): Promise<void> {
        const r = await this.importar('scheduler');
        if (!r.success) await this.reconciliar('scheduler', 'arranque sin export');
    }

    // ================================================================
    // IMPORTACION: Vendor Export + linea base
    // ================================================================

    public async importar(trigger: OrigenRun = 'scheduler'): Promise<ResultadoSync> {
        if (this.importando) {
            // Un VendorMenuExportComplete que llega mientras se importa no se
            // pierde: se encola UNA importacion mas al terminar esta. No se
            // escribe una fila skipped: dejaria el semaforo en warn sin motivo.
            this.importPendiente = trigger;
            console.log("⏸️ Importacion ya en progreso: se encola otra al terminar.");
            return { success: false, guardados: 0, desactivados: 0, stockActualizado: 0, error: "Sync already in progress" };
        }
        this.importando = true;
        const run = syncRunService.iniciar(trigger);

        try {
            console.log("");
            console.log(`⏰ ===== IMPORTACION [${run.startedAt.toISOString()}] =====`);
            console.log("📥 --- PASO 1/2: LEER DE OLO ---");

            // La descarga va fuera del candado: puede tardar y los deltas no
            // tienen por que esperarla. Lo que se escribe va adentro.
            const xml = await this.d.oloApi.descargarVendorExport();
            const menu = this.parser.parsear(xml);
            this.ultimoMenu = menu;

            const conIgnorados = menu.categorias.flatMap(c => c.productos).filter(p => p.ignorados.length > 0);
            if (conIgnorados.length > 0) {
                console.log(
                    `↳ ℹ️ ${conIgnorados.length} producto(s) traen isdisabled u horarios (availability/times): ` +
                    `se ignoran, no son 86`
                );
            }

            const filasMenu = aplanarVendorExport(menu, this.cfg.modifierDepth);
            run.sourceItems = filasMenu.length;
            console.log(`↳ 📊 Menú: ${filasMenu.length} filas pasan el filtro de MENU_CONFIG`);

            if (filasMenu.length === 0) {
                console.error(
                    `❌ El filtro no dejó pasar ninguna fila (MENU_CONFIG tiene ${menuConfigSize()} grupos). ` +
                    `Se aborta antes de borrar el menú completo.`
                );
                return this.abortar(run, "Filtro sin resultados");
            }

            const resultado = await this.mutex.ejecutar(() => this.escribirImportacion(run, filasMenu));
            this.estado.lastImportAt = this.ahora();
            this.cerrarCiclo(run);
            return resultado;

        } catch (error: any) {
            if (error instanceof OloHttpError) {
                console.error(`❌ Importacion falló por HTTP ${error.status}: ${error.body.substring(0, 300)}`);
            } else {
                console.error(`❌ Importacion falló: ${error.message}`);
            }
            return this.abortar(run, error.message);
        } finally {
            this.importando = false;
            if (this.importPendiente) {
                const t = this.importPendiente;
                this.importPendiente = null;
                setTimeout(() => { void this.importar(t); }, 0);
            }
        }
    }

    private async escribirImportacion(run: RunEnCurso, filasMenu: ReturnType<typeof aplanarVendorExport>): Promise<ResultadoSync> {
        // Olo indica llamar eightysixeditems SIEMPRE despues de importar. Se pide
        // dentro del candado: un delta que llegue mientras tanto espera y se
        // aplica despues, sobre el estado ya fusionado.
        const ochenta = await this.fetchOchentaYSeis();

        let filas = filasMenu;
        let stockActualizado = 0;
        if (ochenta) {
            const fusion = fusionarOchentaYSeis(filasMenu, ochenta.posIds);
            filas = fusion.filas;
            stockActualizado = fusion.agotados;
            run.inventoryGuids = ochenta.entradas;
            run.soldOutItems = fusion.agotados;
            console.log(`↳ 📦 86: ${ochenta.entradas} entradas | ${fusion.agotados} ítems agotados`);
        } else {
            console.warn("⚠️ Sin linea base de 86 en este ciclo — se conserva el stock que ya tiene la DB.");
        }

        console.log("📥 PASO 1/2 completado.");
        console.log("💾 --- PASO 2/2: ESCRIBIR EN LA BASE DE DATOS ---");

        const ordenadas = [...filas].sort((a, b) => {
            if (a.menu_number === null && b.menu_number === null) return 0;
            if (a.menu_number === null) return 1;
            if (b.menu_number === null) return -1;
            return a.menu_number - b.menu_number;
        });
        const conOrden = ordenadas.map((fila, i) => ({ ...fila, sort_order: i + 1 }));

        const preservarStock = ochenta === null;
        const existentes = await this.almacen.findAllIndexed();
        const plan = planificar(conOrden, existentes, preservarStock);

        for (const fila of plan.nuevas) console.log(`↳ 🆕 ${fila.name} (posId: ${fila.pos_id})`);
        for (const { fila, cambios } of plan.modificadas) {
            if (cambios.length > 0) console.log(`↳ 🔄 ${fila.name} → ${describirCambios(cambios)}`);
        }

        const aEscribir = [...plan.nuevas, ...plan.modificadas.map(m => m.fila)];
        const guardados = await this.almacen.upsertFilas(aEscribir, preservarStock, this.ahora());

        const vistos = new Set(conOrden.map(f => f.pos_id));
        const bajas = await menuItemService.borrarAusentes(this.almacen, vistos, existentes);
        for (const b of bajas.borradas) console.log(`↳ 🗑️ ${b.name} → ya no llega en el menú (borrado)`);

        const entradas = changeLogService.construirEntradas(plan.nuevas, plan.modificadas, bajas.borradas);
        let registradas = await changeLogService.registrar(this.almacen, entradas);

        // Pendientes: deltas que llegaron para items que no existian. Con linea
        // base fresca no hacen falta (la linea base manda); sin ella, son lo
        // mejor que hay para los items recien creados.
        registradas += await this.resolverPendientes(preservarStock);

        const huboCambios = plan.nuevas.length > 0 || plan.modificadas.length > 0 || bajas.borradas.length > 0;
        if (!huboCambios) {
            console.log(`↳ ✅ Sin cambios (${plan.sinCambios} ítems idénticos)`);
        } else {
            console.log(
                `↳ ✅ DB: ${plan.nuevas.length} creados, ${plan.modificadas.length} actualizados, ` +
                `${bajas.borradas.length} borrados, ${plan.sinCambios} sin cambios`
            );
        }
        if (registradas > 0) console.log(`↳ 📜 ${registradas} cambios guardados en el historial`);

        run.reason = bajas.frenado ? "BORRADO_FRENADO" : huboCambios ? "HAY_CAMBIOS" : "SIN_CAMBIOS";
        run.dbCreated = plan.nuevas.length;
        run.dbUpdated = plan.modificadas.length;
        run.dbDeleted = bajas.borradas.length;
        run.dbUnchanged = plan.sinCambios;
        run.changesLogged = registradas;

        this.registrarLineaBase(ochenta, null);
        console.log("💾 PASO 2/2 completado.");

        return { success: true, guardados, desactivados: bajas.borradas.length, stockActualizado };
    }

    private async resolverPendientes(preservarStock: boolean): Promise<number> {
        const pendientes = await this.almacen.listarPendientes();
        if (pendientes.length === 0) return 0;

        if (!preservarStock) {
            await this.almacen.borrarPendientes();
            console.log(`↳ ⏳ ${pendientes.length} pendiente(s) descartados: la linea base manda`);
            return 0;
        }

        const existentes = await this.almacen.findAllIndexed();
        const deseado = new Map(pendientes.filter(p => existentes.has(p.pos_id)).map(p => [p.pos_id, p.in_stock]));
        if (deseado.size === 0) return 0;

        const plan = planificarCambiosStock(existentes, deseado);
        return this.almacen.transaccion(async tx => {
            await tx.escribirStock(plan.cambios.map(c => ({ pos_id: c.pos_id, in_stock: c.ahora })), this.ahora());
            const n = await tx.registrarHistorial(entradasDeCambios(plan.cambios));
            await tx.borrarPendientes([...deseado.keys()]);
            console.log(`↳ ⏳ ${deseado.size} pendiente(s) aplicados (${plan.cambios.length} con cambio)`);
            return n;
        });
    }

    // ================================================================
    // RECONCILIACION: linea base de 86 sobre lo que ya hay
    // ================================================================

    public async reconciliar(trigger: OrigenRun = 'scheduler', motivo = 'intervalo'): Promise<ResultadoSync> {
        const run = syncRunService.iniciar(trigger);
        this.estado.lastReconcileAttemptAt = this.ahora();

        try {
            return await this.mutex.ejecutar(async () => {
                console.log(`🔎 Reconciliación de 86 (${motivo})`);
                const ochenta = await this.fetchOchentaYSeis();
                const existentes = await this.almacen.findAllIndexed();
                run.sourceItems = existentes.size;

                if (!ochenta) {
                    // Nunca se interpreta un fallo como "nada esta agotado".
                    console.warn("⚠️ Linea base caida — no se toca ningún in_stock.");
                    run.reason = "SIN_CAMBIOS";
                    run.errorMessage = "eightysixeditems no respondio; stock conservado";
                    run.soldOutItems = [...existentes.values()].filter(i => i.in_stock === false && i.is_active === true).length;
                    this.registrarLineaBase(null, null);
                    this.cerrarCiclo(run);
                    return { success: false, guardados: 0, desactivados: 0, stockActualizado: 0, error: run.errorMessage };
                }

                const deseado = new Map([...existentes.keys()].map(id => [id, !ochenta.posIds.has(id)]));
                const plan = planificarCambiosStock(existentes, deseado);

                const registradas = plan.cambios.length === 0 ? 0 : await this.almacen.transaccion(async tx => {
                    await tx.escribirStock(plan.cambios.map(c => ({ pos_id: c.pos_id, in_stock: c.ahora })), this.ahora());
                    return tx.registrarHistorial(entradasDeCambios(plan.cambios));
                });
                await this.almacen.borrarPendientes();

                for (const c of plan.cambios) {
                    console.log(`↳ 🔧 ${c.ahora ? '68' : '86'} corregido: ${c.name} (posId: ${c.pos_id})`);
                }

                run.inventoryGuids = ochenta.entradas;
                run.soldOutItems = [...existentes.keys()].filter(id => ochenta.posIds.has(id)).length;
                run.dbUpdated = plan.cambios.length;
                run.dbUnchanged = plan.sinCambio;
                run.changesLogged = registradas;
                run.reason = plan.cambios.length > 0 ? "HAY_CAMBIOS" : "SIN_CAMBIOS";

                this.registrarLineaBase(ochenta, plan.cambios.length);
                this.cerrarCiclo(run);
                return { success: true, guardados: plan.cambios.length, desactivados: 0, stockActualizado: run.soldOutItems };
            });
        } catch (error: any) {
            console.error(`❌ Reconciliación falló: ${error.message}`);
            return this.abortar(run, error.message);
        }
    }

    /**
     * Metricas de la linea base y alertas.
     * @param corregidas filas que corrigio una reconciliacion; null en la
     *        importacion, donde los cambios de stock son esperables (filas nuevas).
     */
    private registrarLineaBase(ochenta: OchentaYSeis | null, corregidas: number | null) {
        const e = this.estado;
        e.lastReconcileOk = ochenta !== null;
        if (!ochenta) {
            e.inventoryGuids = null;
            return;
        }
        e.inventoryGuids = ochenta.entradas;
        e.lastReconcileAt = this.ahora();
        if (corregidas === null) return;

        e.lastReconcileCorrected = corregidas;
        e.consecutiveCorrections = corregidas > 0 ? e.consecutiveCorrections + 1 : 0;

        if (corregidas > this.cfg.reconcileAlertRows) {
            console.error(
                `🚨 La reconciliación corrigió ${corregidas} filas (límite ${this.cfg.reconcileAlertRows}): ` +
                `probablemente se perdieron webhooks de MenuItemAvailabilityChanged.`
            );
        }
        if (e.consecutiveCorrections >= this.cfg.reconcileAlertConsecutive) {
            console.error(
                `🚨 ${e.consecutiveCorrections} reconciliaciones seguidas corrigieron filas: ` +
                `los webhooks de stock están fallando. Revisar el receptor y la suscripción en Olo.`
            );
        }
    }

    /** Linea base de 86. null si no se pudo leer: el llamador conserva el stock. */
    private async fetchOchentaYSeis(): Promise<OchentaYSeis | null> {
        try {
            return await this.d.oloApi.fetchOchentaYSeis();
        } catch (e: any) {
            const detalle = e instanceof OloHttpError && e.status === 403
                ? ' (403: ¿falta el permiso especial de eightysixeditems?)'
                : '';
            console.error(`⚠️ No se pudo traer eightysixeditems: ${e.message}${detalle}`);
            return null;
        }
    }

    /**
     * Linea base de verificacion, coalescida: varios pedidos dentro de la espera
     * se resuelven con una sola llamada a Olo.
     */
    public programarVerificacion(motivo: string, ms = this.cfg.flapRecheckMs): void {
        if (this.verificacionProgramada) return;
        this.verificacionProgramada = setTimeout(() => {
            this.verificacionProgramada = null;
            void this.reconciliar('scheduler', motivo);
        }, ms);
    }

    /** Para tests y apagado: dispara ya la verificacion pendiente, si la hay. */
    public async ejecutarVerificacionPendiente(): Promise<boolean> {
        if (!this.verificacionProgramada) return false;
        clearTimeout(this.verificacionProgramada);
        this.verificacionProgramada = null;
        await this.reconciliar('scheduler', 'flapping');
        return true;
    }

    public cancelarTemporizadores(): void {
        if (this.verificacionProgramada) clearTimeout(this.verificacionProgramada);
        this.verificacionProgramada = null;
    }

    // ================================================================
    // CICLO DE SALUD
    // ================================================================

    /**
     * Un tick del scheduler. Hace a lo sumo UNA cosa y siempre deja una fila
     * en sync_runs, para que /api/status no caiga en warn por "atrasado":
     *   1. respaldo diario del export, si toca;
     *   2. reconciliacion, si paso el intervalo o hay silencio de webhooks;
     *   3. si no, una fila ok / SIN_CAMBIOS con el inventory_guids de la
     *      ultima linea base (NULL si fallo, que deja el semaforo en warn).
     */
    public async tick(): Promise<void> {
        const ahora = this.ahora();
        const e = this.estado;

        if (this.cfg.exportDailyAt) {
            const hoy = businessDateEnZona(ahora, this.cfg.storeTimeZone);
            const hora = horaMinutoEnZona(ahora, this.cfg.storeTimeZone);
            if (e.lastDailyExportDate === null) e.lastDailyExportDate = hora >= this.cfg.exportDailyAt ? hoy : null;
            if (e.lastDailyExportDate !== hoy && hora >= this.cfg.exportDailyAt) {
                e.lastDailyExportDate = hoy;
                console.log(`🗓️ Respaldo diario del Vendor Export (${this.cfg.exportDailyAt} hora de la tienda)`);
                const r = await this.importar('scheduler');
                if (r.success) return;
            }
        }

        const referencia = e.lastWebhookAt ?? e.lastImportAt;
        const silencio = referencia !== null && ahora.getTime() - referencia.getTime() >= this.cfg.webhookSilenceAlertMs;
        const ultimoIntento = e.lastReconcileAttemptAt?.getTime() ?? 0;
        const tocaReconciliar = ahora.getTime() - ultimoIntento >= this.cfg.reconcileIntervalMs;

        if (silencio && !this.silencioAvisado) {
            this.silencioAvisado = true;
            const min = Math.round((ahora.getTime() - referencia!.getTime()) / 60000);
            console.warn(`🔕 ${min} min sin webhooks de Olo: se reconcilia por las dudas.`);
            const r = await this.reconciliar('scheduler', 'silencio de webhooks');
            // De noche el silencio es normal (no hay ordenes). Solo es alarma si
            // la linea base encontro diferencias: eso si prueba que se pierden.
            if (r.success && (e.lastReconcileCorrected ?? 0) > 0) {
                console.error(
                    `🚨 Silencio de webhooks de ${min} min y la reconciliación encontró diferencias: ` +
                    `revisar el receptor y la suscripción en el Dashboard de Olo.`
                );
            }
            return;
        }
        if (!silencio) this.silencioAvisado = false;

        if (tocaReconciliar) {
            await this.reconciliar('scheduler', 'intervalo');
            return;
        }

        const run = syncRunService.iniciar('scheduler');
        const resumen = await this.almacen.contarResumen();
        run.reason = "SIN_CAMBIOS";
        run.inventoryGuids = e.inventoryGuids;
        run.sourceItems = resumen.activos;
        run.soldOutItems = resumen.agotados;
        run.dbUnchanged = resumen.activos;
        await syncRunService.finalizar(this.almacen, run);
    }

    // ================================================================

    private abortar(run: RunEnCurso, mensaje: string): ResultadoSync {
        syncRunService.marcarError(run, mensaje);
        this.cerrarCiclo(run);
        return { success: false, guardados: 0, desactivados: 0, stockActualizado: 0, error: mensaje };
    }

    /**
     * Cierra el ciclo y lo persiste. A diferencia de ec4toast-node se espera la
     * escritura (finalizar nunca lanza): el tick siguiente y /api/status leen
     * esa fila, y los tests necesitan verla al volver.
     */
    private cerrarCiclo(run: RunEnCurso): Promise<void> {
        console.log("⏰ ===== FIN DEL CICLO =====");
        console.log("");
        const p = syncRunService.finalizar(this.almacen, run);
        this.pendientesDeCierre.push(p);
        return p;
    }

    private pendientesDeCierre: Promise<void>[] = [];

    /** Espera a que todas las filas de sync_runs en vuelo queden escritas. */
    public async esperarCierres(): Promise<void> {
        const p = this.pendientesDeCierre;
        this.pendientesDeCierre = [];
        await Promise.all(p);
    }

    // ================================================================
    // LECTURAS (sin llamar a Olo salvo menu-categories sin export en memoria)
    // ================================================================

    /**
     * Categorias y optiongroups del ultimo export, marcando cuales estan en
     * MENU_CONFIG. Misma forma que en ec4toast-node mas `kind`.
     */
    public async getMenuCategories(): Promise<any[]> {
        if (!this.ultimoMenu) {
            this.ultimoMenu = this.parser.parsear(await this.d.oloApi.descargarVendorExport());
        }
        return recolectarCategorias(this.ultimoMenu).map(g => {
            const config = getMenuConfig(g.groupName);
            return {
                groupName: g.groupName,
                guid: g.guid,
                menuPath: g.menuPath,
                kind: g.kind,
                inConfig: config !== null,
                menuNumber: config ? config.menuNumber : null,
                includeItems: config ? config.includeItems : null,
                includeSubGroups: config ? config.includeSubGroups : null
            };
        });
    }

    /**
     * Lo que consume el servidor de OnSign. Copiado tal cual de ec4toast-node:
     * el formato de cada fila es contrato.
     */
    public async getMenuExport(soldOutIconUrl?: string): Promise<any[]> {
        const items = await this.almacen.findActiveItemsSorted();
        const icono = soldOutIconUrl ?? "";

        return items.map(item => ({
            pos_id: item.pos_id,
            menu_number: item.menu_number,
            item_type: item.item_type ?? "PRODUCT",
            category: item.category ?? "",
            parent_group: item.parent_group ?? "",
            name: item.name,
            description: item.description ?? "",
            price: item.price,
            in_stock: item.in_stock ? "Yes" : "No",
            sold_out_icon: !item.in_stock && icono ? icono : ""
        }));
    }
}
