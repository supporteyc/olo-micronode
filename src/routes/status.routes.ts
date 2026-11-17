import { Router } from 'express';
import { StatusController } from '../controllers/status.controller';
import type { Servicios } from '../contenedor';

export function statusRoutes(s: Servicios): Router {
    const c = new StatusController(s);
    const router = Router();
    router.get('/status', (req, res) => { c.getStatus(req, res); });
    router.get('/runs', (req, res) => { c.getRuns(req, res); });
    return router;
}
