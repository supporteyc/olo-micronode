# Stock: agotados (86) y vueltas a stock (68)

86 = no disponible. 68 = disponible de nuevo. Olo 86ea por separado Products y Choices (opciones de modificador).

## Llaves

| Origen | PRODUCT | MODIFIER |
| --- | --- | --- |
| Vendor Export | `String(product.id)` | `String(option.id) + "__mod"` |
| eightysixeditems | `products[].id` | `choices[].id + "__mod"` |
| MenuItemAvailabilityChanged | `itemEntityType=Product`: `itemEntityId` | `itemEntityType=Choice`: `itemEntityId + "__mod"` |

Los ids son int64 de 17 digitos: se leen siempre como string (`lib/ids.ts`). Un Product y un Choice con el mismo numero no se pisan gracias al sufijo.

## Los tres caminos que escriben in_stock

Los tres pasan por el mismo candado FIFO (`lib/mutex.ts`), en orden de llegada.

1. **Importacion** (`menuSync.importar`): al arrancar, en `VendorMenuExportComplete` con `hasMenuChanges`, en el respaldo diario y a mano (`POST /api/toast/menu-export/sync`).
   1. Descarga el Vendor Export (fuera del candado).
   2. Aplana con MENU_CONFIG. Toda fila sale con `in_stock=true`: el export incluye los items 86 y `isdisabled` esta deprecado.
   3. Dentro del candado lee `eightysixeditems` y `fusionarOchentaYSeis` aplica el conjunto: en el conjunto = No, fuera = Yes.
   4. `planificar`, `upsertFilas`, `borrarAusentes` con freno e historial: el pipeline de ec4toast-node.
   5. Si `eightysixeditems` fallo: `preservarStock` (no se compara ni se escribe in_stock), `inventory_guids` NULL y se aplican los pendientes.
2. **Reconciliacion** (`menuSync.reconciliar`): cada `OLO_RECONCILE_INTERVAL_MS`, al detectar flapping, con silencio de webhooks y a mano (`POST /api/toast/menu-export/reconcile`). Lee `eightysixeditems` y aplica el conjunto a todas las filas existentes. Escribe solo lo que cambia, con historial, en una transaccion.
3. **Deltas** (`availability.aplicar`): cada `MenuItemAvailabilityChanged`. Solo los elementos con `locationId == OLO_VENDOR_ID`. Todo el array va en una transaccion junto con el registro del message id. Los pos_id desconocidos van a `olo_pending_availability`.

**Un fallo nunca se lee como "nada esta agotado".** 403, 429, 5xx, timeout o una respuesta con forma inesperada dejan el stock como esta.

## Estrategia: webhooks + reconciliacion

Todos los intervalos son sugerencias configurables. PENDIENTE DE CONFIRMAR CON OLO: Olo no publica rate limits ni la frecuencia permitida de eightysixeditems.

| Mecanismo | Disparador | Frecuencia sugerida | Que arregla |
| --- | --- | --- | --- |
| Webhook MenuItemAvailabilityChanged | Evento de Olo | Inmediato | 86/68 en segundos |
| Webhooks de ordenes | Evento de Olo | Inmediato | OCB en vivo |
| Reconciliacion eightysixeditems | Temporizador, arranque, tras cada import, flapping, silencio | 5 a 15 min | Webhooks perdidos o fuera de orden |
| Vendor Export | VendorMenuExportComplete, arranque, respaldo diario | Por evento + 1 vez al dia | Menu nuevo; evento de export perdido |
| Ciclo de salud | Temporizador | 60 a 78 s, sin llamar a Olo | Semaforo, metricas, alertas |

## Lado a lado con Toast

| Paso | Toast hoy | Olo |
| --- | --- | --- |
| Estructura | menus/v2 cada 78 s | Vendor Export por evento y al arrancar |
| Stock viejo | outOfStock del menu | ninguno (el export no sirve para stock) |
| Stock vivo | stock/v1/inventory cada ciclo | eightysixeditems tras importar y al reconciliar, mas deltas por webhook |
| Precedencia | el inventario manda si menciona el guid | el conjunto 86 manda siempre |
| Fuente caida | preservarStock | preservarStock |
| Historial | updated in_stock Yes/No | identico |
| Modificador | guid + "__mod" | id de opcion + "__mod" |
| Exposicion | menu-export in_stock Yes/No | identico |
| Autocorreccion | cada 78 s | al reconciliar (5 a 15 min) y por flapping |

## Ciclo de salud y semaforo

`/api/status` pasa a warn si el ultimo run tiene mas de 3 intervalos o si su `inventory_guids` es NULL. Por eso cada tick escribe una fila: `ok`, `SIN_CAMBIOS`, con el `inventory_guids` de la ultima linea base exitosa (NULL si la ultima fallo). Hace a lo sumo una de estas cosas, en este orden:

1. Respaldo diario del export, si toca.
2. Reconciliacion, si hay silencio de webhooks o paso el intervalo.
3. Si no, la fila de salud.

## Casos borde

- **Fuera de orden y duplicados.** Se deduplica por `X-Olo-Message-Id` (en la misma transaccion que el efecto) y se aplica en orden de llegada. `X-Olo-Timestamp` es la hora de envio y no se usa para ordenar. Si un pos_id recibe dos deltas en menos de `OLO_FLAP_WINDOW_MS`, se programa una linea base de verificacion a los `OLO_FLAP_RECHECK_MS` (coalescida).
- **Dayparts.** `availability`, `times`, `startdate` y `enddate` son horarios programados, no 86, y nunca escriben in_stock.
- **Tienda offline o deshabilitada.** `VendorAvailabilityChanged` y `VendorTemporarilyDisabled` cambian `health.storeOnline` y nada mas. El menu no se marca agotado.
- **Alertas** (`console.error`, que dispara ALERT_WEBHOOK_URL):
  - una reconciliacion corrige mas de `OLO_RECONCILE_ALERT_ROWS` filas;
  - `OLO_RECONCILE_ALERT_CONSECUTIVE` reconciliaciones seguidas corrigen filas;
  - silencio de webhooks y la reconciliacion encuentra diferencias;
  - `eightysixeditems` falla (con pista si es 403).
