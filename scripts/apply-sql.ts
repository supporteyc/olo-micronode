/**
 * Aplica un archivo .sql usando la conexión de DATABASE_URL.
 *
 * Esta base la administra Flyway desde el servidor Java, así que no se puede
 * usar `prisma migrate`: Prisma intentaría tomar posesión de todo el esquema y
 * pelearía con Flyway. Los cambios de este lado van en archivos SQL sueltos
 * dentro de sql/, y se aplican con esto.
 *
 *   bun run scripts/apply-sql.ts sql/001_create_menu_item_changes.sql
 *
 * Lee la conexión del .env, así que no hay que pasar credenciales por línea de
 * comandos (donde quedarían en el historial del shell).
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';

const prisma = new PrismaClient();

/** Quita los comentarios `--` y parte en sentencias. */
function sentencias(sql: string): string[] {
    return sql
        .split('\n')
        .filter(linea => !linea.trim().startsWith('--'))
        .join('\n')
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0);
}

async function main() {
    const ruta = process.argv[2];
    if (!ruta) {
        console.error("Uso: bun run scripts/apply-sql.ts <archivo.sql>");
        process.exit(1);
    }

    const contenido = readFileSync(ruta, 'utf-8');
    const bloques = sentencias(contenido);

    console.log(`Aplicando ${ruta} (${bloques.length} sentencia${bloques.length === 1 ? '' : 's'})`);

    for (const [i, sentencia] of bloques.entries()) {
        const resumen = sentencia.split('\n')[0].substring(0, 70);
        try {
            await prisma.$executeRawUnsafe(sentencia);
            console.log(`  [${i + 1}/${bloques.length}] OK  ${resumen}`);
        } catch (e: any) {
            console.error(`  [${i + 1}/${bloques.length}] FALLO  ${resumen}`);
            console.error(`         ${e.message}`);
            process.exit(1);
        }
    }

    console.log("Listo.");
}

main()
    .catch(e => {
        console.error("Error:", e.message);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
