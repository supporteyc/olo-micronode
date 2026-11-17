import { Request, Response, NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'crypto';

/**
 * Llave compartida con el console centralizado.
 *
 * Este servidor no lo consume un navegador: lo consumen el servidor de OnSign y
 * el gateway del console, que son los unicos que conocen la llave. El navegador
 * nunca ve un token de location, y por eso este middleware puede ser tan simple.
 *
 * Si SERVICE_TOKEN no esta definido, el middleware deja pasar todo. Es a
 * proposito: asi nada se rompe en los despliegues que todavia no la tienen. El
 * arranque avisa cuando esta en ese modo.
 */
const SERVICE_TOKEN = process.env.SERVICE_TOKEN || '';

export function authHabilitado(): boolean {
    return SERVICE_TOKEN !== '';
}

/** Compara por digest para que las dos entradas midan igual y no se filtre el largo. */
function iguales(a: string, b: string): boolean {
    const da = createHash('sha256').update(a).digest();
    const db = createHash('sha256').update(b).digest();
    return timingSafeEqual(da, db);
}

export function serviceAuth(req: Request, res: Response, next: NextFunction): void {
    if (!SERVICE_TOKEN) {
        next();
        return;
    }

    const recibido = (req.header('x-ec4-key') || '').trim();

    if (recibido && iguales(recibido, SERVICE_TOKEN)) {
        next();
        return;
    }

    res.status(401).json({ error: 'Unauthorized: falta o no coincide el header X-EC4-Key.' });
}
