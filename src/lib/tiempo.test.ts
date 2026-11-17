import { describe, expect, test } from 'bun:test';
import { businessDateEnZona, horaMinutoEnZona, parsearHoraOlo, paredAUtc } from './tiempo';

describe('horas de la tienda', () => {

    test('"yyyymmdd hh:mm" local a UTC', () => {
        expect(parsearHoraOlo('20261117 10:00', 'America/New_York')!.toISOString()).toBe('2026-11-17T15:00:00.000Z');
        expect(parsearHoraOlo('20260717 10:00', 'America/New_York')!.toISOString()).toBe('2026-07-17T14:00:00.000Z');
        expect(parsearHoraOlo('20261117 10:00', 'America/Los_Angeles')!.toISOString()).toBe('2026-11-17T18:00:00.000Z');
    });

    test('cambio de horario: la hora despues del salto usa el offset nuevo', () => {
        // 2026-03-08: Nueva York pasa de EST (-5) a EDT (-4) a las 2:00.
        expect(paredAUtc(2026, 3, 8, 1, 30, 'America/New_York').toISOString()).toBe('2026-03-08T06:30:00.000Z');
        expect(paredAUtc(2026, 3, 8, 3, 30, 'America/New_York').toISOString()).toBe('2026-03-08T07:30:00.000Z');
    });

    test('basura o formato distinto devuelve null', () => {
        expect(parsearHoraOlo('2026-11-17T10:00', 'America/New_York')).toBeNull();
        expect(parsearHoraOlo('20261317 10:00', 'America/New_York')).toBeNull();
        expect(parsearHoraOlo(null, 'America/New_York')).toBeNull();
    });

    test('businessDate es el dia de la tienda, no el del servidor', () => {
        // 01:30 UTC del 18 sigue siendo el 17 en Miami.
        expect(businessDateEnZona(new Date('2026-11-18T01:30:00Z'), 'America/New_York')).toBe(20261117);
        expect(horaMinutoEnZona(new Date('2026-11-18T01:30:00Z'), 'America/New_York')).toBe('20:30');
    });
});
