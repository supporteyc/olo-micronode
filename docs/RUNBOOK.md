# Runbook

## Antes de desplegar

- El receptor guarda dedup y outbox en `HOOK_DB_PATH` (bun:sqlite). **Tiene que estar en un volumen persistente.** En un contenedor sin volumen, cada deploy borra los eventos pendientes y la dedup.
- Un solo proceso del receptor por archivo sqlite. No escalarlo horizontalmente sin mover la outbox a otra base.
- `ec4olo-node` con `OLO_ENV=production` se niega a arrancar sin `DATABASE_URL`.

## El receptor esta caido

**Sintoma:** Olo recibe errores de conexion; `/healthz` no responde.

1. Olo reintenta hasta 50 veces en 24 horas. Si se levanta dentro de ese plazo, no se pierde nada.
2. Mientras tanto, el stock se sigue corrigiendo solo: cada tienda reconcilia con `eightysixeditems` cada `OLO_RECONCILE_INTERVAL_MS`, y el silencio de webhooks dispara una reconciliacion extra.
3. El OCB no se actualiza sin webhooks. Las ordenes viejas igual se retiran por TTL (`OCB_MAX_TTL_MIN`).
4. Al volver, revisar `GET /metrics`: `outbox.pendientes` y `outbox.edadMasViejoMs` tienen que bajar a cero.

## El node de una tienda esta caido

**Sintoma:** en `/metrics` del receptor crece `outbox.pendientesPorTienda.<tienda>`; alerta "Entrega a X fallo (intento 5)".

1. El receptor ya respondio 200 a Olo y guardo el evento: no hay apuro por Olo.
2. Levantar el node. La outbox entrega en orden, con backoff de hasta `HOOK_BACKOFF_MAX_MS`.
3. Al arrancar, el node importa y corre la linea base, asi que el stock queda bien aunque haya eventos viejos en cola.
4. Un `404` o `401` del node se reintenta (baseUrl o llave mal configurada). Solo `400` y `413` se descartan, con alerta.

## Webhook deshabilitado por Olo

**Sintoma:** `health.lastWebhookAt` viejo en todas las tiendas; alerta "Silencio de webhooks ... la reconciliacion encontro diferencias".

1. Olo deshabilita suscripciones con fallas sostenidas por varios dias.
2. Revisar en el Dashboard de Olo el estado de la suscripcion y re-habilitarla. Mandar el Test Event: tiene que dar 200.
3. Revisar `/metrics` del receptor: `firmasInvalidas` alto apunta a un secreto o una URL que no coinciden.
4. Mientras tanto, el stock se sostiene con las reconciliaciones. Para acelerar: `POST /api/toast/menu-export/reconcile` en cada tienda.

## eightysixeditems sin permiso (403)

**Sintoma:** alerta "No se pudo traer eightysixeditems ... 403"; `/api/status` en warn con `health.inventory: "error"`; `lastRun.inventory_guids` NULL.

1. No se toca ningun `in_stock`: se conserva el ultimo estado bueno, y los deltas por webhook siguen aplicandose.
2. Pedir a Olo el permiso especial para el ClientId.
3. Verificar con `GET /api/toast/eightysixed` y despues `POST /api/toast/menu-export/reconcile`.

## Ordenes pegadas en el board

**Sintoma:** una orden se ve mucho despues de recogida.

1. `GET /api/toast/ocb`: el GET corre el barrido, asi que lo vencido sale en esa misma llamada.
2. Si la tienda no usa Expo, nunca llega `OrderPickedUp`: configurar `OCB_HIDE_ON_CLOSED_AFTER_MIN`.
3. Toda orden sale como maximo a `OCB_MAX_TTL_MIN` desde que se mostro.
4. Revisar el estado interno en MySQL:
   ```sql
   SELECT order_guid, state, hide_at, expire_at FROM ocb_olo_state WHERE order_guid = '...';
   SELECT event_type, received_at FROM olo_webhook_events WHERE entity_key = '...' ORDER BY received_at;
   ```
5. Ultimo recurso: `DELETE FROM ocb_orders WHERE order_guid = '...'` (el estado queda; el barrido no la revive).

## Rotacion de secretos

**Secreto del webhook (por brand):**
1. Con varios brands o con una URL nueva, agregar el brand nuevo a `OLO_HOOK_BRANDS` junto al viejo. Cada uno tiene su URL `/olo/webhook/{key}`. Reiniciar el receptor.
2. Cambiar en el Dashboard de Olo el secreto (o la URL) y mandar el Test Event.
3. Cuando `/metrics` muestre que ya no llegan eventos firmados con el viejo, quitarlo.
4. Con un solo brand en la misma URL no hay solapamiento: hay que coordinar el cambio. Los eventos rechazados con 401 los reintenta Olo, y no se pierden si el cambio se completa en minutos.

**Client Secret de la Ordering API:** actualizar `OLO_CLIENT_SECRET` en cada tienda y reiniciar. Probar con `GET /api/toast/test-authentication`.

**SERVICE_TOKEN de una tienda:** cambiarlo en la tienda y en `OLO_HOOK_ROUTES` (`key`) a la vez. Entre los dos cambios el receptor recibe 401 y reintenta: no se pierden eventos.
