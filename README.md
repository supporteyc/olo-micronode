# ec4olo-node

Integracion de EyeCatch Networks con **Olo** para letreros digitales: menu boards (stock y agotados) y Order Confirmation Board (OCB).

Es el **gemelo de ec4toast-node**. Tiene la misma estructura, el mismo contrato MySQL y las mismas rutas HTTP, incluido el prefijo `/api/toast/`. Lo unico que cambia es la fuente de datos: Olo en vez de Toast. **El servidor de OnSign y ec4-console no tienen que cambiar nada.**

> Estado: construido y probado contra un mock de Olo. Todavia no hay cuenta de Olo (ni Sandbox ni Production): todo lo que depende de Olo esta marcado `[VALIDAR-CON-OLO]`. Ver [Cuando Olo entregue la cuenta](#9-cuando-olo-entregue-la-cuenta).

---

## Indice

1. [Resumen: Toast vs Olo](#1-resumen-toast-vs-olo)
2. [Lo que NO cambia (contrato)](#2-lo-que-no-cambia-contrato)
3. [Lo que cambio y por que](#3-lo-que-cambio-y-por-que)
4. [Stock: 86 y 68](#4-stock-86-y-68)
5. [OCB por webhooks](#5-ocb-por-webhooks)
6. [El receptor de webhooks (pieza nueva)](#6-el-receptor-de-webhooks-pieza-nueva)
7. [Mejoras sobre ec4toast-node](#7-mejoras-sobre-ec4toast-node)
8. [Lo que hay que tener en cuenta](#8-lo-que-hay-que-tener-en-cuenta)
9. [Cuando Olo entregue la cuenta](#9-cuando-olo-entregue-la-cuenta)
10. [Como correrlo](#10-como-correrlo)
11. [Configuracion](#11-configuracion)
12. [Estructura del repo](#12-estructura-del-repo)
13. [Pendientes](#13-pendientes)
14. [Mas documentacion](#14-mas-documentacion)

---

## 1. Resumen: Toast vs Olo

| Tema | ec4toast-node | ec4olo-node |
| --- | --- | --- |
| Fuente | API de Toast (token de maquina) | Ordering API v1.1 de Olo (cada peticion firmada, `OloSignature`) |
| Como llega la informacion | **Polling** cada 78 s | **Webhooks** de Olo + reconciliacion periodica |
| Menu | `menus/v2` en cada ciclo | **Vendor Export** (XML en un zip): al arrancar, cuando Olo avisa que cambio y una vez al dia |
| Stock | `stock/v1/inventory` en cada ciclo | Webhook `MenuItemAvailabilityChanged` (segundos) + `eightysixeditems` cada 5 a 15 min |
| Tiempo para ver un agotado | hasta 78 s | segundos |
| OCB | el GET pide las ordenes a Toast (pull) | los webhooks de ordenes escriben; el GET solo lee la base |
| Procesos | 1 por tienda | 1 por tienda **+ 1 receptor central** de webhooks |
| Base | MySQL de la tienda | la misma, mas 3 tablas nuevas (`sql/004`) |
| Ids | guids (texto) | enteros de 17 digitos (int64): se manejan siempre como texto |

**Por que no polling:** Olo **no permite** consultar el menu en vivo para guardarlo. Los endpoints de menu en vivo son solo para pedidos de usuarios. Por eso el diseno cambia de "preguntar cada 78 s" a "escuchar eventos y verificar cada tanto".

---

## 2. Lo que NO cambia (contrato)

Esto es lo que consumen OnSign y el console, y quedo identico. Hay tests de contrato que lo verifican (`tests/contrato/`).

**Tablas** (copiadas tal cual: `sql/001` a `003`, `prisma/schema.prisma`):
- `menu_items`: mismas columnas. `in_stock` false = agotado. `toast_last_modified` conserva el nombre aunque ahora lo escribe Olo.
- `menu_item_changes`: un 86 es `updated`, `in_stock`, `Yes -> No`; un 68 es `No -> Yes`. No existe `reactivated`.
- `sync_runs`: una fila por ciclo. `inventory_guids` NULL sigue significando "la fuente de stock no respondio".
- `ocb_orders` y `ocb_order_items`: mismas columnas. Una orden que no debe verse se borra.

**Rutas HTTP**, con el mismo prefijo `/api/toast/`, el mismo `X-EC4-Key` y los mismos formatos:

| Ruta | Quien la usa | Igual que en Toast |
| --- | --- | --- |
| `GET /api/toast/menu-export` | OnSign | Si. Misma fila, `in_stock` Yes/No, `sold_out_icon`, `withCount` -> `{ totalItems, items }` |
| `GET /api/status` | console | Si, con todos sus campos y el mismo semaforo. Se **agregaron** campos, no se quito ninguno |
| `GET /api/runs`, `GET /api/logs` | console | Si |
| `GET /api/toast/menu-changes` | console | Si |
| `GET /api/toast/menu-categories` | console | Si, mas un campo `kind` (category u optiongroup) |
| `GET /api/toast/ocb` | pantalla OCB | Si, misma respuesta (`restaurantGuid, generatedAt, totalOrders, receivedCount, inPreparationCount, readyCount, orders`) |
| `POST /api/toast/menu-export/sync` | console | Si. Ahora descarga el Vendor Export + 86 |
| `/api/toast/scheduler/pause`, `resume` y `status` | console | Si |
| `GET /health` | contenedor | Si |

**Variables de entorno de Toast que se conservan:**
- `DATABASE_URL`, `PORT`, `TENANT_NAME`, `ALERT_WEBHOOK_URL`, `SERVICE_TOKEN`, `MENU_CONFIG`, `MAX_DELETE_RATIO` y `DELETE_GUARD_MIN_ROWS`.
- `TOAST_SYNC_INTERVAL_MS` se acepta como alias de `SYNC_INTERVAL_MS`.

**Reglas que se conservan:**
- `MENU_CONFIG` tiene el mismo formato, aplicado a las categorias de Olo.
- El **freno de borrado** no borra si el menu llega con menos de la mitad de las filas.
- **`preservarStock`**: si la fuente de stock falla, no se toca ningun `in_stock`.
- El historial de cambios se mantiene.
- El candado de ciclo y el scheduler pausable funcionan igual.
- Los logs se guardan en memoria y `console.error` dispara una alerta.

---

## 3. Lo que cambio y por que

### 3.1 Archivo por archivo

| ec4toast-node | ec4olo-node | Que cambio |
| --- | --- | --- |
| `toastApi.service.ts` | `oloApi.service.ts` | Sin token: cada peticion se firma con HMAC (`Authorization: OloSignature ...` + `Date`). Reintentos con espera ante 429 y 5xx. Descarga del zip del Vendor Export |
| `menuSync.service.ts` | mismo nombre | El ciclo unico se parte en tres: **importar**, **reconciliar** y **tick de salud** (ver 4). `getMenuExport` es identico |
| `menuFlatten.service.ts` | mismo nombre + `vendorExport.parser.ts` | Aplana el XML de Olo en vez del JSON de Toast. `fusionarInventario` pasa a `fusionarOchentaYSeis` |
| `menuDiff.service.ts` | mismo nombre | Sin cambios de logica |
| `menuItem.service.ts`, `changeLog.service.ts` y `syncRun.service.ts` | mismos nombres | Misma logica. Las lecturas y escrituras pasan por `src/almacen/` (ver 3.2) |
| `ocb.service.ts` | mismo nombre | Maquina de estados alimentada por webhooks en vez de pull |
| `ocbFormat.service.ts` | mismo nombre | Lo de Toast quedo igual (con sus tests). Se agrego el mapeo de la orden de Olo |
| `index.ts` | `index.ts` + `app.ts` + `logger.ts` + `contenedor.ts` | Mismo arranque, separado en piezas para poder testear y reusar el logger en el receptor |
| `serviceAuth.ts`, `menuConfig.ts` y `schema.service.ts` | mismos nombres | Copias sin cambios de logica |
| (no existia) | `availability.service.ts` | Agotados por webhook |
| (no existia) | `storeHealth.service.ts` | Tienda online/offline |
| (no existia) | `oloEvents.service.ts` | Reparte cada evento al servicio que corresponde |
| (no existia) | `oloWebhook.service.ts` | Verificacion de la firma de Olo |
| (no existia) | `src/hook.ts` y `src/hook/` | **Receptor central** de webhooks |
| (no existia) | `sql/004_create_olo_tables.sql` | 3 tablas nuevas, solo `CREATE TABLE IF NOT EXISTS` |

### 3.2 Acceso a datos: `Almacen`

En ec4toast-node cada servicio hablaba directo con Prisma, y la logica solo se podia probar con MySQL corriendo. Aca la logica habla con una interfaz (`src/almacen/tipos.ts`) que tiene dos implementaciones:

- **`AlmacenPrisma`**: produccion, sobre MySQL. Mismas consultas que ec4toast-node.
- **`AlmacenMemoria`**: tests y modo mock. Imita a MySQL: transacciones todo o nada, segundos sin milisegundos y el mismo orden de columnas.

Se elige con `ALMACEN=mysql|memoria`. Con `OLO_ENV=production` la memoria esta prohibida.

### 3.3 Tablas nuevas (`sql/004`)

| Tabla | Para que |
| --- | --- |
| `olo_webhook_events` | Evitar procesar dos veces el mismo evento. Olo puede mandar el mismo mensaje varias veces |
| `ocb_olo_state` | Estado interno de cada orden: en que paso esta, cuando se oculta, reemplazos |
| `olo_pending_availability` | Agotados que llegaron para un item que todavia no existe en el menu |

### 3.4 Rutas nuevas o reemplazadas

| Ruta | Nota |
| --- | --- |
| `POST /api/olo/events` | **Nueva.** Entrada de los eventos que reenvia el receptor |
| `POST /api/toast/menu-export/reconcile` | **Nueva.** Fuerza solo la verificacion de agotados |
| `GET /api/toast/test-authentication` | Ahora prueba la firma contra Olo |
| `GET /api/toast/vendor-export-status` | Reemplaza a `menus-v2` |
| `GET /api/toast/eightysixed` | Reemplaza a `inventory` |
| `GET /api/toast/restaurant-info` | Ahora consulta a Olo |
| `GET /api/toast/orders` | **Eliminada.** Olo no permite pedir ordenes; llegan por webhook |

---

## 4. Stock: 86 y 68

86 = agotado, 68 = disponible de nuevo. Olo agota por separado los **productos** y las **opciones de modificador**.

### Los tres caminos que actualizan el stock

| Camino | Cuando | Que hace |
| --- | --- | --- |
| **Webhook** `MenuItemAvailabilityChanged` | Al instante, cuando la tienda agota algo | Cambia solo esos items, en una transaccion |
| **Reconciliacion** con `eightysixeditems` | Cada `OLO_RECONCILE_INTERVAL_MS` (sugerido 10 min), tras cada importacion, si hay sospecha de eventos desordenados o si hay silencio de webhooks | Pide a Olo la lista completa de agotados y corrige lo que este distinto. Repara webhooks perdidos |
| **Importacion** del Vendor Export | Al arrancar, cuando Olo avisa que el menu cambio, una vez al dia y a mano | Actualiza el menu (nombres, precios, items nuevos o borrados) y despues aplica la lista de agotados |

Los tres pasan por **un mismo candado en fila**, asi uno no pisa al otro.

### Diferencias clave con Toast

| | Toast | Olo |
| --- | --- | --- |
| Quien decide el stock | el inventario, solo si menciona el item | la lista de agotados de Olo, **siempre**: si no esta en la lista, esta disponible |
| El menu trae stock | si (`outOfStock`, viejo) | no. El export **incluye** los items agotados e `isdisabled` esta deprecado |
| Horarios (desayuno, etc.) | - | **No son agotados.** Nunca cambian `in_stock` |
| Tienda cerrada u offline | - | Se muestra en `/api/status` (`health.storeOnline`). **No** marca el menu como agotado |
| Si la fuente falla | se conserva el stock | igual: nunca se interpreta un error como "nada agotado" |

### El tick de salud

El console marca amarillo si el ultimo ciclo es viejo. Como ahora no hay polling, un **tick** cada `SYNC_INTERVAL_MS` escribe una fila en `sync_runs` **sin llamar a Olo**. Esa fila arrastra el resultado de la ultima verificacion. Asi el semaforo funciona igual que con Toast.

Detalle completo: [docs/STOCK.md](docs/STOCK.md).

---

## 5. OCB por webhooks

Con Toast, cada vez que la pantalla pedia el board, el servidor le pedia las ordenes a Toast. Con Olo, **las ordenes llegan solas por webhook** y el board solo lee la base.

| Evento de Olo | Efecto en el board |
| --- | --- |
| `OrderPlaced` | Aparece como `IN_PREPARATION` (configurable). Si es para mas tarde, espera |
| `ScheduledOrderFired` | La orden programada aparece |
| `OrderClosed` | Pasa a `READY`. **Ojo:** Olo lo manda cuando llega la hora estimada, no porque la cocina termino |
| `OrderPickedUp` | Sigue en `READY` unos minutos y despues desaparece |
| `OrderCancelled` | Desaparece |
| `OrderPlaced` con `isReplacement` | La orden original desaparece y queda la nueva (Olo no manda cancelacion al modificar) |

Reglas:
- **El estado nunca retrocede.** Si llega tarde un evento viejo, se ignora.
- **Ninguna orden queda pegada:** toda orden desaparece como maximo a los `OCB_MAX_TTL_MIN` (120 min).
- No se guardan datos personales; el nombre del cliente solo se usa si se configura como numero visible.
- Las ordenes de **delivery** no se muestran (configurable).
- Las horas se toman del payload de Olo, en la zona horaria de la tienda.

Diagrama de estados: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## 6. El receptor de webhooks (pieza nueva)

Olo permite **una sola URL de webhook por brand**, no una por tienda. Por eso hay un receptor central que recibe todo y reparte:

```
Olo  ->  ec4olo-hook  ->  ec4olo-node de la tienda 1
                      ->  ec4olo-node de la tienda 2
                      ->  ...
```

Que hace, y nada mas:
1. **Verifica la firma** de Olo (`X-Olo-Signature`). Firma mala: 401.
2. **Descarta duplicados** por `X-Olo-Message-Id`.
3. **Guarda el evento en disco** (bun:sqlite) y **recien ahi responde 200** a Olo. Olo necesita respuesta en menos de 1 s.
4. **Entrega a cada tienda en orden**, con reintentos. Si una tienda esta caida, sus eventos esperan y no se pierden.
5. Si un agotado masivo trae items de varias tiendas, **lo parte** y cada una recibe lo suyo.

Salud: `GET /healthz` y `GET /metrics` (eventos por tipo, duplicados, firmas invalidas, pendientes y edad del mas viejo).

---

## 7. Mejoras sobre ec4toast-node

Cosas que no estaban en ec4toast-node (ni en el pedido original) y que se resolvieron aca. Varias **se podrian llevar de vuelta a ec4toast-node**.

| Mejora | Problema que resuelve | ¿Aplica a Toast? |
| --- | --- | --- |
| Fecha de negocio en la zona de la tienda | ec4toast-node usa la hora del servidor: en un servidor UTC el "dia" cambia a las 7 u 8 de la noche de Miami | **Si** |
| Una sola conexion a MySQL | ec4toast-node abre 4 pools (un `PrismaClient` por servicio) | **Si** |
| No escribir filas `skipped` por choque de ciclos | Dejan el semaforo en amarillo sin motivo | **Si** |
| `BigInt.toJSON` en la app y no en el logger | Sin el logger, `/api/status` fallaba | **Si** |
| Tests sin MySQL (almacen en memoria) | Antes la logica con base no se podia probar | **Si** |
| Candado en fila para el stock | Un agotado por webhook podia perderse si coincidia con una verificacion | Solo Olo |
| Ids de 17 digitos sin perder precision | JavaScript los redondea y el agotado cae en otro item | Solo Olo |
| Entrega en orden por tienda | Un reintento viejo podia pisar un evento nuevo | Solo Olo |
| Ordenes programadas guardadas sin datos personales | Al dispararse no habia con que mostrarlas | Solo Olo |
| Programadas en el board del dia en que se retiran | Una pedida de noche para la manana no aparecia nunca | Solo Olo |
| Alerta de silencio inteligente | De noche no hay webhooks y alertaria todas las noches | Solo Olo |
| Alerta por firmas invalidas seguidas | Un secreto rotado haria que Olo deshabilite la suscripcion sin aviso | Solo Olo |
| Validacion de configuracion al arrancar | Con valores invalidos el proceso no arranca, en vez de correr mal | **Si** |

**Bugs encontrados y corregidos durante el desarrollo:**
- El receptor descartaba eventos ante un 404. Se detecto en una prueba real: otro servidor ocupaba el puerto 8080.
- El primer ciclo despues de importar volvia a llamar a Olo sin necesidad.
- Una orden que reemplaza a otra quedaba oculta.

**Errores del documento original que se corrigieron** (manda el codigo de ec4toast-node):
- `withCount` devuelve `totalItems`, no `total`.
- La respuesta del OCB tiene otra forma.
- `POST /webhooks/toast` no existe.

Detalle: [docs/REVISION.md](docs/REVISION.md).

---

## 8. Lo que hay que tener en cuenta

### Antes del primer despliegue

1. **Probar contra un MySQL real.** Los tests corren en memoria; la parte de MySQL no se probo en una base real porque no habia MySQL disponible. Hay que correr una vez:
   ```sh
   DATABASE_URL="mysql://usuario:password@host:3306/base_vacia_de_prueba" bun run scripts/smoke-mysql.ts
   ```
   Usar una base **vacia**: el script se niega a correr si encuentra datos.
2. **El receptor necesita un volumen persistente** para `HOOK_DB_PATH`. Sin volumen, cada deploy borra los eventos pendientes.
3. **Una sola instancia del receptor.** No escalarlo a varias copias con el mismo archivo.
4. **`OLO_WEBHOOK_URL` tiene que ser exactamente la URL registrada en Olo**, letra por letra, porque forma parte de la firma.
5. **Dos servicios en Zeabur** (o donde sea), con el mismo Dockerfile:
   - por tienda: `bun run start`;
   - receptor: `bun run start:hook`.

### Diferencias de comportamiento que el equipo debe conocer

- **"READY" no significa que la cocina termino.** Olo manda `OrderClosed` cuando llega la hora estimada. Olo no documenta otra senal de "orden lista".
- **Si una tienda no usa Expo**, nunca llega `OrderPickedUp`. Hay que configurar `OCB_HIDE_ON_CLOSED_AFTER_MIN` o las ordenes quedan hasta el TTL.
- **La autocorreccion ya no es cada 78 s** sino en cada verificacion (sugerido 10 min). Los webhooks cubren lo inmediato.
- **Las horas de Olo vienen en minutos**, sin segundos. Un retiro del board puede adelantarse hasta 59 s.
- **Un item nuevo en Olo** no aparece en pantalla hasta la siguiente importacion. Olo avisa con `VendorMenuExportComplete`; si ese aviso se pierde, lo cubre el respaldo diario.
- **El Vendor Export se lee con un parser provisional.** Esta armado sin el XSD oficial y hay que ajustarlo cuando llegue un export real.

### Lo que todavia no se sabe de Olo

No se adivino nada. Todo esta detras de una variable o marcado en el codigo:
- frecuencia permitida y rate limits;
- si la lista de agotados es completa;
- que campo es el numero visible de la orden;
- el formato exacto de algunas horas.

Lista completa en la seccion 13.

---

## 9. Cuando Olo entregue la cuenta

### Que pedirle a Olo

- [ ] Credenciales de **Sandbox**: ClientId y Client Secret (plataforma ThirdParty, Signature Authorization).
- [ ] El **permiso especial de `eightysixeditems`** para ese ClientId. Sin el, la verificacion de agotados da 403.
- [ ] El **VendorId** del restaurante de prueba (y despues el de cada tienda).
- [ ] Acceso al **Dashboard de webhooks** del brand para registrar la URL y obtener el secreto.
- [ ] El **XSD del Vendor Export** o un export de ejemplo.
- [ ] **Rate limits** y frecuencia permitida para `eightysixeditems` y `vendorexport`.
- [ ] Confirmar si la **lista de `eightysixeditems` es completa** (todos los agotados, sin paginar).
- [ ] Si las 4 tiendas son **un brand o varios** (cambia cuantas URLs y secretos de webhook hay).
- [ ] Que campo ve el cliente como **numero de orden** (`posRef` u otro).
- [ ] Si un reintento de webhook **conserva el `X-Olo-Message-Id`**.

### Pasos para validar con Sandbox

1. Poner en `.env`: `OLO_ENV=sandbox`, `OLO_CLIENT_ID`, `OLO_CLIENT_SECRET`, `OLO_VENDOR_ID` y `MENU_CONFIG`.
2. `GET /api/toast/test-authentication`: confirma que la firma funciona. Si falla, probar `OLO_SIGN_PATH_WITH_VERSION=false`.
3. `GET /api/toast/vendor-export-status` y despues `POST /api/toast/menu-export/sync`: confirma la descarga y el parser del Vendor Export.
4. `GET /api/toast/menu-categories`: ver las categorias reales y armar `MENU_CONFIG`.
5. `GET /api/toast/eightysixed`: confirma el permiso (200 y no 403).
6. Desplegar el receptor, registrar su URL en el Dashboard de Olo y mandar el **Test Event**. Tiene que dar 200: eso valida la firma de webhooks.
7. Agotar un item en la tienda de prueba y ver que cambie en `menu-export` en segundos.
8. Hacer una orden de prueba y seguirla en `GET /api/toast/ocb`.
9. Marcar cada punto en [docs/VALIDATION_CHECKLIST.md](docs/VALIDATION_CHECKLIST.md).

---

## 10. Como correrlo

### Modo mock (sin cuenta de Olo, sin MySQL, un comando)

```sh
bun install
bun run dev:mock
```

Levanta un **Olo falso** (`:14010`), un **ec4olo-node** con base en memoria (`:18080`) y el **receptor** (`:18090`). En otra terminal:

```sh
# Una orden: aparece en el board y desaparece 1 minuto despues de recogida
bun run replay fixtures/ocb-scenarios/ciclo-normal.json
curl -H "X-EC4-Key: dev-mock-key" http://localhost:18080/api/toast/ocb

# Agotar y reponer por webhook
bun run replay fixtures/stock-scenarios/86-y-68.json
curl -H "X-EC4-Key: dev-mock-key" "http://localhost:18080/api/toast/menu-export?soldOutIconUrl=x"

# Agotar en "Olo" sin webhook: lo arregla la verificacion
curl -X POST http://localhost:14010/__admin/86 -d '{"products":["90000000000000011"]}'
curl -X POST -H "X-EC4-Key: dev-mock-key" http://localhost:18080/api/toast/menu-export/reconcile

# Simular que Olo niega el permiso: el stock no se toca y el semaforo pasa a amarillo
curl -X POST http://localhost:14010/__admin/modo -d '{"modo86":"403"}'
```

El replay tambien simula duplicados (`--dup N`), rafagas (`--rafaga N`) y eventos fuera de orden (`--invertir`, `--mezclar`).

### Tests

```sh
bun test           # 144 tests
bun run typecheck  # TypeScript strict
```

| Carpeta | Que prueba |
| --- | --- |
| `tests/stock/` | Los 18 criterios de agotados, numerados |
| `tests/ocb/` | Cada regla del board |
| `tests/hook/` | Receptor: firma, respuesta rapida, duplicados, reparto, reintentos, orden |
| `tests/contrato/` | Que las respuestas tengan la misma forma que ec4toast-node |
| `src/services/*.test.ts` | Tests copiados de ec4toast-node, mas firma de Olo, ids y parser |

### Produccion

```sh
bun run start       # ec4olo-node (uno por tienda)
bun run start:hook  # receptor (uno solo)
```

---

## 11. Configuracion

Todas las variables estan en [`.env.example`](.env.example), con valores falsos y una explicacion. La configuracion se valida al arrancar.

| Grupo | Variables principales |
| --- | --- |
| Heredadas de Toast | `DATABASE_URL`, `PORT`, `TENANT_NAME`, `ALERT_WEBHOOK_URL`, `SERVICE_TOKEN`, `MENU_CONFIG`, `MAX_DELETE_RATIO`, `DELETE_GUARD_MIN_ROWS` |
| Olo | `OLO_ENV` (mock/sandbox/production), `OLO_CLIENT_ID`, `OLO_CLIENT_SECRET`, `OLO_VENDOR_ID`, `OLO_STORE_TIMEZONE` |
| Stock | `SYNC_INTERVAL_MS`, `OLO_RECONCILE_INTERVAL_MS`, `OLO_EXPORT_DAILY_AT`, alertas `OLO_RECONCILE_ALERT_*` |
| OCB | `OCB_PLACED_STATUS`, `OCB_PICKED_UP_HIDE_AFTER_MIN`, `OCB_MAX_TTL_MIN`, `OCB_HIDE_ON_CLOSED_AFTER_MIN`, `OCB_DELIVERY_METHODS`, `OCB_DISPLAY_NUMBER_SOURCE` |
| Receptor | `OLO_WEBHOOK_SECRET`, `OLO_WEBHOOK_URL` (o `OLO_HOOK_BRANDS` si hay varios brands), `OLO_HOOK_ROUTES`, `HOOK_DB_PATH` |

Todos los intervalos son **sugerencias**, pendientes de confirmar con Olo.

---

## 12. Estructura del repo

```
src/
  index.ts            arranque de una tienda
  hook.ts             arranque del receptor
  app.ts              rutas HTTP
  contenedor.ts       arma los servicios
  logger.ts           logs en memoria + alertas
  config/             menuConfig (copia), runtime, olo (validada)
  almacen/            interfaz de datos: prisma (MySQL) y memoria
  services/           logica (ver tabla 3.1)
  hook/               receptor: config, outbox, entrega
  lib/                ids grandes, candado, zonas horarias
  routes/, controllers/, middleware/
sql/                  001 a 003 (copias) + 004 (nuevas tablas)
prisma/schema.prisma  esquema de ec4toast-node + 3 modelos
tools/mock-olo/       Olo falso
tools/replay/         reenvio de webhooks firmados
fixtures/             webhooks, Vendor Export y escenarios (todo sintetico)
scripts/              dev-mock, smoke-mysql, apply-sql
tests/                stock, ocb, hook, contrato
docs/                 documentacion detallada
```

---

## 13. Pendientes

**Para validar con Olo** `[VALIDAR-CON-OLO]`:
1. Orden exacto del mensaje que firma los webhooks (probar con un Test Event real).
2. Si la firma de la API incluye `/v1.1/` en la ruta.
3. Headers obligatorios.
4. Permiso de `eightysixeditems` y si su lista es completa.
5. Rate limits.
6. Que los ids del export coincidan con los de los agotados y los webhooks.
7. Significado de `itemExternalReference`.
8. Si un reintento conserva el `X-Olo-Message-Id`.
9. Campo del numero visible de la orden.
10. Formato de `replacementDetails.originalId`.
11. Formato de las horas de recogida, cancelacion y llegada.
12. Orden real de `ScheduledOrderFired`, `OrderClosed` y `OrderPickedUp`.

**Para decidir internamente** `[PEDIR-A-ANDRES]`:
1. XSD del Vendor Export.
2. Si el console acepta `side: "olo"` y `trigger_source: "webhook"`.
3. Si la pantalla del OCB entiende `PICKED_UP` y `CANCELLED`.
4. Si una orden nueva se muestra como `IN_PREPARATION` o `RECEIVED`.
5. Si las tiendas usan Expo.
6. `MENU_CONFIG` de cada tienda y cuantos niveles de modificadores mostrar.
7. Como llega el receptor a cada tienda (red, DNS, TLS).
8. Regla de pago (`OPEN`/`PAID`).
9. Que tipos de entrega van al board.
10. Que hacer con una programada que fallo (`ScheduledOrderFailed`).

---

## 14. Mas documentacion

| Documento | Contenido |
| --- | --- |
| [docs/REVISION.md](docs/REVISION.md) | Errores del pedido original, huecos de diseno, bugs y decisiones |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Diagramas, mapa de archivos, todas las rutas, estados del OCB |
| [docs/STOCK.md](docs/STOCK.md) | Algoritmo completo de agotados |
| [docs/OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md) | Preguntas abiertas con su valor actual |
| [docs/VALIDATION_CHECKLIST.md](docs/VALIDATION_CHECKLIST.md) | Checklist para Sandbox |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Que hacer si: receptor caido, webhook deshabilitado, 403, ordenes pegadas, rotacion de secretos |
