import type { Server } from 'node:http';
import { crearMockOlo, type MockOlo } from '../tools/mock-olo/mockOlo';
import { AlmacenMemoria } from '../src/almacen/memoria';
import { crearServicios, type Servicios } from '../src/contenedor';
import { crearApp } from '../src/app';
import { leerConfigOcb, leerConfigOlo } from '../src/config/olo';

/**
 * Arma una tienda completa para un test: mock de Olo en un puerto libre,
 * almacen en memoria con el mismo comportamiento que MySQL, servicios y la app
 * HTTP real. Nada de esto toca la red fuera de localhost.
 */

export const VENDOR = '10000000000000001';
export const OTRA_TIENDA = '10000000000000002';

/** Ids del fixture SYNTHETIC (fixtures/vendor-export/synthetic.xml). 17 digitos. */
export const P1 = '90000000000000011'; // Classic Burger (isdisabled=true)
export const P2 = '90000000000000012'; // Double Burger
export const P3 = '90000000000000013'; // Lemonade (availability de horario)
export const P4 = '90000000000000014'; // Off Menu (categoria fuera de MENU_CONFIG)
export const O1 = '90000000000000021'; // Fries
export const O2 = '90000000000000022'; // Salad

export class Reloj {
    constructor(public t = Date.parse('2026-11-17T15:00:00Z')) {}
    ahora = () => new Date(this.t);
    avanzar(ms: number) { this.t += ms; }
}

export interface Tienda {
    mock: MockOlo;
    almacen: AlmacenMemoria;
    s: Servicios;
    reloj: Reloj;
    url: string;
    errores: string[];
    /** POST /api/olo/events como lo haria el receptor. */
    evento(tipo: string, cuerpo: unknown, messageId?: string): Promise<{ status: number; body: any }>;
    get(path: string): Promise<any>;
    marcar86(products: string[], choices?: string[]): void;
    detener(): Promise<void>;
}

let contador = 0;
export function nuevoMessageId(): string {
    contador++;
    return `00000000-0000-4000-8000-${String(contador).padStart(12, '0')}`;
}

export async function armarTienda(env: Record<string, string> = {}, xml?: string): Promise<Tienda> {
    const mock = crearMockOlo({ vendorId: VENDOR });
    if (xml) mock.estado.xml = xml;

    const reloj = new Reloj();
    const cfg = leerConfigOlo({
        OLO_ENV: 'mock',
        OLO_BASE_URL: mock.baseUrl,
        OLO_VENDOR_ID: VENDOR,
        OLO_MAX_RETRIES: '0',
        OLO_EXPORT_DAILY_AT: '',
        OLO_STORE_TIMEZONE: 'America/New_York',
        ...env
    });
    const cfgOcb = leerConfigOcb(env);
    const almacen = new AlmacenMemoria();
    const s = crearServicios({ almacen, cfg, cfgOcb, reloj: reloj.ahora, dormir: async () => {} });

    // Las alertas son console.error: se capturan para poder afirmar sobre ellas.
    const errores: string[] = [];
    const errorOriginal = console.error;
    console.error = (...a: any[]) => { errores.push(a.map(String).join(' ')); };
    const logOriginal = console.log;
    const warnOriginal = console.warn;
    if (process.env.TEST_VERBOSE !== 'true') {
        console.log = () => {};
        console.warn = () => {};
    }

    const server: Server = crearApp(s).listen(0);
    await new Promise(r => server.once('listening', r));
    const puerto = (server.address() as any).port;
    const url = `http://localhost:${puerto}`;

    return {
        mock, almacen, s, reloj, url, errores,
        async evento(tipo, cuerpo, messageId = nuevoMessageId()) {
            const r = await fetch(`${url}/api/olo/events`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Olo-Event-Type': tipo,
                    'X-Olo-Message-Id': messageId
                },
                body: typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)
            });
            return { status: r.status, body: await r.json() };
        },
        async get(path) {
            return (await fetch(`${url}${path}`)).json();
        },
        marcar86(products, choices = []) {
            mock.estado.productos86 = new Set(products);
            mock.estado.opciones86 = new Set(choices);
        },
        async detener() {
            s.menuSync.cancelarTemporizadores();
            await s.menuSync.esperarCierres();
            server.close();
            mock.detener();
            console.error = errorOriginal;
            console.log = logOriginal;
            console.warn = warnOriginal;
        }
    };
}

/** Un elemento de MenuItemAvailabilityChanged como texto, con ids crudos de 17 digitos. */
export function delta(tipo: 'Product' | 'Choice', id: string, disponible: boolean, location = VENDOR): string {
    return `{"locationId":${location},"itemEntityType":"${tipo}","itemEntityId":${id},` +
        `"itemEntityChainId":${id.replace(/^9/, '8')},"itemExternalReference":"ext-${id}","isAvailable":${disponible}}`;
}

export function arrayDeltas(...elementos: string[]): string {
    return `[${elementos.join(',')}]`;
}

/** XML SYNTHETIC con N productos en la categoria Burgers, para mass 86 y freno de borrado. */
export function xmlConProductos(ids: string[], categoria = 'Burgers'): string {
    const productos = ids.map(id =>
        `<product id="${id}" chainproductid="8${id.substring(1)}" name="Item ${id.slice(-4)}" cost="5"><pricing><price amount="5"/></pricing></product>`
    ).join('');
    return `<?xml version="1.0"?><menuexport><brands><brand id="1"><vendors><vendor id="${VENDOR}" name="Synthetic Store"><menu><categories>` +
        `<category id="1" name="${categoria}"><products>${productos}</products></category>` +
        `</categories></menu></vendor></vendors></brand></brands></menuexport>`;
}

export function idsSecuenciales(n: number, base = 91000000000000000n): string[] {
    return Array.from({ length: n }, (_, i) => String(base + BigInt(i + 1)));
}
