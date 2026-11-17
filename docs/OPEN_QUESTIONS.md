# Preguntas abiertas

No se adivino nada de esto. Cada punto esta detras de una variable o una interfaz, con su tag en el codigo.

## [PEDIR-A-ANDRES]

| # | Pregunta | Donde | Valor actual |
| --- | --- | --- | --- |
| 1 | ¿El console acepta `side: "olo"`? | `STATUS_SIDE` | `toast` |
| 2 | ¿El console acepta `trigger_source: "webhook"`? | `OLO_WEBHOOK_TRIGGER_SOURCE` | `scheduler` |
| 3 | ¿El consumidor del OCB entiende `PICKED_UP` y `CANCELLED`? | `OCB_EXTENDED_STATUS` | `false` |
| 4 | Una orden recien pedida, ¿se muestra como `IN_PREPARATION` o `RECEIVED`? | `OCB_PLACED_STATUS` | `IN_PREPARATION` |
| 5 | ¿Las tiendas usan Expo (`OrderPickedUp`)? Si no, minutos desde `OrderClosed` hasta retirar | `OCB_HIDE_ON_CLOSED_AFTER_MIN` | vacio (con Expo) |
| 6 | XSD del Vendor Export, o un export real anonimizado | `vendorExport.parser.ts` | fixture SYNTHETIC |
| 7 | Categorias de MENU_CONFIG por tienda | `MENU_CONFIG` | - |
| 8 | ¿Cuantos niveles de modificadores anidados van a pantalla? | `OLO_MODIFIER_DEPTH` | 1 |
| 9 | ¿Como llega el receptor a cada tienda (red, DNS, TLS)? | `OLO_HOOK_ROUTES` | - |
| 10 | `payment_status`: ¿alcanza con "OPEN si se paga en tienda, si no PAID"? | `estadoDePago` | esa regla |
| 11 | ¿Que `deliveryMethod` van al board? | `OCB_DELIVERY_METHODS` | pickup, curbside, dinein |
| 12 | Si hace falta ocultar items fuera de horario (dayparts), es otro concepto distinto del 86 | - | no se implementa |
| 13 | Una orden con `ScheduledOrderFailed`: hoy queda SCHEDULED y el barrido la promueve igual. ¿Deberia no mostrarse? | `ocb.service.ts` | se promueve |
| 14 | `menu` de menu_items: hoy es el nombre del vendor del export. menu-export no lo expone. ¿Alguien lo lee? | `aplanarVendorExport` | nombre del vendor |

## [VALIDAR-CON-OLO]

Ver docs/VALIDATION_CHECKLIST.md.

## [ABIERTO]

| # | Pregunta | Como se cubre hoy |
| --- | --- | --- |
| 1 | Los restaurantes que se conecten, ¿comparten un brand en Olo (un webhook, un secreto) o son brands distintos? | El receptor soporta los dos (`OLO_WEBHOOK_*` u `OLO_HOOK_BRANDS`) |
| 2 | ¿Olo reintenta los 4xx distintos de 429? | Se responde 401 solo por firma invalida y 200 para todo lo demas |
| 3 | Senal de "orden lista": Olo no la documenta | No se inventa: READY sale de `OrderClosed` (por tiempo) |
| 4 | Precision de las horas: Olo manda minutos (`yyyymmdd hh:mm`) | Un retiro puede adelantarse hasta 59 s |
