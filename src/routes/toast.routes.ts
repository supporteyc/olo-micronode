import { Router } from 'express';
import { ToastController } from '../controllers/toast.controller';
import type { Servicios } from '../contenedor';

/** Mismas rutas que ec4toast-node bajo /api/toast. */
export function toastRoutes(s: Servicios): Router {
    const c = new ToastController(s);
    const router = Router();

    // --- Lo que consume el servidor de OnSign ---
    router.get('/menu-export', (req, res) => { c.getMenuExport(req, res); });
    router.post('/menu-export/sync', (req, res) => { c.triggerMenuSync(req, res); });
    router.post('/menu-export/reconcile', (req, res) => { c.triggerReconcile(req, res); });

    // --- Lo que consume el dashboard ---
    router.get('/menu-categories', (req, res) => { c.getMenuCategories(req, res); });
    router.get('/test-authentication', (req, res) => { c.testAuthentication(req, res); });
    router.get('/menu-changes', (req, res) => { c.getMenuChanges(req, res); });

    // --- OCB (order confirmation board) ---
    router.get('/ocb', (req, res) => { c.getOrderStatusBoard(req, res); });

    // --- Consultas directas a Olo, para depurar (reemplazan a las de Toast) ---
    router.get('/vendor-export-status', (req, res) => { c.getVendorExportStatus(req, res); });
    router.get('/eightysixed', (req, res) => { c.getEightySixed(req, res); });
    router.get('/restaurant-info', (req, res) => { c.getRestaurantInfo(req, res); });

    // --- Control del scheduler ---
    router.post('/scheduler/pause', (req, res) => { c.pauseScheduler(req, res); });
    router.post('/scheduler/resume', (req, res) => { c.resumeScheduler(req, res); });
    router.get('/scheduler/status', (req, res) => { c.schedulerStatus(req, res); });

    return router;
}
