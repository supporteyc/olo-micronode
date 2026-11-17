/**
 * Horas de la tienda.
 *
 * Olo manda timePlaced, timeWanted y timeReady en hora LOCAL de la tienda, con
 * formato "yyyymmdd hh:mm", y aparte storeTimeZone (IANA). El servidor corre en
 * UTC (o en la zona de quien lo despliegue), asi que ninguna cuenta puede usar
 * la hora local del proceso: ec4toast-node calculaba el businessDate con
 * new Date().getDate(), que en un contenedor UTC cambia de dia a las 7 u 8 de la
 * noche de Miami.
 *
 * Sin dependencias: Intl alcanza para sacar el offset de una zona en un instante.
 */

interface PartesFecha {
    anio: number;
    mes: number;
    dia: number;
    hora: number;
    minuto: number;
    segundo: number;
}

const formateadores = new Map<string, Intl.DateTimeFormat>();

function formateador(tz: string): Intl.DateTimeFormat {
    let f = formateadores.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            hourCycle: 'h23',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
        formateadores.set(tz, f);
    }
    return f;
}

/** Fecha y hora de pared en la zona tz para un instante. */
export function partesEnZona(instante: Date, tz: string): PartesFecha {
    const p: Record<string, number> = {};
    for (const parte of formateador(tz).formatToParts(instante)) {
        if (parte.type !== 'literal') p[parte.type] = Number(parte.value);
    }
    return { anio: p.year, mes: p.month, dia: p.day, hora: p.hour, minuto: p.minute, segundo: p.second };
}

/** Minutos que la zona esta adelantada respecto de UTC en ese instante. */
function offsetMinutos(instante: Date, tz: string): number {
    const p = partesEnZona(instante, tz);
    const comoUtc = Date.UTC(p.anio, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
    return Math.round((comoUtc - Math.floor(instante.getTime() / 1000) * 1000) / 60000);
}

/**
 * Hora de pared en tz a instante UTC. Dos pasadas para resolver bien los cambios
 * de horario: la primera estima con el offset de "ahora", la segunda corrige con
 * el offset del instante estimado.
 */
export function paredAUtc(anio: number, mes: number, dia: number, hora: number, minuto: number, tz: string): Date {
    const ingenuo = Date.UTC(anio, mes - 1, dia, hora, minuto);
    let estimado = ingenuo - offsetMinutos(new Date(ingenuo), tz) * 60000;
    estimado = ingenuo - offsetMinutos(new Date(estimado), tz) * 60000;
    return new Date(estimado);
}

const FORMATO_OLO = /^(\d{4})(\d{2})(\d{2})\s+(\d{1,2}):(\d{2})$/;

/**
 * "20261116 17:05" en hora local de la tienda a instante UTC.
 * Devuelve null si el texto no tiene el formato, para no inventar una hora.
 */
export function parsearHoraOlo(valor: unknown, tz: string): Date | null {
    if (typeof valor !== 'string') return null;
    const m = FORMATO_OLO.exec(valor.trim());
    if (!m) return null;
    const [, a, me, d, h, mi] = m.map(Number);
    if (me < 1 || me > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
    return paredAUtc(a, me, d, h, mi, tz);
}

/** businessDate aaaammdd del dia de la tienda en ese instante. */
export function businessDateEnZona(instante: Date, tz: string): number {
    const p = partesEnZona(instante, tz);
    return p.anio * 10000 + p.mes * 100 + p.dia;
}

/** businessDate a partir del texto local de Olo, sin pasar por UTC. */
export function businessDateDeHoraOlo(valor: unknown): number | null {
    if (typeof valor !== 'string') return null;
    const m = FORMATO_OLO.exec(valor.trim());
    return m ? Number(`${m[1]}${m[2]}${m[3]}`) : null;
}

/** "HH:mm" de la tienda para ese instante. */
export function horaMinutoEnZona(instante: Date, tz: string): string {
    const p = partesEnZona(instante, tz);
    return `${String(p.hora).padStart(2, '0')}:${String(p.minuto).padStart(2, '0')}`;
}

export function sumarMinutos(fecha: Date, minutos: number): Date {
    return new Date(fecha.getTime() + minutos * 60000);
}
