import dotenv from 'dotenv';
dotenv.config();

/**
 * Configuracion de Olo y del OCB, leida y validada en un solo lugar.
 *
 * A diferencia de menuConfig.ts (que lee process.env al evaluarse), esto es una
 * funcion pura sobre un objeto env: los tests arman configuraciones distintas
 * sin tocar process.env ni depender del orden de los import.
 *
 * Todos los intervalos son sugerencias iniciales, no datos de Olo: Olo no
 * publica rate limits ni la frecuencia permitida de eightysixeditems.
 * PENDIENTE DE CONFIRMAR CON OLO.
 */

export type OloEnv = 'mock' | 'sandbox' | 'production';

export interface ConfigOlo {
    env: OloEnv;
    /** Con barra final: https://ordering.api.olo.com/v1.1/ */
    baseUrl: string;
    clientId: string;
    clientSecret: string;
    userAgent: string;
    /** Id del restaurante de esta tienda (VendorId = locationId en los webhooks). */
    vendorId: string;
    /**
     * Si el path que se firma incluye el prefijo /v1.1/. La coleccion Postman
     * oficial lo incluye. [VALIDAR-CON-OLO] contra el Sandbox.
     */
    firmarConVersion: boolean;
    timeoutMs: number;
    /** Reintentos ante 429 o 5xx en la Ordering API. */
    maxReintentos: number;

    /** Zona horaria IANA de la tienda: horario del export diario y businessDate del OCB. */
    storeTimeZone: string;

    reconcileIntervalMs: number;
    reconcileAlertRows: number;
    reconcileAlertConsecutive: number;
    /** HH:mm local de la tienda, o null para no programar el respaldo diario. */
    exportDailyAt: string | null;
    webhookSilenceAlertMs: number;
    flapWindowMs: number;
    flapRecheckMs: number;
    /** Niveles de optiongroups que se aplanan. 1 = solo los del producto. [PEDIR-A-ANDRES] */
    modifierDepth: number;
    /** trigger_source de la importacion disparada por VendorMenuExportComplete. [PEDIR-A-ANDRES] */
    webhookTriggerSource: 'scheduler' | 'webhook';
}

export interface ConfigOcb {
    pickedUpHideAfterMin: number;
    cancelledHideAfterMin: number;
    maxTtlMin: number;
    showReadyOnClosed: boolean;
    /** null = la tienda usa Expo y la orden se retira con OrderPickedUp. */
    hideOnClosedAfterMin: number | null;
    advanceThresholdMin: number;
    placedStatus: 'IN_PREPARATION' | 'RECEIVED';
    extendedStatus: boolean;
    displayNumberSource: 'posRef' | 'orderIdString' | 'firstName';
    sweepIntervalMs: number;
    /**
     * deliveryMethod que se muestran en el board. Un delivery o dispatch no se
     * retira en el mostrador y no deberia ocupar la pantalla. [PEDIR-A-ANDRES]
     * Vacio = se muestran todos.
     */
    deliveryMethods: string[];
}

export class ErrorDeConfiguracion extends Error {
    constructor(public problemas: string[]) {
        super(`Configuracion invalida:\n - ${problemas.join('\n - ')}`);
        this.name = 'ErrorDeConfiguracion';
    }
}

type Env = Record<string, string | undefined>;

const BASE_URLS: Record<OloEnv, string> = {
    production: 'https://ordering.api.olo.com/v1.1/',
    sandbox: 'https://ordering.api.olosandbox.com/v1.1/',
    mock: 'http://localhost:4010/v1.1/'
};

function entero(env: Env, nombre: string, porDefecto: number, problemas: string[], minimo = 0): number {
    const crudo = env[nombre];
    if (crudo === undefined || crudo.trim() === '') return porDefecto;
    const n = Number(crudo);
    if (!Number.isFinite(n) || n < minimo) {
        problemas.push(`${nombre} debe ser un numero >= ${minimo} (recibido "${crudo}")`);
        return porDefecto;
    }
    return n;
}

function booleano(env: Env, nombre: string, porDefecto: boolean): boolean {
    const crudo = (env[nombre] ?? '').trim().toLowerCase();
    if (crudo === '') return porDefecto;
    return crudo === 'true' || crudo === '1' || crudo === 'yes';
}

function zonaValida(tz: string): boolean {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

export function leerConfigOlo(env: Env = process.env): ConfigOlo {
    const problemas: string[] = [];

    const envCrudo = (env.OLO_ENV || 'mock').trim() as OloEnv;
    if (!['mock', 'sandbox', 'production'].includes(envCrudo)) {
        problemas.push(`OLO_ENV debe ser mock, sandbox o production (recibido "${envCrudo}")`);
    }
    const oloEnv: OloEnv = BASE_URLS[envCrudo] ? envCrudo : 'mock';

    let baseUrl = (env.OLO_BASE_URL || BASE_URLS[oloEnv]).trim();
    if (!baseUrl.endsWith('/')) baseUrl += '/';

    const clientId = (env.OLO_CLIENT_ID || '').trim();
    const clientSecret = (env.OLO_CLIENT_SECRET || '').trim();
    const vendorId = (env.OLO_VENDOR_ID || '').trim();

    // En mock se arranca sin credenciales: el mock acepta los valores de prueba.
    if (oloEnv !== 'mock') {
        if (!clientId) problemas.push('OLO_CLIENT_ID es obligatorio fuera de OLO_ENV=mock');
        if (!clientSecret) problemas.push('OLO_CLIENT_SECRET es obligatorio fuera de OLO_ENV=mock');
    }
    if (vendorId && !/^\d+$/.test(vendorId)) {
        problemas.push(`OLO_VENDOR_ID debe ser numerico (recibido "${vendorId}")`);
    }
    if (!vendorId && oloEnv !== 'mock') problemas.push('OLO_VENDOR_ID es obligatorio fuera de OLO_ENV=mock');

    const storeTimeZone = (env.OLO_STORE_TIMEZONE || 'America/New_York').trim();
    if (!zonaValida(storeTimeZone)) problemas.push(`OLO_STORE_TIMEZONE no es una zona IANA valida: "${storeTimeZone}"`);

    const exportDailyAt = (env.OLO_EXPORT_DAILY_AT ?? '04:00').trim() || null;
    if (exportDailyAt && !/^([01]\d|2[0-3]):[0-5]\d$/.test(exportDailyAt)) {
        problemas.push(`OLO_EXPORT_DAILY_AT debe ser HH:mm (recibido "${exportDailyAt}")`);
    }

    const webhookTrigger = (env.OLO_WEBHOOK_TRIGGER_SOURCE || 'scheduler').trim();

    const cfg: ConfigOlo = {
        env: oloEnv,
        baseUrl,
        clientId: clientId || (oloEnv === 'mock' ? 'mock-client-id' : ''),
        clientSecret: clientSecret || (oloEnv === 'mock' ? 'mock-client-secret' : ''),
        userAgent: (env.OLO_USER_AGENT || 'EyeCatchNetworks/v1').trim(),
        vendorId: vendorId || (oloEnv === 'mock' ? '10000000000000001' : ''),
        firmarConVersion: booleano(env, 'OLO_SIGN_PATH_WITH_VERSION', true),
        timeoutMs: entero(env, 'OLO_TIMEOUT_MS', 20_000, problemas, 1000),
        maxReintentos: entero(env, 'OLO_MAX_RETRIES', 3, problemas, 0),
        storeTimeZone,
        reconcileIntervalMs: entero(env, 'OLO_RECONCILE_INTERVAL_MS', 600_000, problemas, 60_000),
        reconcileAlertRows: entero(env, 'OLO_RECONCILE_ALERT_ROWS', 5, problemas, 1),
        reconcileAlertConsecutive: entero(env, 'OLO_RECONCILE_ALERT_CONSECUTIVE', 3, problemas, 1),
        exportDailyAt,
        webhookSilenceAlertMs: entero(env, 'OLO_WEBHOOK_SILENCE_ALERT_MS', 3 * 60 * 60 * 1000, problemas, 60_000),
        flapWindowMs: entero(env, 'OLO_FLAP_WINDOW_MS', 60_000, problemas, 0),
        flapRecheckMs: entero(env, 'OLO_FLAP_RECHECK_MS', 30_000, problemas, 0),
        modifierDepth: entero(env, 'OLO_MODIFIER_DEPTH', 1, problemas, 0),
        webhookTriggerSource: webhookTrigger === 'webhook' ? 'webhook' : 'scheduler'
    };

    if (problemas.length > 0) throw new ErrorDeConfiguracion(problemas);
    return cfg;
}

export function leerConfigOcb(env: Env = process.env): ConfigOcb {
    const problemas: string[] = [];

    const placed = (env.OCB_PLACED_STATUS || 'IN_PREPARATION').trim();
    if (placed !== 'IN_PREPARATION' && placed !== 'RECEIVED') {
        problemas.push(`OCB_PLACED_STATUS debe ser IN_PREPARATION o RECEIVED (recibido "${placed}")`);
    }

    const fuente = (env.OCB_DISPLAY_NUMBER_SOURCE || 'posRef').trim();
    if (!['posRef', 'orderIdString', 'firstName'].includes(fuente)) {
        problemas.push(`OCB_DISPLAY_NUMBER_SOURCE debe ser posRef, orderIdString o firstName (recibido "${fuente}")`);
    }

    const hideOnClosed = (env.OCB_HIDE_ON_CLOSED_AFTER_MIN || '').trim();

    const cfg: ConfigOcb = {
        pickedUpHideAfterMin: entero(env, 'OCB_PICKED_UP_HIDE_AFTER_MIN', 2, problemas),
        cancelledHideAfterMin: entero(env, 'OCB_CANCELLED_HIDE_AFTER_MIN', 1, problemas),
        maxTtlMin: entero(env, 'OCB_MAX_TTL_MIN', 120, problemas, 1),
        showReadyOnClosed: booleano(env, 'OCB_SHOW_READY_ON_CLOSED', true),
        hideOnClosedAfterMin: hideOnClosed === '' ? null : entero(env, 'OCB_HIDE_ON_CLOSED_AFTER_MIN', 0, problemas),
        advanceThresholdMin: entero(env, 'OCB_ADVANCE_THRESHOLD_MIN', 45, problemas),
        placedStatus: placed === 'RECEIVED' ? 'RECEIVED' : 'IN_PREPARATION',
        extendedStatus: booleano(env, 'OCB_EXTENDED_STATUS', false),
        displayNumberSource: fuente as ConfigOcb['displayNumberSource'],
        sweepIntervalMs: entero(env, 'OCB_SWEEP_INTERVAL_MS', 20_000, problemas, 1000),
        deliveryMethods: (env.OCB_DELIVERY_METHODS ?? 'pickup,curbside,dinein')
            .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    };

    if (problemas.length > 0) throw new ErrorDeConfiguracion(problemas);
    return cfg;
}
