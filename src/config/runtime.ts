import dotenv from 'dotenv';
dotenv.config();

/**
 * Parametros de arranque que mas de un modulo necesita leer.
 *
 * Mismo rol que en ec4toast-node: un solo lugar para el intervalo, para que el
 * scheduler y /api/status no repitan el numero.
 */

export const TENANT_NAME = process.env.TENANT_NAME || 'Location sin nombre';

/**
 * Intervalo del ciclo de salud. En Toast era el polling de 78 s; aca el tick NO
 * llama a Olo (el polling de menu no esta permitido): solo escribe sync_runs
 * para que el semaforo del console funcione, y decide si toca reconciliar.
 *
 * SYNC_INTERVAL_MS es el nombre nuevo; TOAST_SYNC_INTERVAL_MS se acepta como
 * alias para poder reusar el .env de una tienda sin renombrar nada.
 */
export const SYNC_INTERVAL_MS = Number(
    process.env.SYNC_INTERVAL_MS || process.env.TOAST_SYNC_INTERVAL_MS || 78_000
);

/**
 * El valor de `side` en /api/status. Queda en "toast" hasta que Andres confirme
 * que el console acepta "olo". [PEDIR-A-ANDRES]
 */
export const STATUS_SIDE = process.env.STATUS_SIDE || 'toast';

/** Marca de arranque del proceso, para reportar uptime. */
export const BOOT_TIME = new Date();
