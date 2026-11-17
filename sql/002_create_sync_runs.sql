-- Historial de ciclos de sync del lado Toast.
--
-- menu_item_changes ya guarda QUE cambio en el menu. Esta tabla guarda que paso
-- con el CICLO: si corrio, cuanto tardo, si Toast respondio, si el inventario
-- llego. Los logs viven en memoria (logMemory, 500 lineas) y se pierden en cada
-- reinicio; esto es lo que sobrevive y lo que consume el console centralizado.
--
--   bun run scripts/apply-sql.ts sql/002_create_sync_runs.sql

CREATE TABLE IF NOT EXISTS sync_runs (
    id              BIGINT       NOT NULL AUTO_INCREMENT,

    started_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    finished_at     TIMESTAMP(3) NULL,
    duration_ms     INT          NULL,

    -- ok | error | skipped
    status          VARCHAR(20)  NOT NULL DEFAULT 'ok',
    -- scheduler | manual
    trigger_source  VARCHAR(20)  NOT NULL DEFAULT 'scheduler',
    -- HAY_CAMBIOS | SIN_CAMBIOS
    reason          VARCHAR(60)  NULL,

    -- PASO 1/2: filas que pasaron el filtro de MENU_CONFIG
    source_items    INT          NOT NULL DEFAULT 0,
    -- guids que devolvio /stock/v1/inventory. NULL = no se pudo consultar y el
    -- stock de la DB se dejo intacto, que no es lo mismo que "cero agotados".
    inventory_guids INT          NULL,
    sold_out_items  INT          NOT NULL DEFAULT 0,

    -- PASO 2/2: lo que se escribio en menu_items
    db_created      INT          NOT NULL DEFAULT 0,
    db_updated      INT          NOT NULL DEFAULT 0,
    db_deleted      INT          NOT NULL DEFAULT 0,
    db_unchanged    INT          NOT NULL DEFAULT 0,
    changes_logged  INT          NOT NULL DEFAULT 0,

    error_message   TEXT         NULL,

    PRIMARY KEY (id),
    KEY idx_sync_runs_started (started_at),
    KEY idx_sync_runs_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
