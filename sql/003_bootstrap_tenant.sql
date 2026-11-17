-- Las tablas que este servicio necesita para arrancar en una base VACIA.
--
-- Hasta ahora las creaba Flyway desde el servidor Java, asi que en las tiendas
-- migradas ya existian y este archivo no hace nada. Pero al levantar un cliente
-- nuevo directo sobre el Node no las crea nadie, y el sync falla en cada ciclo
-- con "The table `menu_items` does not exist in the current database".
--
-- El DDL sale de `prisma migrate diff --from-empty --to-schema-datamodel`, o sea
-- que es exactamente lo que el cliente de Prisma espera encontrar.
--
-- Todo va con IF NOT EXISTS: sobre una base que ya venia de Flyway no toca nada.
-- flyway_schema_history no se crea a proposito — la declara el schema para que
-- `prisma db pull` no la marque como desconocida, pero el codigo nunca la usa.

-- Espejo de V4__create_menu_items.sql + V5__add_menu_number.sql
CREATE TABLE IF NOT EXISTS `menu_items` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `pos_id` VARCHAR(255) NOT NULL,
    `menu` VARCHAR(255) NOT NULL,
    `item_type` VARCHAR(50) NOT NULL,
    `category` VARCHAR(100) NULL,
    `parent_group` VARCHAR(255) NULL,
    `name` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `price` VARCHAR(50) NULL,
    `in_stock` BOOLEAN NULL DEFAULT true,
    `out_of_stock_icon` VARCHAR(255) NULL,
    `sort_order` INTEGER NULL,
    `menu_number` INTEGER NULL,
    `created_at` TIMESTAMP(0) NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` TIMESTAMP(0) NULL DEFAULT CURRENT_TIMESTAMP(0),
    `last_synced_to_onsign` TIMESTAMP(0) NULL,
    `is_active` BOOLEAN NULL DEFAULT true,
    `toast_last_modified` TIMESTAMP(0) NULL,
    `onsign_row_id` VARCHAR(50) NULL,
    `onsign_version` INTEGER NULL,
    `miss_count` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `pos_id`(`pos_id`),
    INDEX `idx_category`(`category`),
    INDEX `idx_last_synced`(`last_synced_to_onsign`),
    INDEX `idx_parent_group`(`parent_group`),
    INDEX `idx_pos_id`(`pos_id`),
    INDEX `idx_updated_at`(`updated_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Espejo de V1__create_ocb_tables.sql. Solo las usa el order confirmation board:
-- el sync del menu no las toca, pero sin ellas /api/toast/ocb falla.
CREATE TABLE IF NOT EXISTS `ocb_orders` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `order_guid` VARCHAR(255) NOT NULL,
    `display_number` VARCHAR(50) NOT NULL,
    `status` VARCHAR(50) NOT NULL,
    `restaurant_guid` VARCHAR(255) NOT NULL,
    `opened_date` DATETIME(3) NULL,
    `estimated_fulfillment_date` DATETIME(3) NULL,
    `total_amount` DOUBLE NOT NULL DEFAULT 0,
    `payment_status` VARCHAR(50) NULL,
    `business_date` INTEGER NOT NULL,
    `created_at` DATETIME(3) NULL,
    `updated_at` DATETIME(3) NULL,

    UNIQUE INDEX `uk_order_guid`(`order_guid`),
    INDEX `idx_ocb_orders_restaurant_date`(`restaurant_guid`, `business_date`),
    INDEX `idx_ocb_orders_status`(`restaurant_guid`, `status`),
    INDEX `idx_ocb_orders_guid`(`order_guid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- La foreign key va DENTRO del CREATE TABLE y no como un ALTER aparte:
-- asegurarEsquema() solo ejecuta CREATE ... IF NOT EXISTS, y un ALTER quedaria
-- omitido con un aviso, dejando la tabla sin la relacion.
CREATE TABLE IF NOT EXISTS `ocb_order_items` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `order_id` BIGINT NOT NULL,
    `name` VARCHAR(500) NOT NULL,
    `quantity` DOUBLE NOT NULL DEFAULT 1,
    `price` DOUBLE NOT NULL DEFAULT 0,
    `fulfillment_status` VARCHAR(50) NOT NULL,
    `modifiers` VARCHAR(2000) NULL,

    INDEX `fk_order_items_order`(`order_id`),
    PRIMARY KEY (`id`),
    CONSTRAINT `fk_order_items_order` FOREIGN KEY (`order_id`) REFERENCES `ocb_orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Espejo de V2__create_menu_cache_table.sql + V3__add_menu_sort_order.sql
CREATE TABLE IF NOT EXISTS `ocb_menu_cache_items` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `item_guid` VARCHAR(255) NOT NULL,
    `menu_name` VARCHAR(500) NOT NULL,
    `group_name` VARCHAR(500) NOT NULL,
    `name` VARCHAR(500) NOT NULL,
    `description` TEXT NULL,
    `image` VARCHAR(1000) NULL,
    `price` DOUBLE NULL,
    `price_varies` BOOLEAN NOT NULL DEFAULT false,
    `in_stock` BOOLEAN NOT NULL DEFAULT true,
    `synced_at` DATETIME(3) NOT NULL,
    `menu_order` INTEGER NOT NULL DEFAULT 0,
    `group_order` INTEGER NOT NULL DEFAULT 0,
    `item_order` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `uk_menu_cache_item_guid`(`item_guid`),
    INDEX `idx_menu_cache_menu`(`menu_name`),
    INDEX `idx_menu_cache_group`(`group_name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
