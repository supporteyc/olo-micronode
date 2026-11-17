# Fixtures de webhooks (SYNTHETIC)

Un JSON por evento que usa la integracion. Datos falsos: ids de 17 digitos a
proposito (superan Number.MAX_SAFE_INTEGER), nombres y correos de ejemplo
(`example.test`). Ningun valor sale de una tienda real ni de un .env.

La forma sigue los campos de la documentacion de Olo listados en el prompt
(seccion 5.2). Lo que la doc no fija (por ejemplo el formato exacto de
`pickUpDetails.timePickedUp` o de `totals`) es una suposicion marcada
[VALIDAR-CON-OLO] en docs/VALIDATION_CHECKLIST.md.

Se usan con la herramienta de replay:

    bun run replay fixtures/webhooks/OrderPlaced.json
