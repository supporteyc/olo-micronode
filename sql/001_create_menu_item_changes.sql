-- Historial de cambios del menú.
--
-- El log del servidor dice qué cambió, pero vive en memoria y se pierde al
-- reiniciar. Esta tabla guarda el antes y el después de forma permanente, para
-- poder responder "¿cuándo subió de precio el Wings?" semanas después.
--
-- CÓMO APLICARLA:
--   Esta base la administra Flyway desde el servidor Java. NO uses
--   `prisma migrate` contra ella: Prisma intentaría tomar posesión de todo el
--   esquema y pelearía con Flyway. Corre este archivo a mano:
--
--     mysql -h <host> -P <puerto> -u <usuario> -p atomicwings < sql/001_create_menu_item_changes.sql
--
--   Es idempotente, así que volver a correrlo no hace daño.

CREATE TABLE IF NOT EXISTS menu_item_changes (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,

    pos_id VARCHAR(255) NOT NULL,

    -- El nombre se copia a propósito en vez de referenciar menu_items: si el
    -- ítem se borra o se renombra, el historial tiene que seguir leyéndose.
    item_name VARCHAR(255) NOT NULL,

    -- created | updated | deactivated | reactivated
    change_type VARCHAR(20) NOT NULL,

    -- Campo que cambió (price, name, in_stock, ...). En un alta o una baja
    -- describe el evento, no una columna concreta.
    field VARCHAR(50) NOT NULL,

    old_value TEXT,
    new_value TEXT,

    changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_menu_changes_pos_id (pos_id),
    INDEX idx_menu_changes_changed_at (changed_at),
    INDEX idx_menu_changes_field (field)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
