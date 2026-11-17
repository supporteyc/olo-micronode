/**
 * Candado FIFO para serializar las escrituras de stock.
 *
 * En ec4toast-node alcanzaba con un booleano SYNC_LOCK: habia un solo escritor
 * (el ciclo) y un ciclo que encontraba el candado tomado simplemente se
 * descartaba. Con Olo hay tres escritores de in_stock (importacion, linea base y
 * deltas por webhook) y un delta NO se puede descartar: se perderia un 86.
 * Este candado los pone en fila, en orden de llegada.
 */
export class Mutex {
    private cola: Promise<void> = Promise.resolve();
    private ocupado = false;

    public estaOcupado(): boolean {
        return this.ocupado;
    }

    public async ejecutar<T>(fn: () => Promise<T>): Promise<T> {
        let liberar!: () => void;
        const turno = new Promise<void>(r => { liberar = r; });
        const anterior = this.cola;
        this.cola = anterior.then(() => turno);

        await anterior;
        this.ocupado = true;
        try {
            return await fn();
        } finally {
            this.ocupado = false;
            liberar();
        }
    }
}
