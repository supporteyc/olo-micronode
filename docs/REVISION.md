# Revision del prompt y decisiones de implementacion

Este documento compara `prompt-agente-opus-olo.md` con el codigo real de ec4toast-node y lista lo que se cambio al implementarlo. Donde el prompt y el codigo no coinciden, **manda el codigo**: el contrato es lo que hoy consumen OnSign y ec4-console, no lo que dice el prompt.

## 1. Errores del prompt frente al codigo de ec4toast-node

| # | El prompt dice | El codigo real hace | Que se hizo |
| --- | --- | --- | --- |
| 1 | `withCount=true` envuelve en `total` e `items` (seccion 3) | `{ totalItems, items }` (toast.controller.ts) | Se respeta `totalItems`. Hay un test de contrato. |
| 2 | RespuestaOcb trae `success, businessDate, received, inPreparation, ready` (seccion 8.1) | `restaurantGuid, generatedAt, totalOrders, receivedCount, inPreparationCount, readyCount, orders` (ocb.service.ts) | Se respeta la forma real, con el mismo orden de claves. |
| 3 | Existe `POST /webhooks/toast`, `toastWebhook.service.ts` y su test (secciones 1, 7, 11.2) | No existen en el repo | `oloWebhook.service.ts` es nuevo y no espejo. |
| 4 | Rutas del scheduler "GET y POST del scheduler" | `POST /api/toast/scheduler/pause`, `POST .../resume`, `GET .../status` | Mismas rutas y respuestas. |
| 5 | Lista de rutas de depuracion | Tambien existia `GET /api/toast/orders` (ordersBulk) | No tiene equivalente en Olo (no hay pull de ordenes); se quita. Ver ARCHITECTURE.md. |

## 2. Huecos de diseno del prompt y como se cerraron

1. **Carrera entre delta y linea base.** Si la linea base se lee en t0, llega un 86 por webhook en t1 y la linea base se escribe en t2, el 86 se pierde hasta la proxima reconciliacion. Solucion: un candado FIFO (`lib/mutex.ts`) por el que pasan importacion, linea base y deltas, y `eightysixeditems` se lee **dentro** del candado. La descarga del export (lenta) queda fuera.
2. **`express.json()` global rompe los int64.** `POST /api/olo/events` lee el body como texto y se monta antes del parser JSON (`app.ts`, `olo.routes.ts`).
3. **Orden de entrega del receptor.** Con reintentos en paralelo, un 86 viejo puede llegar despues del 68 que lo sigue. La outbox entrega en FIFO por tienda: si la cabeza esta en backoff, la tienda espera entera.
4. **Un mass 86 de brand puede mezclar tiendas** en el mismo array. El receptor lo parte y cada tienda recibe solo sus elementos.
5. **El 301 del Vendor Export.** `fetch` sigue redirecciones reenviando los headers; una URL prefirmada rechaza un `Authorization` extra. La redireccion se sigue a mano y sin headers de Olo. El mock reproduce ese rechazo.
6. **Zona horaria.** ec4toast-node calcula el businessDate con la hora del proceso; en un contenedor UTC cambia de dia a las 7 u 8 de la noche de Miami. Todo usa `OLO_STORE_TIMEZONE` o `storeTimeZone` del payload.
7. **Ordenes programadas sin payload.** Una orden SCHEDULED no tiene fila en `ocb_orders` y el prompt prohibe guardar el payload crudo: al dispararse no habria con que armarla. Se agrego `ocb_olo_state.board_snapshot` (la fila ya mapeada, sin PII). Va dentro del CREATE TABLE de sql/004, sin ALTER.
8. **Business date de una programada.** Pedida a las 22:00 para el desayuno de manana, con la fecha de `timePlaced` nunca aparece en el board de manana. Se usa la fecha de `timeWanted`.
9. **Flapping.** El caso del criterio 8 (68 que no cambia nada y despues un 86 viejo que si cambia) no se detecta contando cambios. Se cuentan **recepciones** de deltas por pos_id dentro de la ventana.
10. **Item que nace agotado.** Con el pipeline unico, una fila nueva nace ya en `in_stock=false` y solo registraba `created`. Se agrega `updated in_stock Yes->No` para que el historial muestre el 86 (criterio 1).
11. **Silencio de webhooks de noche.** De noche no hay ordenes ni 86 y el silencio es normal: alertaria todas las noches. Ahora el silencio dispara una reconciliacion y solo alerta si esa reconciliacion encuentra diferencias.
12. **Filas `skipped`.** ec4toast-node escribe una fila `skipped` (con `inventory_guids` NULL) cuando el candado esta tomado, y eso deja el semaforo en warn sin motivo. Una importacion que llega durante otra se encola; no se escriben filas skipped.
13. **Filas del tick con ceros.** El tick escribe `source_items` y `sold_out_items` con los conteos actuales, para que `lastRun` no muestre "0 items".
14. **Delivery en el board.** Un dispatch o delivery no se retira en el mostrador. `OCB_DELIVERY_METHODS` filtra (por defecto pickup, curbside, dinein). [PEDIR-A-ANDRES]
15. **401 masivos.** Un secreto rotado o una Destination URL cambiada hace que todo falle la firma; Olo reintenta 24 h y puede deshabilitar la suscripcion. Tras 10 firmas invalidas seguidas, `console.error` (alerta).
16. **Outbox en contenedor efimero.** bun:sqlite en un contenedor sin volumen pierde la outbox y el dedup en cada deploy. Documentado en RUNBOOK.md.
17. **Pendientes.** Como la linea base siempre sigue a la importacion y manda, los pendientes solo sirven cuando esa linea base falla. Se aplican en ese caso y se descartan en el otro.
18. **Pool de conexiones.** ec4toast-node crea un `PrismaClient` por servicio (cuatro pools). Aca hay uno solo por proceso.

## 3. Bugs encontrados durante la implementacion

- **`BigInt.toJSON` vivia en el logger.** Sin el logger instalado, `/api/status` caia en su rama de error. Se movio a `crearApp`.
- **El primer tick despues de importar volvia a llamar a Olo** porque la importacion no contaba como intento de reconciliacion.
- **El receptor descartaba eventos ante un 404 del node.** Encontrado en `dev:mock`: el puerto 8080 local lo tenia otro servidor (Apache) y el receptor tiro 3 eventos. Un 404 es una configuracion mala, no un payload roto: ahora se reintenta. Solo 400 y 413 se descartan.
- **La guarda de estados terminales del OCB** miraba `RANGO[state]` en vez del rango guardado y ocultaba la orden nueva de un reemplazo.

## 4. Desvios deliberados respecto del prompt

- **Acceso a datos detras de `Almacen`.** El prompt pide copiar menuItem, changeLog y syncRun "tal cual". La logica es la misma (freno de borrado, entradas del historial, una fila de sync_runs por ciclo), pero el acceso a datos pasa por `src/almacen/` con una implementacion Prisma y otra en memoria. Asi los tests corren sin MySQL y `dev:mock` levanta todo sin base.
- **Importacion y linea base en un solo pipeline.** El prompt pide upsert sin tocar `in_stock` y despues la linea base. Aca se usa el pipeline de Toast tal cual (aplanar, fusionar con el conjunto 86, planificar, upsert, borrar con freno). El resultado es el mismo y la fila nueva nace con el valor correcto. Si la linea base falla, `preservarStock` funciona igual que en Toast.
- **Columna `board_snapshot`** en `ocb_olo_state` (punto 2.7).
- **Ruta nueva `POST /api/toast/menu-export/reconcile`**, que fuerza solo la linea base. Y un bloque `olo` en `/api/status` con metricas extra; no se quito ningun campo.

## 5. Lo que los tests NO cubren todavia

- **`AlmacenPrisma` no esta probado contra MySQL.** En esta maquina no hay MySQL ni Docker. Los 18 criterios de stock y los del OCB corren sobre `AlmacenMemoria`, que imita la semantica (transacciones todo o nada, TIMESTAMP(0), orden de columnas). Antes de produccion hay que correr la suite contra un MySQL real: ver "Pruebas contra MySQL" en el README.
- `serviceAuth` es una copia sin cambios de ec4toast-node y no tiene test propio.
- La forma real del XML del Vendor Export (sin XSD, el fixture es SYNTHETIC).
