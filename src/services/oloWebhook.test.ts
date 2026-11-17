import { describe, expect, test } from 'bun:test';
import { clavesDeRuteo, filtrarPorTienda, firmarWebhook, verificarFirmaWebhook } from './oloWebhook.service';
import { citarIdsGrandes, idComoTexto, parsearJsonSeguro } from '../lib/ids';

describe('firma X-Olo-Signature', () => {

    // Vector del sample oficial publico de Olo (Node).
    const url = 'https://www.olo.com/webhook/';
    const body = '{"message":"Olo webhook test!"}';
    const messageId = 'f8dac5dd-d3b2-w76c-b969-a668c699637c';
    const timestamp = '635616089149791951';
    const secreto = 'ThisIsADemonstrationSecret';
    const esperada = 'wdXzIQ3FsGtRWtcIgJ5+7eCsPW19s2lILsuOicy54nI=';

    test('reproduce el vector oficial', () => {
        expect(firmarWebhook(secreto, url, body, messageId, timestamp)).toBe(esperada);
    });

    test('verifica la firma correcta', () => {
        expect(verificarFirmaWebhook(secreto, url, body, messageId, timestamp, esperada)).toBe(true);
    });

    test('rechaza body, url, id, timestamp o secreto distintos', () => {
        expect(verificarFirmaWebhook(secreto, url, body + ' ', messageId, timestamp, esperada)).toBe(false);
        expect(verificarFirmaWebhook(secreto, 'https://www.olo.com/webhook', body, messageId, timestamp, esperada)).toBe(false);
        expect(verificarFirmaWebhook(secreto, url, body, messageId + 'x', timestamp, esperada)).toBe(false);
        expect(verificarFirmaWebhook(secreto, url, body, messageId, '1', esperada)).toBe(false);
        expect(verificarFirmaWebhook('otro', url, body, messageId, timestamp, esperada)).toBe(false);
    });

    test('CRLF no es LF: un body reformateado no verifica', () => {
        const conCrlf = '{\r\n"message":"Olo webhook test!"}';
        const conLf = '{\n"message":"Olo webhook test!"}';
        const firma = firmarWebhook(secreto, url, conLf, messageId, timestamp);
        expect(verificarFirmaWebhook(secreto, url, conCrlf, messageId, timestamp, firma)).toBe(false);
    });

    test('firmas vacias o de otro largo son invalidas sin lanzar', () => {
        expect(verificarFirmaWebhook(secreto, url, body, messageId, timestamp, '')).toBe(false);
        expect(verificarFirmaWebhook(secreto, url, body, messageId, timestamp, 'corta')).toBe(false);
        expect(verificarFirmaWebhook('', url, body, messageId, timestamp, esperada)).toBe(false);
    });
});

describe('ids int64', () => {

    test('cita los enteros de 16+ digitos y deja el resto', () => {
        const json = '{"locationId":10000000000000001,"qty":2,"total":12.5,"ids":[90000000000000011,5],"name":"a,1234567890123456"}';
        const r = parsearJsonSeguro(json);
        expect(r.locationId).toBe('10000000000000001');
        expect(r.qty).toBe(2);
        expect(r.total).toBe(12.5);
        expect(r.ids).toEqual(['90000000000000011', 5]);
        expect(r.name).toBe('a,1234567890123456');
    });

    test('no toca numeros con decimales ni negativos chicos', () => {
        expect(citarIdsGrandes('{"a":1234567890123456.5,"b":-3}')).toBe('{"a":1234567890123456.5,"b":-3}');
    });

    test('idComoTexto rechaza un number que ya perdio precision', () => {
        expect(idComoTexto('90000000000000011')).toBe('90000000000000011');
        expect(idComoTexto(42)).toBe('42');
        expect(() => idComoTexto(90000000000000011)).toThrow();
    });
});

describe('ruteo', () => {

    test('ordenes: vendorIdString antes que vendorId', () => {
        expect(clavesDeRuteo('OrderPlaced', { vendorIdString: '10000000000000001', vendorId: '1' })).toEqual(['10000000000000001']);
        expect(clavesDeRuteo('OrderPlaced', { vendorId: '10000000000000001' })).toEqual(['10000000000000001']);
    });

    test('VendorMenuExportComplete usa vendorId; los de vendor usan locationId', () => {
        expect(clavesDeRuteo('VendorMenuExportComplete', { vendorId: '7' })).toEqual(['7']);
        expect(clavesDeRuteo('VendorAvailabilityChanged', { locationId: '8' })).toEqual(['8']);
    });

    test('MenuItemAvailabilityChanged puede mezclar tiendas y se parte', () => {
        const cuerpo = parsearJsonSeguro(
            '[{"locationId":10000000000000001,"itemEntityId":1},{"locationId":10000000000000002,"itemEntityId":2},{"locationId":10000000000000001,"itemEntityId":3}]');
        expect(clavesDeRuteo('MenuItemAvailabilityChanged', cuerpo)).toEqual(['10000000000000001', '10000000000000002']);
        expect(filtrarPorTienda(cuerpo, '10000000000000001').map(e => e.itemEntityId)).toEqual([1, 3]);
    });
});
