import express, { Router } from 'express';
import type { Servicios } from '../contenedor';

/**
 * POST /api/olo/events: la entrada de los eventos que reenvia el receptor.
 *
 * El body se lee como TEXTO, no con express.json(): los ids de Olo son int64
 * y JSON.parse los redondea. El parseo seguro lo hace oloEvents.service. Por
 * eso este router se monta ANTES del express.json() global en app.ts.
 */
export function oloRoutes(s: Servicios): Router {
    const router = Router();

    router.post('/events', express.text({ type: '*/*', limit: '5mb' }), async (req, res) => {
        try {
            const r = await s.eventos.procesar({
                tipo: req.header('x-olo-event-type') || '',
                messageId: req.header('x-olo-message-id') || '',
                rawBody: typeof req.body === 'string' ? req.body : ''
            });
            res.status(r.status).json(r.body);
        } catch (error: any) {
            // 500: el receptor reintenta. La idempotencia evita el doble efecto.
            console.error(`❌ Evento ${req.header('x-olo-event-type')} falló: ${error.message}`);
            res.status(500).json({ error: error.message });
        }
    });

    return router;
}
