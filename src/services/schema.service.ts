import { prismaCompartido } from '../almacen/prisma';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const prisma = prismaCompartido();

const CARPETA = 'sql';

/**
 * Solo se aplican solas las sentencias que no pueden romper nada.
 *
 * Es la regla que hace aceptable correr DDL en cada arranque: si alguien agrega
 * un DROP o un ALTER destructivo a sql/, no se ejecuta solo - se avisa y se
 * espera a que lo corra una persona con scripts/apply-sql.ts.
 */
const PERMITIDAS = /^CREATE\s+(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\b/i;

/** Quita los comentarios `--` y parte en sentencias. Igual que apply-sql.ts. */
function sentencias(sql: string): string[] {
    return sql
        .split('\n')
        .filter(linea => !linea.trim().startsWith('--'))
        .join('\n')
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0);
}

/**
 * Crea las tablas propias de este servicio si no existen.
 *
 * Esta base la administra Flyway desde el servidor Java, asi que no se puede
 * usar `prisma migrate`: Prisma querria tomar posesion de todo el esquema y
 * pelearia con Flyway. Pero las tablas de sql/ son nuestras y Flyway no las
 * conoce, asi que crearlas al arrancar no le pisa nada a nadie.
 *
 * Se hace solo porque cada location tiene su propia base: con un paso manual,
 * dar de alta un cliente nuevo significa acordarse de correr un script contra
 * una base distinta, y olvidarse no rompe nada visible - el sync sigue andando
 * y el historial simplemente no se guarda. Ese es el peor tipo de error.
 *
 * Nunca tumba el arranque: si la base no deja crear, se avisa y el servicio
 * sigue. El historial es un registro, no el camino critico.
 */
export async function asegurarEsquema(): Promise<void> {
    if (!existsSync(CARPETA)) return;

    const archivos = readdirSync(CARPETA).filter(f => f.endsWith('.sql')).sort();
    if (archivos.length === 0) return;

    let aplicadas = 0;
    let omitidas = 0;

    for (const archivo of archivos) {
        for (const sentencia of sentencias(readFileSync(join(CARPETA, archivo), 'utf-8'))) {
            if (!PERMITIDAS.test(sentencia)) {
                omitidas++;
                console.warn(
                    `Esquema: se omite una sentencia de ${archivo} que no es CREATE ... IF NOT EXISTS. ` +
                    `Aplicala a mano: bun run scripts/apply-sql.ts ${CARPETA}/${archivo}`
                );
                continue;
            }

            try {
                await prisma.$executeRawUnsafe(sentencia);
                aplicadas++;
            } catch (e: any) {
                // console.warn y no console.error: un fallo aca no es una caida
                // del servicio, y console.error dispara el webhook de alertas.
                console.warn(`Esquema: fallo una sentencia de ${archivo}: ${e.message}`);
            }
        }
    }

    console.log(
        `Esquema verificado: ${aplicadas} tabla(s) al dia` +
        (omitidas > 0 ? `, ${omitidas} sentencia(s) omitida(s)` : '')
    );
}
