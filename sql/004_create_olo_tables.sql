-- Tablas propias de la integracion con Olo.
--
-- Mismas reglas que 001 a 003: solo CREATE TABLE IF NOT EXISTS, sin ALTER ni
-- DROP, para que asegurarEsquema() las cree solas al arrancar sin pisarle nada
-- a Flyway. Los indices van dentro del CREATE TABLE por la misma razon.

-- Idempotencia de webhooks. message_id es el X-Olo-Message-Id: Olo entrega
-- al-menos-una-vez y reintenta hasta 50 veces en 24 h, asi que el mismo mensaje
-- puede llegar varias veces. El INSERT va en la misma transaccion que el efecto:
-- clave duplicada = ya procesado.
CREATE TABLE IF NOT EXISTS `olo_webhook_events` (
    `message_id` VARCHAR(64) NOT NULL,
    `event_type` VARCHAR(64) NOT NULL,
    -- Order.id o vendorId, para poder buscar los eventos de una orden.
    `entity_key` VARCHAR(64) NULL,
    `received_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `applied` BOOLEAN NOT NULL DEFAULT true,
    `note` VARCHAR(255) NULL,

    PRIMARY KEY (`message_id`),
    INDEX `idx_olo_events_entity`(`entity_key`),
    INDEX `idx_olo_events_received`(`received_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Estado interno de cada orden del OCB. ocb_orders es el contrato con la
-- pantalla y no tiene donde guardar el rango, las horas de retiro ni las
-- lapidas de reemplazo: eso vive aca. Nunca guarda PII.
CREATE TABLE IF NOT EXISTS `ocb_olo_state` (
    `order_guid` VARCHAR(255) NOT NULL,
    `state` VARCHAR(20) NOT NULL,
    `state_rank` TINYINT NOT NULL,
    `order_id_string` VARCHAR(64) NULL,
    `vendor_id_string` VARCHAR(64) NULL,
    `pos_ref` VARCHAR(64) NULL,
    `time_wanted` DATETIME(3) NULL,
    `visible_since` DATETIME(3) NULL,
    `closed_at` DATETIME(3) NULL,
    `arrived_at` DATETIME(3) NULL,
    `picked_up_at` DATETIME(3) NULL,
    `cancelled_at` DATETIME(3) NULL,
    `hide_at` DATETIME(3) NULL,
    `expire_at` DATETIME(3) NULL,
    `replaces_guid` VARCHAR(255) NULL,
    `replaced_by_guid` VARCHAR(255) NULL,
    -- Fila del board ya mapeada (JSON, sin PII). Una orden programada no tiene
    -- fila en ocb_orders hasta que se dispara, y el payload crudo no se guarda:
    -- sin esto no habria con que armarla al pasar a PLACED.
    `board_snapshot` TEXT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`order_guid`),
    INDEX `idx_ocb_olo_state_barrido`(`state`, `hide_at`, `expire_at`),
    INDEX `idx_ocb_olo_state_order_id`(`order_id_string`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Deltas de MenuItemAvailabilityChanged que llegaron para un pos_id que todavia
-- no existe en menu_items (el item es nuevo y la importacion aun no corrio). Se
-- aplican al terminar la siguiente importacion; la linea base manda sobre ellos.
CREATE TABLE IF NOT EXISTS `olo_pending_availability` (
    `pos_id` VARCHAR(255) NOT NULL,
    `in_stock` BOOLEAN NOT NULL,
    `received_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`pos_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
