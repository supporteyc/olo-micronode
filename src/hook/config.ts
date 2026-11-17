import { ErrorDeConfiguracion } from '../config/olo';

/**
 * Configuracion del receptor central de webhooks (ec4olo-hook).
 *
 * Brands: Olo permite UNA Destination URL por brand y ambiente, con su propio
 * secreto. No sabemos todavia si las tiendas son un brand o varios [ABIERTO],
 * asi que se soportan los dos:
 *
 *   un brand:    OLO_WEBHOOK_SECRET + OLO_WEBHOOK_URL
 *   varios:      OLO_HOOK_BRANDS=[{"key":"marca-a","secret":"...","url":"https://hook.example/olo/webhook/marca-a"}, ...]
 *
 * Con varios brands, cada uno registra en Olo su propia URL (/olo/webhook/{key})
 * y el receptor sabe que secreto usar por el path.
 *
 * Rutas: que tienda atiende cada restaurante de Olo.
 *   OLO_HOOK_ROUTES={"10000000000000001":{"storeId":"miami-1","baseUrl":"https://miami-1.internal","key":"..."}}
 */

export interface BrandHook {
    key: string;
    secret: string;
    /** Destination URL tal cual esta registrada en el Dashboard de Olo. Entra en la firma. */
    url: string;
}

export interface RutaTienda {
    storeId: string;
    baseUrl: string;
    /** X-EC4-Key de esa tienda (su SERVICE_TOKEN). */
    key: string;
}

export interface ConfigHook {
    port: number;
    dbPath: string;
    brands: BrandHook[];
    rutas: Map<string, RutaTienda>;
    /** Intervalo del worker que entrega la outbox. */
    workerIntervalMs: number;
    entregaTimeoutMs: number;
    backoffMaxMs: number;
    /** Reintentos tras los que se alerta (el evento sigue reintentandose). */
    alertarTrasIntentos: number;
    /** Dias que se conservan dedup y entregados. */
    retencionDias: number;
}

type Env = Record<string, string | undefined>;

export function leerConfigHook(env: Env = process.env): ConfigHook {
    const problemas: string[] = [];
    const brands: BrandHook[] = [];

    const crudoBrands = (env.OLO_HOOK_BRANDS || '').trim();
    if (crudoBrands) {
        try {
            const lista = JSON.parse(crudoBrands);
            if (!Array.isArray(lista)) throw new Error('no es un array');
            for (const [i, b] of lista.entries()) {
                if (!b?.key || !b?.secret || !b?.url) throw new Error(`el brand ${i} necesita key, secret y url`);
                brands.push({ key: String(b.key), secret: String(b.secret), url: String(b.url) });
            }
        } catch (e: any) {
            problemas.push(`OLO_HOOK_BRANDS mal escrito: ${e.message}`);
        }
    } else if (env.OLO_WEBHOOK_SECRET || env.OLO_WEBHOOK_URL) {
        if (!env.OLO_WEBHOOK_SECRET) problemas.push('OLO_WEBHOOK_SECRET es obligatorio si se define OLO_WEBHOOK_URL');
        if (!env.OLO_WEBHOOK_URL) problemas.push('OLO_WEBHOOK_URL es obligatorio: es parte de la firma');
        brands.push({ key: 'default', secret: env.OLO_WEBHOOK_SECRET || '', url: env.OLO_WEBHOOK_URL || '' });
    }
    if (brands.length === 0) problemas.push('No hay ningun brand: define OLO_WEBHOOK_SECRET + OLO_WEBHOOK_URL u OLO_HOOK_BRANDS');
    for (const b of brands) {
        if (b.url && !/^https?:\/\//.test(b.url)) problemas.push(`La URL del brand ${b.key} debe ser absoluta`);
    }

    const rutas = new Map<string, RutaTienda>();
    const crudoRutas = (env.OLO_HOOK_ROUTES || '').trim();
    if (crudoRutas) {
        try {
            // Las claves de un objeto JSON siempre son strings: los ids de 17
            // digitos llegan intactos sin parseo especial.
            const obj = JSON.parse(crudoRutas);
            for (const [clave, r] of Object.entries<any>(obj)) {
                if (!/^\d+$/.test(clave)) throw new Error(`la clave "${clave}" debe ser el id numerico del restaurante (como string)`);
                if (!r?.storeId || !r?.baseUrl) throw new Error(`la ruta ${clave} necesita storeId y baseUrl`);
                rutas.set(clave, { storeId: String(r.storeId), baseUrl: String(r.baseUrl).replace(/\/$/, ''), key: String(r.key ?? '') });
            }
        } catch (e: any) {
            problemas.push(`OLO_HOOK_ROUTES mal escrito: ${e.message}`);
        }
    }

    const cfg: ConfigHook = {
        port: Number(env.HOOK_PORT || env.PORT || 8090),
        dbPath: env.HOOK_DB_PATH || '.data/hook.sqlite',
        brands,
        rutas,
        workerIntervalMs: Number(env.HOOK_WORKER_INTERVAL_MS || 250),
        entregaTimeoutMs: Number(env.HOOK_DELIVERY_TIMEOUT_MS || 15_000),
        backoffMaxMs: Number(env.HOOK_BACKOFF_MAX_MS || 5 * 60_000),
        alertarTrasIntentos: Number(env.HOOK_ALERT_AFTER_ATTEMPTS || 5),
        retencionDias: Number(env.HOOK_RETENTION_DAYS || 7)
    };

    if (problemas.length > 0) throw new ErrorDeConfiguracion(problemas);
    return cfg;
}
