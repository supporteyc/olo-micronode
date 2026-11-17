import type { Almacen } from './tipos';
import { AlmacenMemoria } from './memoria';
import { AlmacenPrisma, prismaCompartido } from './prisma';

export type { Almacen } from './tipos';

/**
 * Elige el almacen del proceso.
 *
 *   ALMACEN=mysql    -> MySQL (DATABASE_URL obligatoria)
 *   ALMACEN=memoria  -> en memoria, solo para mock y desarrollo
 *   sin ALMACEN      -> mysql si hay DATABASE_URL, memoria si no
 *
 * Con OLO_ENV=production nunca se acepta memoria: un reinicio borraria el
 * historial y el menu de la tienda sin que nada lo frene.
 */
export function crearAlmacen(env: Record<string, string | undefined> = process.env): {
    almacen: Almacen;
    tipo: 'mysql' | 'memoria';
} {
    const pedido = (env.ALMACEN || '').trim().toLowerCase();
    const hayDb = Boolean((env.DATABASE_URL || '').trim());
    const tipo = pedido === 'memoria' || pedido === 'mysql'
        ? pedido
        : (hayDb ? 'mysql' : 'memoria');

    if (tipo === 'memoria' && env.OLO_ENV === 'production') {
        throw new Error('ALMACEN=memoria no se permite con OLO_ENV=production: define DATABASE_URL.');
    }
    if (tipo === 'mysql' && !hayDb) {
        throw new Error('ALMACEN=mysql requiere DATABASE_URL.');
    }

    if (tipo === 'mysql') {
        const prisma = prismaCompartido();
        return { almacen: new AlmacenPrisma(prisma), tipo };
    }
    return { almacen: new AlmacenMemoria(), tipo };
}
