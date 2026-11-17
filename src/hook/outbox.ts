import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Deduplicacion y outbox durable del receptor.
 *
 * El ack a Olo tiene que ser rapido (idealmente menos de 1 s) y llegar antes
 * del procesamiento; pero si el receptor responde 200 y despues se cae, el
 * evento se pierde: Olo no lo reintenta. La salida es escribir el evento en
 * disco ANTES del 200 y entregarlo despues, desde un worker.
 *
 * bun:sqlite por defecto (sin servidor, un archivo). Detras de una interfaz por
 * si hace falta moverlo a MySQL o a una cola. OJO en contenedores: el archivo
 * tiene que vivir en un volumen persistente (ver docs/RUNBOOK.md).
 */

export interface EntregaNueva {
    storeId: string;
    routingKey: string;
    eventType: string;
    body: string;
}

export interface Pendiente {
    id: number;
    messageId: string;
    storeId: string;
    routingKey: string;
    eventType: string;
    body: string;
    olotimestamp: string;
    attempts: number;
    createdAt: number;
}

export interface MetricasOutbox {
    pendientes: number;
    pendientesPorTienda: Record<string, number>;
    edadMasViejoMs: number | null;
    entregados: number;
    descartados: number;
}

export interface Outbox {
    /** Registra el mensaje y sus entregas en una transaccion. false si ya existia. */
    registrar(messageId: string, eventType: string, olotimestamp: string, entregas: EntregaNueva[], ahora: number): boolean;
    /** El mas viejo sin entregar de cada tienda, si ya le toca (FIFO por tienda). */
    siguientes(ahora: number): Pendiente[];
    marcarEntregado(id: number, ahora: number): void;
    marcarFallo(id: number, error: string, proximoIntento: number): void;
    /** Para errores que reintentar no arregla (400 del node). */
    descartar(id: number, error: string, ahora: number): void;
    metricas(ahora: number): MetricasOutbox;
    purgar(antesDe: number): number;
    cerrar(): void;
}

export class OutboxSqlite implements Outbox {
    private db: Database;

    constructor(ruta: string) {
        if (ruta !== ':memory:') mkdirSync(dirname(ruta), { recursive: true });
        this.db = new Database(ruta, { create: true });
        this.db.exec('PRAGMA journal_mode = WAL;');
        this.db.exec('PRAGMA synchronous = FULL;');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS mensajes (
                message_id   TEXT PRIMARY KEY,
                event_type   TEXT NOT NULL,
                received_at  INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS outbox (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id       TEXT NOT NULL,
                store_id         TEXT NOT NULL,
                routing_key      TEXT NOT NULL,
                event_type       TEXT NOT NULL,
                body             TEXT NOT NULL,
                olo_timestamp    TEXT NOT NULL,
                attempts         INTEGER NOT NULL DEFAULT 0,
                next_attempt_at  INTEGER NOT NULL,
                created_at       INTEGER NOT NULL,
                delivered_at     INTEGER NULL,
                discarded_at     INTEGER NULL,
                last_error       TEXT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_outbox_pendiente ON outbox (store_id, delivered_at, discarded_at, id);
        `);
    }

    registrar(messageId: string, eventType: string, olotimestamp: string, entregas: EntregaNueva[], ahora: number): boolean {
        const tx = this.db.transaction(() => {
            const r = this.db.query('INSERT OR IGNORE INTO mensajes (message_id, event_type, received_at) VALUES (?, ?, ?)')
                .run(messageId, eventType, ahora);
            if (r.changes === 0) return false;
            const ins = this.db.query(`INSERT INTO outbox
                (message_id, store_id, routing_key, event_type, body, olo_timestamp, next_attempt_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
            for (const e of entregas) ins.run(messageId, e.storeId, e.routingKey, e.eventType, e.body, olotimestamp, ahora, ahora);
            return true;
        });
        return tx();
    }

    siguientes(ahora: number): Pendiente[] {
        // La cabeza de cada tienda. Si a la cabeza no le toca todavia, la tienda
        // espera entera: entregar el siguiente primero desordenaria los eventos
        // (un 68 podria quedar pisado por el 86 que lo precede).
        const filas = this.db.query(`
            SELECT o.* FROM outbox o
            JOIN (SELECT store_id, MIN(id) AS id FROM outbox
                  WHERE delivered_at IS NULL AND discarded_at IS NULL GROUP BY store_id) c
              ON c.id = o.id
            WHERE o.next_attempt_at <= ?`).all(ahora) as any[];
        return filas.map(f => ({
            id: f.id,
            messageId: f.message_id,
            storeId: f.store_id,
            routingKey: f.routing_key,
            eventType: f.event_type,
            body: f.body,
            olotimestamp: f.olo_timestamp,
            attempts: f.attempts,
            createdAt: f.created_at
        }));
    }

    marcarEntregado(id: number, ahora: number): void {
        this.db.query('UPDATE outbox SET delivered_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?').run(ahora, id);
    }

    marcarFallo(id: number, error: string, proximoIntento: number): void {
        this.db.query('UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE id = ?')
            .run(proximoIntento, error.substring(0, 500), id);
    }

    descartar(id: number, error: string, ahora: number): void {
        this.db.query('UPDATE outbox SET discarded_at = ?, attempts = attempts + 1, last_error = ? WHERE id = ?')
            .run(ahora, error.substring(0, 500), id);
    }

    metricas(ahora: number): MetricasOutbox {
        const porTienda = this.db.query(`SELECT store_id, COUNT(*) AS n, MIN(created_at) AS viejo FROM outbox
            WHERE delivered_at IS NULL AND discarded_at IS NULL GROUP BY store_id`).all() as any[];
        const totales = this.db.query(`SELECT
            SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS entregados,
            SUM(CASE WHEN discarded_at IS NOT NULL THEN 1 ELSE 0 END) AS descartados
            FROM outbox`).get() as any;
        const viejo = porTienda.length ? Math.min(...porTienda.map(p => p.viejo)) : null;
        return {
            pendientes: porTienda.reduce((a, p) => a + p.n, 0),
            pendientesPorTienda: Object.fromEntries(porTienda.map(p => [p.store_id, p.n])),
            edadMasViejoMs: viejo === null ? null : ahora - viejo,
            entregados: totales?.entregados ?? 0,
            descartados: totales?.descartados ?? 0
        };
    }

    purgar(antesDe: number): number {
        const a = this.db.query('DELETE FROM outbox WHERE (delivered_at IS NOT NULL OR discarded_at IS NOT NULL) AND created_at < ?').run(antesDe);
        // El dedup se conserva mas que la ventana de reintentos de Olo (24 h).
        const b = this.db.query('DELETE FROM mensajes WHERE received_at < ? AND message_id NOT IN (SELECT message_id FROM outbox)').run(antesDe);
        return a.changes + b.changes;
    }

    cerrar(): void {
        this.db.close();
    }
}
