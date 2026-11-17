/**
 * Todo en modo mock con un solo comando, sin credenciales ni MySQL:
 *
 *   bun run dev:mock
 *
 * Levanta:
 *   - mock de Olo        http://localhost:14010/v1.1/
 *   - ec4olo-node        http://localhost:18080   (almacen en memoria)
 *   - receptor           http://localhost:18090/olo/webhook
 *
 * Y despues, en otra terminal:
 *   bun run replay fixtures/ocb-scenarios/ciclo-normal.json
 *   curl -H "X-EC4-Key: dev-mock-key" http://localhost:18080/api/toast/ocb
 *
 * Puertos: DEV_MOCK_PORT, DEV_NODE_PORT, DEV_HOOK_PORT.
 *
 * Con DATABASE_URL definida y ALMACEN=mysql usa esa base en vez de memoria.
 * Todos los secretos de aca son valores de prueba obvios, no de ninguna tienda.
 */
import type { Subprocess } from 'bun';

const VENDOR = '10000000000000001';
// Puertos poco comunes a proposito: 8080 suele estar ocupado por otro servidor
// local y entonces el receptor le entrega los eventos a ese. Configurables.
const PUERTO_MOCK = process.env.DEV_MOCK_PORT || '14010';
const PUERTO_NODE = process.env.DEV_NODE_PORT || '18080';
const PUERTO_HOOK = process.env.DEV_HOOK_PORT || '18090';
const KEY = 'dev-mock-key';
const SECRETO = 'dev-mock-webhook-secret';

const comun = {
    ...process.env,
    OLO_ENV: 'mock',
    OLO_CLIENT_ID: 'mock-client-id',
    OLO_CLIENT_SECRET: 'mock-client-secret',
    OLO_VENDOR_ID: VENDOR,
    TENANT_NAME: process.env.TENANT_NAME || 'Tienda Mock',
    ALERT_WEBHOOK_URL: ''
};

const procesos: { nombre: string; p: Subprocess }[] = [];

function lanzar(nombre: string, script: string, env: Record<string, string | undefined>) {
    const p = Bun.spawn(['bun', 'run', script], { env: env as any, stdout: 'pipe', stderr: 'pipe' });
    procesos.push({ nombre, p });
    for (const flujo of [p.stdout, p.stderr] as ReadableStream<Uint8Array>[]) {
        (async () => {
            const lector = flujo.getReader();
            const decoder = new TextDecoder();
            let resto = '';
            for (;;) {
                const { value, done } = await lector.read();
                if (done) break;
                const lineas = (resto + decoder.decode(value, { stream: true })).split('\n');
                resto = lineas.pop() ?? '';
                for (const l of lineas) if (l.trim()) console.log(`[${nombre}] ${l}`);
            }
        })();
    }
    return p;
}

lanzar('olo-mock', 'tools/mock-olo/server.ts', { ...comun, MOCK_OLO_PORT: PUERTO_MOCK });
await Bun.sleep(500);

lanzar('node', 'src/index.ts', {
    ...comun,
    PORT: PUERTO_NODE,
    OLO_BASE_URL: `http://localhost:${PUERTO_MOCK}/v1.1/`,
    ALMACEN: process.env.ALMACEN || 'memoria',
    SERVICE_TOKEN: KEY,
    MENU_CONFIG: process.env.MENU_CONFIG || '[["Burgers",1],["Drinks",2]]',
    SYNC_INTERVAL_MS: '20000',
    OLO_RECONCILE_INTERVAL_MS: '60000',
    OLO_EXPORT_DAILY_AT: '',
    OCB_PICKED_UP_HIDE_AFTER_MIN: '1',
    OCB_SWEEP_INTERVAL_MS: '5000'
});

lanzar('hook', 'src/hook.ts', {
    ...comun,
    HOOK_PORT: PUERTO_HOOK,
    HOOK_DB_PATH: '.data/dev-mock-hook.sqlite',
    OLO_WEBHOOK_SECRET: SECRETO,
    OLO_WEBHOOK_URL: `http://localhost:${PUERTO_HOOK}/olo/webhook`,
    OLO_HOOK_ROUTES: JSON.stringify({ [VENDOR]: { storeId: 'tienda-mock', baseUrl: `http://localhost:${PUERTO_NODE}`, key: KEY } })
});

console.log(`
=== dev:mock ===
  mock de Olo:  http://localhost:${PUERTO_MOCK}/v1.1/
  node:         http://localhost:${PUERTO_NODE}   (X-EC4-Key: ${KEY})
  receptor:     http://localhost:${PUERTO_HOOK}/olo/webhook

  Probar el OCB:
    bun run replay fixtures/ocb-scenarios/ciclo-normal.json
    curl -H "X-EC4-Key: ${KEY}" http://localhost:${PUERTO_NODE}/api/toast/ocb

  Probar el stock:
    bun run replay fixtures/stock-scenarios/86-y-68.json
    curl -H "X-EC4-Key: ${KEY}" "http://localhost:${PUERTO_NODE}/api/toast/menu-export?soldOutIconUrl=x"

  Ctrl+C para cerrar todo.
`);

const cerrar = () => {
    for (const { p } of procesos) p.kill();
    process.exit(0);
};
process.on('SIGINT', cerrar);
process.on('SIGTERM', cerrar);
