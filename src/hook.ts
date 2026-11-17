import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import { instalarLogger } from './logger';
instalarLogger('Olo hook');

import { leerConfigHook } from './hook/config';
import { OutboxSqlite } from './hook/outbox';
import { crearReceptor, HttpForwarder } from './hook/receptor';
import { ErrorDeConfiguracion } from './config/olo';

/**
 * Segundo entrypoint del repo: el receptor central de webhooks de Olo.
 *   bun run start:hook
 * Un solo despliegue para todas las tiendas (un webhook por brand y ambiente).
 */

let cfg;
try {
    cfg = leerConfigHook();
} catch (e: any) {
    console.error(e instanceof ErrorDeConfiguracion ? e.message : `No se pudo arrancar el receptor: ${e.message}`);
    process.exit(1);
}

const outbox = new OutboxSqlite(cfg.dbPath);
const receptor = crearReceptor(cfg, outbox, new HttpForwarder(cfg.entregaTimeoutMs));

const server = Bun.serve({
    port: cfg.port,
    fetch: req => receptor.manejar(req)
});

receptor.iniciarWorker();

const purga = setInterval(() => {
    const n = outbox.purgar(Date.now() - cfg.retencionDias * 24 * 60 * 60 * 1000);
    if (n > 0) console.log(`Outbox: ${n} registro(s) viejos purgados`);
}, 60 * 60 * 1000);

console.log(`Receptor de Olo escuchando en el puerto ${server.port}`);
console.log(`  brands: ${cfg.brands.map(b => `${b.key} -> ${b.url}`).join(', ')}`);
console.log(`  rutas:  ${[...cfg.rutas.entries()].map(([k, r]) => `${k} -> ${r.storeId}`).join(', ') || '(ninguna)'}`);
console.log(`  outbox: ${cfg.dbPath}`);

const apagar = () => {
    console.log('Senal de apagado: deteniendo el receptor...');
    receptor.detener();
    clearInterval(purga);
    server.stop();
    outbox.cerrar();
    process.exit(0);
};
process.on('SIGINT', apagar);
process.on('SIGTERM', apagar);
