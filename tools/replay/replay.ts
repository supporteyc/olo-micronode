/**
 * Replay de webhooks de Olo firmados, contra el receptor (o directo a un node).
 *
 *   bun run replay fixtures/webhooks/OrderPlaced.json
 *   bun run replay fixtures/ocb-scenarios/ciclo-normal.json
 *   bun run replay fixtures/webhooks/MenuItemAvailabilityChanged.json --dup 3
 *
 * Firma con la misma funcion que verifica el receptor (seccion 5.3 del prompt),
 * genera X-Olo-Message-Id y X-Olo-Timestamp (ticks de .NET) y hace POST.
 *
 * Opciones:
 *   --url URL          destino del POST (default http://localhost:18090/olo/webhook)
 *   --firmar-con URL   Destination URL que entra en la firma (default = --url)
 *   --secret S         secreto (default OLO_WEBHOOK_SECRET o el de dev:mock)
 *   --tipo T           X-Olo-Event-Type (default: nombre del archivo)
 *   --dup N            manda cada evento N veces con el MISMO message id (reintentos de Olo)
 *   --rafaga N         manda N copias a la vez, cada una con su message id
 *   --invertir         en un escenario, manda los pasos en orden inverso (fuera de orden)
 *   --mezclar          en un escenario, orden aleatorio
 *   --sin-ajuste       no mueve las horas del payload a "ahora"
 *   --tz ZONA          zona de la tienda para el ajuste (default America/New_York)
 *
 * Escenario: {"pasos":[{"evento":"OrderPlaced","fixture":"OrderPlaced.json","esperarMs":0}, ...]}
 * Los fixtures se buscan en fixtures/webhooks.
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { firmarWebhook } from '../../src/services/oloWebhook.service';
import { partesEnZona } from '../../src/lib/tiempo';

interface Paso { evento: string; fixture: string; esperarMs?: number }

const args = process.argv.slice(2);
function opcion(nombre: string, porDefecto?: string): string | undefined {
    const i = args.indexOf(`--${nombre}`);
    return i >= 0 ? args[i + 1] : porDefecto;
}
const bandera = (nombre: string) => args.includes(`--${nombre}`);

const archivo = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true);
if (!archivo) {
    console.error('Uso: bun run replay <fixture.json | escenario.json> [opciones]. Ver el encabezado de tools/replay/replay.ts');
    process.exit(1);
}

const URL_DESTINO = opcion('url', 'http://localhost:18090/olo/webhook')!;
const URL_FIRMA = opcion('firmar-con', URL_DESTINO)!;
const SECRETO = opcion('secret', process.env.OLO_WEBHOOK_SECRET || 'dev-mock-webhook-secret')!;
const TZ = opcion('tz', 'America/New_York')!;
const DIR_FIXTURES = join(import.meta.dir, '..', '..', 'fixtures', 'webhooks');

/** Ticks UTC de .NET: intervalos de 100 ns desde 0001-01-01. */
function ticksDotNet(ms = Date.now()): string {
    return (BigInt(ms) * 10000n + 621355968000000000n).toString();
}

const FORMATO = /"(\d{8}) (\d{2}):(\d{2})"/g;

function aMinutos(fecha: string, h: string, m: string): number {
    const d = Date.UTC(+fecha.slice(0, 4), +fecha.slice(4, 6) - 1, +fecha.slice(6, 8), +h, +m);
    return d / 60000;
}

function deMinutos(min: number): string {
    const d = new Date(min * 60000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * Mueve todas las horas "yyyymmdd hh:mm" para que timePlaced sea "ahora" en la
 * tienda, conservando las distancias. La hora propia del evento (recogida,
 * cancelacion, llegada) se pone en "ahora": es cuando el evento ocurre.
 */
function ajustarHoras(body: string, evento: string): string {
    const placed = /"timePlaced":"(\d{8}) (\d{2}):(\d{2})"/.exec(body);
    if (!placed) return body;
    const p = partesEnZona(new Date(), TZ);
    const ahora = Date.UTC(p.anio, p.mes - 1, p.dia, p.hora, p.minuto) / 60000;
    const delta = ahora - aMinutos(placed[1], placed[2], placed[3]);
    let r = body.replace(FORMATO, (_, f, h, m) => `"${deMinutos(aMinutos(f, h, m) + delta)}"`);
    const propio: Record<string, string> = {
        OrderPickedUp: 'timePickedUp', OrderCancelled: 'timeCancelled', CustomerArrived: 'timeArrived'
    };
    if (propio[evento]) r = r.replace(new RegExp(`"${propio[evento]}":"[^"]*"`), `"${propio[evento]}":"${deMinutos(ahora)}"`);
    return r;
}

async function enviar(evento: string, body: string, messageId = crypto.randomUUID()) {
    const ts = ticksDotNet();
    const r = await fetch(URL_DESTINO, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Olo-Event-Type': evento,
            'X-Olo-Message-Id': messageId,
            'X-Olo-Timestamp': ts,
            'X-Olo-Signature': firmarWebhook(SECRETO, URL_FIRMA, body, messageId, ts)
        },
        body
    });
    console.log(`${r.status} ${evento} ${messageId} ${(await r.text()).substring(0, 120)}`);
}

async function mandarPaso(evento: string, rawFixture: string) {
    const body = bandera('sin-ajuste') ? rawFixture : ajustarHoras(rawFixture, evento);
    const dup = Number(opcion('dup', '1'));
    const rafaga = Number(opcion('rafaga', '1'));

    if (rafaga > 1) {
        await Promise.all(Array.from({ length: rafaga }, () => enviar(evento, body)));
        return;
    }
    const id = crypto.randomUUID();
    for (let i = 0; i < dup; i++) await enviar(evento, body, id);
}

const contenido = readFileSync(archivo, 'utf-8').trim();
const json = JSON.parse(contenido);

if (json && Array.isArray(json.pasos)) {
    let pasos: Paso[] = json.pasos;
    if (bandera('invertir')) pasos = [...pasos].reverse();
    if (bandera('mezclar')) pasos = [...pasos].sort(() => Math.random() - 0.5);
    console.log(`Escenario ${basename(archivo)}: ${pasos.length} pasos -> ${URL_DESTINO}`);
    for (const paso of pasos) {
        if (paso.esperarMs) await Bun.sleep(paso.esperarMs);
        const ruta = paso.fixture.includes('/') ? join(dirname(archivo), paso.fixture) : join(DIR_FIXTURES, paso.fixture);
        await mandarPaso(paso.evento, readFileSync(ruta, 'utf-8').trim());
    }
} else {
    const evento = opcion('tipo', basename(archivo).replace(/\.json$/, ''))!;
    await mandarPaso(evento, contenido);
}
