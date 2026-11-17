# ec4olo-node

Integracion de EyeCatch Networks con **Olo** para letreros digitales (menu boards y Order Confirmation Board). Es el gemelo de **ec4toast-node**: misma estructura, mismo contrato MySQL, mismas rutas HTTP (incluido el prefijo `/api/toast/`), con Olo como fuente de datos en lugar de Toast. El servidor de OnSign y ec4-console no cambian.

Tiene dos entrypoints:

| Proceso | Comando | Despliegue |
| --- | --- | --- |
| **ec4olo-node** | `bun run start` | Uno por tienda, con la MySQL de la tienda |
| **ec4olo-hook** (receptor de webhooks) | `bun run start:hook` | Uno solo para todas las tiendas, con volumen persistente |

## Probarlo en modo mock (un comando, sin credenciales ni MySQL)

```sh
bun install
bun run dev:mock
```

Levanta el mock de Olo (`:14010`), un ec4olo-node con almacen en memoria (`:18080`) y el receptor (`:18090`). En otra terminal:

```sh
# Ciclo de orden: aparece en el board y se retira un minuto despues de recogida
bun run replay fixtures/ocb-scenarios/ciclo-normal.json
curl -H "X-EC4-Key: dev-mock-key" http://localhost:18080/api/toast/ocb

# 86 y 68 por webhook
bun run replay fixtures/stock-scenarios/86-y-68.json
curl -H "X-EC4-Key: dev-mock-key" "http://localhost:18080/api/toast/menu-export?soldOutIconUrl=x"

# 86 en Olo sin webhook: lo arregla la reconciliacion
curl -X POST http://localhost:14010/__admin/86 -d '{"products":["90000000000000011"]}'
curl -X POST -H "X-EC4-Key: dev-mock-key" http://localhost:18080/api/toast/menu-export/reconcile

# Linea base caida: el stock no se toca y /api/status pasa a warn
curl -X POST http://localhost:14010/__admin/modo -d '{"modo86":"403"}'
```

El replay tiene opciones para reintentos con el mismo id (`--dup N`), rafagas (`--rafaga N`) y escenarios fuera de orden (`--invertir`, `--mezclar`). Ver el encabezado de `tools/replay/replay.ts`.

## Tests

```sh
bun test          # 144 tests
bun run typecheck # strict
```

- `tests/stock/`: los 18 criterios de aceptacion de stock, numerados.
- `tests/ocb/`: una prueba por regla de la maquina de estados.
- `tests/hook/`: receptor (firma, ack con outbox, dedup, ruteo, reintentos, orden por tienda).
- `tests/contrato/`: forma de menu-export, `/api/status`, `/api/runs`, menu-changes, OCB y scheduler frente a ec4toast-node.
- `src/services/*.test.ts`: los tests copiados de ec4toast-node (changeLog, menuDiff, freno de borrado, ocbFormat) y los nuevos (firma de la Ordering API, vector oficial de X-Olo-Signature, ids int64, parser y aplanado).

Los tests corren sobre `AlmacenMemoria`, que imita la semantica de MySQL. Para probar la implementacion Prisma:

### Pruebas contra MySQL

```sh
DATABASE_URL="mysql://usuario:password@localhost:3306/ec4olo_smoke" bun run scripts/smoke-mysql.ts
```

Usa una base **vacia** de prueba: aplica sql/001 a 004, importa, aplica deltas, prueba un rollback y escribe el OCB. **Hay que correrlo antes del primer despliegue**: en la maquina donde se escribio esto no habia MySQL.

## Configuracion

Todas las variables estan documentadas en `.env.example`, con valores falsos. Las de ec4toast-node se conservan (`DATABASE_URL`, `PORT`, `TENANT_NAME`, `ALERT_WEBHOOK_URL`, `SERVICE_TOKEN`, `MENU_CONFIG`, `MAX_DELETE_RATIO`, `DELETE_GUARD_MIN_ROWS`; `TOAST_SYNC_INTERVAL_MS` se acepta como alias de `SYNC_INTERVAL_MS`). La configuracion se valida al arrancar y el proceso no arranca con valores invalidos.

El esquema es el de ec4toast-node mas `sql/004_create_olo_tables.sql`, solo con `CREATE TABLE IF NOT EXISTS`. `asegurarEsquema()` lo aplica al arrancar.

## Documentacion

- [docs/REVISION.md](docs/REVISION.md): **empezar por aca**. Errores del prompt frente al codigo real, huecos de diseno cerrados, bugs encontrados y desvios deliberados.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): componentes, mapa de archivos, rutas y maquina de estados del OCB.
- [docs/STOCK.md](docs/STOCK.md): algoritmo de 86/68 y comparacion con Toast.
- [docs/OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md): lo que falta definir.
- [docs/VALIDATION_CHECKLIST.md](docs/VALIDATION_CHECKLIST.md): que validar cuando Olo entregue credenciales.
- [docs/RUNBOOK.md](docs/RUNBOOK.md): receptor caido, webhook deshabilitado, 403 de eightysixeditems, ordenes pegadas, rotacion de secretos.

## Pendientes

**[VALIDAR-CON-OLO]**
1. Orden del mensaje firmado de X-Olo-Signature (con un Test Event real).
2. Si el path firmado de la Ordering API incluye `/v1.1/`.
3. Headers obligatorios para solo lectura.
4. Permiso de eightysixeditems, y si su lista es exhaustiva.
5. Rate limits y frecuencia permitida de eightysixeditems.
6. Que los ids del XML del export coinciden con eightysixeditems e `itemEntityId`.
7. Significado de `itemExternalReference`.
8. Si un reintento conserva `X-Olo-Message-Id` y si se reintentan los 4xx.
9. Campo del numero visible de la orden.
10. Si `replacementDetails.originalId` es uuid o numerico.
11. Formato de las horas de recogida, cancelacion y llegada.
12. Comportamiento de ScheduledOrderFired y de OrderClosed frente a OrderPickedUp.

**[PEDIR-A-ANDRES]**
1. XSD del Vendor Export (o un export real anonimizado).
2. Si el console acepta `side: "olo"` y `trigger_source: "webhook"`.
3. Si el consumidor del OCB entiende `PICKED_UP` y `CANCELLED`.
4. Status de una orden recien pedida (IN_PREPARATION o RECEIVED).
5. Si las tiendas usan Expo.
6. MENU_CONFIG por tienda y profundidad de modificadores.
7. Como llega el receptor a cada tienda (red, DNS, TLS).
8. Regla de `payment_status`.
9. Que `deliveryMethod` van al board.
10. Si una programada con `ScheduledOrderFailed` debe mostrarse.
