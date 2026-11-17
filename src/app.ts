import express from 'express';
import cors from 'cors';
import { serviceAuth } from './middleware/serviceAuth';
import { logMemory } from './logger';
import { toastRoutes } from './routes/toast.routes';
import { statusRoutes } from './routes/status.routes';
import { oloRoutes } from './routes/olo.routes';
import type { Servicios } from './contenedor';

/**
 * La app HTTP de una tienda, separada del arranque para poder levantarla en los
 * tests con un almacen en memoria. Mismo orden que index.ts de ec4toast-node.
 */
export function crearApp(s: Servicios) {
    // Prisma devuelve BigInt en los ids y JSON.stringify no sabe serializarlo.
    // Number() como en ec4toast-node: son ids autoincrementales de MySQL, lejos
    // de 2^53. Los ids de Olo nunca pasan por aca: viven como string.
    (BigInt.prototype as any).toJSON = function () {
        return Number(this);
    };

    const app = express();
    app.use(cors());

    app.get('/health', (req, res) => {
        res.status(200).json({ status: 'OK', message: 'Servidor Olo operando correctamente.' });
    });

    app.use('/api', serviceAuth);

    // Antes del express.json() global: necesita el body crudo (ids int64).
    app.use('/api/olo', oloRoutes(s));

    app.use(express.json());

    app.get('/api/logs', (req, res) => {
        res.json(logMemory);
    });

    app.use('/api', statusRoutes(s));
    app.use('/api/toast', toastRoutes(s));

    return app;
}
