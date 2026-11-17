# Checklist de validacion con Olo

Para cuando Olo entregue credenciales de Sandbox. Cada punto esta marcado `[VALIDAR-CON-OLO]` en el codigo.

## Firmas

- [ ] **X-Olo-Signature** con un Test Event real: el orden `url + LF + body + LF + messageId + LF + timestamp` sale del sample oficial de Node y reproduce su vector, pero no esta en la documentacion. (`oloWebhook.service.ts`)
- [ ] La `url` firmada es exactamente la Destination URL del Dashboard (barra final, mayusculas, puerto). (`OLO_WEBHOOK_URL`)
- [ ] **Signature Authorization** de la Ordering API en Sandbox: ¿el path firmado incluye `/v1.1/`? (`OLO_SIGN_PATH_WITH_VERSION`, hoy `true` como la coleccion Postman). Probar con `GET /api/toast/test-authentication`.
- [ ] Formato del header `Date` (RFC1123 GMT) y tolerancia de +/- 5 minutos.
- [ ] Headers obligatorios para integraciones de solo lectura (`User-Agent`, `Accept`). (`cabecerasFirmadas`)

## eightysixeditems

- [ ] El permiso especial esta otorgado: 200 y no 403. (`GET /api/toast/eightysixed`)
- [ ] **La lista es exhaustiva**: devuelve TODOS los 86 del restaurante, sin paginar. Si no lo es, la regla "fuera del conjunto = en stock" devolveria items a stock por error. (`fusionarOchentaYSeis`)
- [ ] Frecuencia permitida y rate limits: ajustar `OLO_RECONCILE_INTERVAL_MS` (hoy 10 min).
- [ ] Respuesta ante 429: ¿trae `Retry-After`? (el cliente lo respeta si viene)

## Ids

- [ ] Los ids de producto y opcion del XML del Vendor Export son los mismos que `eightysixeditems.products[].id` / `choices[].id` y que `itemEntityId` del webhook.
- [ ] Significado de `itemExternalReference` (hoy no se usa).
- [ ] `replacementDetails.originalId`: ¿es el `Order.id` (uuid) o el `orderId` numerico? Hoy se buscan los dos.

## Vendor Export

- [ ] Estructura del XML contra el XSD: nombres de elementos y atributos, donde viven `pricing` y `handoffmode`, como se anidan los optiongroups. (`vendorExport.parser.ts`)
- [ ] `vendorexport/xml` responde 301 con `Location` a una URL firmada que entrega un zip con un solo XML.
- [ ] Imagenes en el export (hoy no se usan).
- [ ] `VendorMenuExportComplete` llega por vendor y con `hasMenuChanges` confiable.

## Webhooks

- [ ] Un reintento de Olo conserva el `X-Olo-Message-Id` (la dedup depende de eso).
- [ ] ¿Se reintentan los 4xx distintos de 429?
- [ ] `X-Olo-Timestamp`: ticks de .NET en UTC (solo informativo, no se usa para ordenar).
- [ ] Forma de `MenuItemAvailabilityChanged`: array; ¿puede mezclar locations de un brand?

## OCB

- [ ] Campo del numero visible para el cliente: ¿`posRef`, los ultimos digitos de `orderIdString`, otro? (`OCB_DISPLAY_NUMBER_SOURCE`)
- [ ] Comportamiento de `ScheduledOrderFired` y de `OrderClosed` frente a `OrderPickedUp`: orden y tiempos reales.
- [ ] Formato de `pickUpDetails.timePickedUp`, `timeCancelled`, `arrivalDetails.timeArrived` (se asume `yyyymmdd hh:mm` local, con ISO como respaldo).
- [ ] Donde viene el total: `totals.total` (se asume) o `total`.
- [ ] Valores de `deliveryMethod` y de `payments[].type` (se asume `instore` para pago en tienda).

## Como probar cada punto

1. `.env` con `OLO_ENV=sandbox`, credenciales de Sandbox y `OLO_VENDOR_ID` del restaurante de prueba.
2. `GET /api/toast/test-authentication`: valida la firma de la Ordering API.
3. `GET /api/toast/vendor-export-status` y `POST /api/toast/menu-export/sync`: validan el export y el parser.
4. `GET /api/toast/eightysixed`: valida el permiso y la forma.
5. Registrar la Destination URL del receptor en el Dashboard y mandar el Test Event: valida X-Olo-Signature.
