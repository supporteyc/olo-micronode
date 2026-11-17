import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import { instalarLogger } from './logger';
instalarLogger('Olo');

import { crearApp } from './app';
import { crearServicios } from './contenedor';
import { crearAlmacen } from './almacen';
import { asegurarEsquema } from './services/schema.service';
import { leerConfigOcb, leerConfigOlo, ErrorDeConfiguracion } from './config/olo';
import { menuConfigSize, menuConfigOrigen, menuConfigGrupos } from './config/menuConfig';
import { authHabilitado } from './middleware/serviceAuth';
import { SYNC_INTERVAL_MS, TENANT_NAME, STATUS_SIDE } from './config/runtime';

/**
 * Arranque de ec4olo-node. Mismo orden que ec4toast-node: logger, config,
 * esquema, rutas, primer ciclo y scheduler.
 */

let cfg, cfgOcb, almacenElegido;
try {
    cfg = leerConfigOlo();
    cfgOcb = leerConfigOcb();
    almacenElegido = crearAlmacen();
} catch (e: any) {
    // Sin configuracion valida no hay nada util que hacer: mejor morir al
    // arrancar que quedar vivo escribiendo basura.
    console.error(e instanceof ErrorDeConfiguracion ? e.message : `No se pudo arrancar: ${e.message}`);
    process.exit(1);
}

const servicios = crearServicios({ almacen: almacenElegido.almacen, cfg, cfgOcb });
const app = crearApp(servicios);
const PORT = process.env.PORT || 8080;

const server = app.listen(PORT, async () => {
    console.log(`Servidor Olo (Node) corriendo en el puerto ${PORT}`);
    console.log(`Location: ${TENANT_NAME} | OLO_ENV=${cfg.env} | vendor ${cfg.vendorId} | side=${STATUS_SIDE}`);
    console.log(`MENU_CONFIG: ${menuConfigSize()} grupos desde ${menuConfigOrigen()}`);
    if (menuConfigSize() > 0) console.log(`  grupos: ${menuConfigGrupos().join(', ')}`);
    console.log(`Ciclo de salud: ${SYNC_INTERVAL_MS} ms | reconciliación: ${cfg.reconcileIntervalMs} ms`);

    if (almacenElegido.tipo === 'memoria') {
        console.warn("⚠️ ALMACEN en memoria: nada se guarda en MySQL y todo se pierde al reiniciar. Solo para mock y desarrollo.");
    }
    if (!authHabilitado()) {
        console.warn(
            "SERVICE_TOKEN no esta definido: /api queda abierto sin autenticacion. " +
            "Definilo antes de exponer este servidor al console."
        );
    }
    if (menuConfigSize() === 0) {
        console.error("MENU_CONFIG esta vacio: ningun grupo pasara el filtro y no se exportara nada.");
    }

    if (almacenElegido.tipo === 'mysql') await asegurarEsquema();

    // Estado inicial de la tienda, best effort.
    servicios.oloApi.getRestaurantRaw()
        .then(raw => servicios.storeHealth.inicializarDesdeRestaurante(raw))
        .catch(e => console.warn(`No se pudo leer el estado inicial de la tienda: ${e.message}`));

    // Primer ciclo al arrancar: importacion + linea base.
    servicios.menuSync.arrancar().catch(err => console.error("Error en el sync inicial:", err));

    // Misma guarda de --hot que ec4toast-node: los timers del build anterior
    // sobreviven a la recarga y se apilarian.
    const g = globalThis as any;
    if (g.__oloSyncInterval) {
        clearInterval(g.__oloSyncInterval);
        clearInterval(g.__oloSweepInterval);
        console.warn("Recarga en caliente: se canceló el scheduler anterior.");
    }

    const syncInterval = setInterval(() => {
        servicios.menuSync.autoSync().catch(err => console.error("Error en el scheduler de sync:", err));
    }, SYNC_INTERVAL_MS);

    const sweepInterval = setInterval(() => {
        servicios.ocb.barrer().catch(err => console.error("Error en el barrido del OCB:", err));
    }, cfgOcb.sweepIntervalMs);

    g.__oloSyncInterval = syncInterval;
    g.__oloSweepInterval = sweepInterval;

    const gracefulShutdown = () => {
        console.log('Senal de apagado recibida. Deteniendo el scheduler...');
        clearInterval(syncInterval);
        clearInterval(sweepInterval);
        servicios.menuSync.cancelarTemporizadores();
        g.__oloSyncInterval = undefined;
        server.close(() => {
            console.log('Servidor HTTP cerrado.');
            process.exit(0);
        });
    };

    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);
});
