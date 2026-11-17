import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { zipSync, strToU8 } from 'fflate';
import {
    cabecerasFirmadas, extraerXmlDelZip, fechaRfc1123, firmar, mensajeAFirmar,
    OloApiService, OloHttpError, parsearOchentaYSeis, pathParaFirmar
} from './oloApi.service';
import { leerConfigOlo } from '../config/olo';
import { crearMockOlo, type MockOlo } from '../../tools/mock-olo/mockOlo';

const cfgBase = leerConfigOlo({ OLO_ENV: 'mock', OLO_BASE_URL: 'https://ordering.api.olosandbox.com/v1.1/' });

describe('Signature Authorization de la Ordering API', () => {

    test('sin body: ContentType vacio y hash de la cadena vacia', () => {
        const m = mensajeAFirmar({
            clientId: 'abc', verbo: 'get', contentType: 'application/json', body: '',
            pathAndQuery: '/v1.1/vendorexport/status', fecha: 'Mon, 16 Nov 2026 17:05:44 GMT'
        });
        const hashVacio = createHash('sha256').update('').digest('base64');
        expect(m).toBe(['abc', 'GET', '', hashVacio, '/v1.1/vendorexport/status', 'Mon, 16 Nov 2026 17:05:44 GMT'].join('\n'));
        expect(m).not.toContain('\r');
        expect(hashVacio).toBe('47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
    });

    test('con body: ContentType y hash del body', () => {
        const body = '{"a":1}';
        const m = mensajeAFirmar({ clientId: 'abc', verbo: 'POST', contentType: 'application/json', body, pathAndQuery: '/x', fecha: 'f' });
        expect(m.split('\n')[2]).toBe('application/json');
        expect(m.split('\n')[3]).toBe(createHash('sha256').update(body).digest('base64'));
    });

    test('el path incluye /v1.1/ y la query, con espacios como %20', () => {
        const url = new URL('vendorexport/status?changedsince=20261116&x=a b', cfgBase.baseUrl);
        expect(pathParaFirmar(url, cfgBase.baseUrl, true)).toBe('/v1.1/vendorexport/status?changedsince=20261116&x=a%20b');
        expect(pathParaFirmar(url, cfgBase.baseUrl, false)).toBe('/vendorexport/status?changedsince=20261116&x=a%20b');
    });

    test('Date en RFC1123 GMT', () => {
        expect(fechaRfc1123(new Date('2026-11-16T17:05:44Z'))).toBe('Mon, 16 Nov 2026 17:05:44 GMT');
    });

    test('Authorization = OloSignature ClientId:firma', () => {
        const ahora = new Date('2026-11-16T17:05:44Z');
        const url = new URL('vendorexport/status', cfgBase.baseUrl);
        const h = cabecerasFirmadas(cfgBase, 'GET', url, '', 'application/json', ahora);
        const esperada = firmar(cfgBase.clientSecret, mensajeAFirmar({
            clientId: cfgBase.clientId, verbo: 'GET', contentType: '', body: '',
            pathAndQuery: '/v1.1/vendorexport/status', fecha: 'Mon, 16 Nov 2026 17:05:44 GMT'
        }));
        expect(h.Authorization).toBe(`OloSignature ${cfgBase.clientId}:${esperada}`);
        expect(h.Date).toBe('Mon, 16 Nov 2026 17:05:44 GMT');
        expect(h['Content-Type']).toBeUndefined();
    });
});

describe('eightysixeditems', () => {

    test('products por id y choices por id + __mod, con ids intactos', () => {
        const r = parsearOchentaYSeis(
            '{"products":[{"id":90000000000000012,"chainproductid":80000000000000012}],' +
            '"choices":[{"id":90000000000000021,"chainoptionid":70000000000000021}]}');
        expect([...r.posIds]).toEqual(['90000000000000012', '90000000000000021__mod']);
        expect(r.entradas).toBe(2);
        expect(r.porChainId.get('P:80000000000000012')).toBe('90000000000000012');
    });

    test('una forma inesperada lanza en vez de leerse como "nada agotado"', () => {
        expect(() => parsearOchentaYSeis('{}')).toThrow();
        expect(() => parsearOchentaYSeis('{"products":[]}')).toThrow();
        expect(() => parsearOchentaYSeis('no json')).toThrow();
        expect(() => parsearOchentaYSeis('{"products":[{"x":1}],"choices":[]}')).toThrow();
    });

    test('listas vacias son validas: nada agotado', () => {
        expect(parsearOchentaYSeis('{"products":[],"choices":[]}').posIds.size).toBe(0);
    });
});

describe('cliente contra el mock (firma de punta a punta)', () => {
    let mock: MockOlo;
    afterEach(() => mock?.detener());

    test('vendorexport/status pasa la verificacion de firma del mock', async () => {
        mock = crearMockOlo();
        const api = new OloApiService(leerConfigOlo({ OLO_ENV: 'mock', OLO_BASE_URL: mock.baseUrl }));
        expect((await api.testAuthentication()).ok).toBe(true);
    });

    test('con el secreto equivocado el mock responde 401', async () => {
        mock = crearMockOlo();
        const api = new OloApiService(leerConfigOlo({ OLO_ENV: 'mock', OLO_BASE_URL: mock.baseUrl, OLO_CLIENT_SECRET: 'otro' }));
        const r = await api.testAuthentication();
        expect(r.ok).toBe(false);
        expect(r.message).toContain('401');
    });

    test('sigue el 301 del Vendor Export sin reenviar Authorization y descomprime el zip', async () => {
        mock = crearMockOlo();
        const api = new OloApiService(leerConfigOlo({ OLO_ENV: 'mock', OLO_BASE_URL: mock.baseUrl }));
        const xml = await api.descargarVendorExport();
        expect(xml).toContain('SYNTHETIC');
        // El mock rechaza el zip si llega con Authorization: si paso, no lo llevaba.
        expect(mock.estado.llamadas.find(l => l.path === '/__files/export.zip')?.status).toBe(200);
    });

    test('reintenta ante 429 y despues se rinde con OloHttpError', async () => {
        mock = crearMockOlo();
        mock.estado.modo86 = '429';
        const esperas: number[] = [];
        const api = new OloApiService(
            leerConfigOlo({ OLO_ENV: 'mock', OLO_BASE_URL: mock.baseUrl, OLO_MAX_RETRIES: '2' }),
            fetch,
            async ms => { esperas.push(ms); }
        );
        const error = await api.fetchOchentaYSeis().catch(e => e);
        expect(error).toBeInstanceOf(OloHttpError);
        expect((error as OloHttpError).status).toBe(429);
        expect((error as OloHttpError).num).toBe(429);
        expect(esperas).toHaveLength(2);
        expect(mock.estado.llamadas.filter(l => l.path.includes('eightysixeditems'))).toHaveLength(3);
    });

    test('un 403 no se reintenta', async () => {
        mock = crearMockOlo();
        mock.estado.modo86 = '403';
        const api = new OloApiService(leerConfigOlo({ OLO_ENV: 'mock', OLO_BASE_URL: mock.baseUrl, OLO_MAX_RETRIES: '3' }), fetch, async () => {});
        await expect(api.fetchOchentaYSeis()).rejects.toThrow('403');
        expect(mock.estado.llamadas.filter(l => l.path.includes('eightysixeditems'))).toHaveLength(1);
    });
});

describe('zip del Vendor Export', () => {
    test('toma el primer .xml', () => {
        const zip = zipSync({ 'leeme.txt': strToU8('x'), 'b.xml': strToU8('<b/>'), 'a.xml': strToU8('<a/>') });
        expect(extraerXmlDelZip(zip)).toBe('<a/>');
    });
    test('un zip sin xml o roto lanza', () => {
        expect(() => extraerXmlDelZip(zipSync({ 'a.txt': strToU8('x') }))).toThrow('ningun .xml');
        expect(() => extraerXmlDelZip(new Uint8Array([1, 2, 3]))).toThrow('zip');
    });
});
