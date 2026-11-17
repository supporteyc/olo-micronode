/**
 * Estado en memoria del stock que comparten menuSync y availability.
 *
 * Nada de esto va a la base: son las metricas que /api/status expone y la
 * memoria corta que necesita la deteccion de flapping. Si el proceso reinicia,
 * el arranque corre una importacion con linea base y todo vuelve a estar al dia.
 */
export class StockEstado {
    lastWebhookAt: Date | null = null;
    lastDeltaAt: Date | null = null;
    lastReconcileAt: Date | null = null;
    lastReconcileAttemptAt: Date | null = null;
    lastReconcileOk: boolean | null = null;
    /** Filas que corrigio la ultima reconciliacion (null = no hubo ninguna aun). */
    lastReconcileCorrected: number | null = null;
    consecutiveCorrections = 0;
    lastImportAt: Date | null = null;
    /** Fecha local (aaaammdd) del ultimo respaldo diario del export. */
    lastDailyExportDate: number | null = null;
    /** inventory_guids de la ultima linea base exitosa; null si la ultima fallo o no hubo. */
    inventoryGuids: number | null = null;

    deltas = { aplicados: 0, sinCambio: 0, ignorados: 0, desconocidos: 0, duplicados: 0 };

    /** pos_id -> ultima vez que llego un delta para el. */
    private ultimoDelta = new Map<string, number>();

    /**
     * Registra los deltas recibidos y devuelve los pos_id que recibieron otro
     * delta dentro de la ventana: senal de eventos fuera de orden o de un item
     * que sube y baja. Se cuenta la RECEPCION, no el cambio: un 68 que llega
     * primero no cambia nada y el 86 viejo que llega despues si, asi que contar
     * solo cambios dejaria pasar justo el caso que importa.
     */
    public registrarDeltas(posIds: string[], ahora: number, ventanaMs: number): string[] {
        const sospechosos: string[] = [];
        for (const id of posIds) {
            const previo = this.ultimoDelta.get(id);
            if (previo !== undefined && ahora - previo < ventanaMs) sospechosos.push(id);
            this.ultimoDelta.set(id, ahora);
        }
        // La memoria no crece sin limite: se olvida lo que ya salio de la ventana.
        if (this.ultimoDelta.size > 5000) {
            for (const [id, t] of this.ultimoDelta) if (ahora - t >= ventanaMs) this.ultimoDelta.delete(id);
        }
        return sospechosos;
    }
}
