import { Request, Response } from 'express';
import type { Servicios } from '../contenedor';

/**
 * Las rutas /api/toast/* con Olo detras. El nombre del archivo y el prefijo se
 * conservan a proposito: el servidor de OnSign y el console llaman a estas
 * rutas y no deben cambiar.
 *
 * Las rutas de depuracion que llamaban a Toast (orders, restaurant-info,
 * inventory, menus-v2) se reemplazan por sus equivalentes de Olo; ver
 * docs/ARCHITECTURE.md.
 */
export class ToastController {

    constructor(private s: Servicios) {}

    /** El export que consume el servidor de OnSign. withCount -> { totalItems, items }. */
    public async getMenuExport(req: Request, res: Response): Promise<void> {
        try {
            const soldOutIconUrl = req.query.soldOutIconUrl as string | undefined;
            const withCount = String(req.query.withCount ?? 'false') === 'true';

            const items = await this.s.menuSync.getMenuExport(soldOutIconUrl);

            if (withCount) {
                res.json({ totalItems: items.length, items });
                return;
            }
            res.json(items);
        } catch (error: any) {
            res.status(500).json({ error: `Error interno al procesar menu-export: ${error.message}` });
        }
    }

    /** Fuerza una importacion (Vendor Export + linea base) sin esperar al scheduler. */
    public async triggerMenuSync(req: Request, res: Response): Promise<void> {
        try {
            const resultado = await this.s.menuSync.importar('manual');
            if (!resultado.success) {
                res.status(500).json({ status: 'error', message: resultado.error, ...resultado });
                return;
            }
            res.json({ status: 'ok', message: 'Sync completed', ...resultado });
        } catch (error: any) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    }

    /** Nuevo: fuerza solo la linea base de 86, sin descargar el export. */
    public async triggerReconcile(req: Request, res: Response): Promise<void> {
        try {
            const resultado = await this.s.menuSync.reconciliar('manual', 'manual');
            res.status(resultado.success ? 200 : 500).json({
                status: resultado.success ? 'ok' : 'error',
                message: resultado.success ? 'Reconcile completed' : resultado.error,
                ...resultado
            });
        } catch (error: any) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    }

    /** Categorias y optiongroups del Vendor Export, y cuales estan en MENU_CONFIG. */
    public async getMenuCategories(req: Request, res: Response): Promise<void> {
        try {
            res.json(await this.s.menuSync.getMenuCategories());
        } catch (error: any) {
            res.status(500).json({ error: `Error al obtener categorías: ${error.message}` });
        }
    }

    /** Prueba la firma OloSignature contra vendorexport/status. */
    public async testAuthentication(req: Request, res: Response): Promise<void> {
        const resultado = await this.s.oloApi.testAuthentication();
        res.status(resultado.ok ? 200 : 500).json(resultado);
    }

    /** Depuracion: GET /vendorexport/status crudo. ?changedsince=yyyyMMdd */
    public async getVendorExportStatus(req: Request, res: Response): Promise<void> {
        try {
            const changedsince = req.query.changedsince as string | undefined;
            res.type('application/json').send(await this.s.oloApi.getVendorExportStatusRaw(changedsince));
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    }

    /** Depuracion: eightysixeditems crudo (reemplaza a /inventory de Toast). */
    public async getEightySixed(req: Request, res: Response): Promise<void> {
        try {
            res.type('application/json').send(await this.s.oloApi.getEightySixedRaw());
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    }

    /** Depuracion: GET /restaurants/{id} crudo (reemplaza a /restaurant-info de Toast). */
    public async getRestaurantInfo(req: Request, res: Response): Promise<void> {
        try {
            res.type('application/json').send(await this.s.oloApi.getRestaurantRaw());
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    }

    /** Historial de cambios del menu. ?posId=xxx, ?limit=N (tope 1000). */
    public async getMenuChanges(req: Request, res: Response): Promise<void> {
        try {
            const limite = Number(req.query.limit ?? 100);
            const posId = req.query.posId as string | undefined;
            res.json(await this.s.almacen.listarHistorial(Number.isFinite(limite) ? limite : 100, posId));
        } catch (error: any) {
            res.status(500).json({
                error: error.message,
                hint: "¿Ya corriste sql/001_create_menu_item_changes.sql contra la base?"
            });
        }
    }

    /** Order Confirmation Board. ?businessDate=aaaammdd, ?restaurantId=xxx. */
    public async getOrderStatusBoard(req: Request, res: Response): Promise<void> {
        try {
            const restaurantId = req.query.restaurantId as string | undefined;
            const crudo = req.query.businessDate as string | undefined;

            let businessDate: number | undefined;
            if (crudo !== undefined) {
                if (!/^\d{8}$/.test(crudo)) {
                    res.status(400).json({
                        error: `businessDate debe ser aaaammdd (8 dígitos). Recibido: "${crudo}"`
                    });
                    return;
                }
                businessDate = Number(crudo);
            }

            res.json(await this.s.ocb.getOrderStatusBoard(restaurantId, businessDate));
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    }

    public pauseScheduler(req: Request, res: Response): void {
        this.s.menuSync.pauseScheduler();
        console.log("⏸️ Scheduler pausado manualmente.");
        res.json({ paused: true, message: "Scheduler pausado. Llama /scheduler/resume para reanudar." });
    }

    public resumeScheduler(req: Request, res: Response): void {
        this.s.menuSync.resumeScheduler();
        console.log("▶️ Scheduler reanudado.");
        res.json({ paused: false, message: "Scheduler reanudado." });
    }

    public schedulerStatus(req: Request, res: Response): void {
        res.json({ paused: this.s.menuSync.isSchedulerPaused() });
    }
}
