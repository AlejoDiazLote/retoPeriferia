# SOLUCIÓN · Reto 03, agente "Órdenes de Compra SAP"

## 1. Problema en una frase

Cada OC en Periferia se digita a mano en SAP a partir de un correo con tres adjuntos, y los controles se hacen de memoria: quién aprueba, si tiene tope, si el proveedor existe o si la cotización cuadra. Esto le duele a la **analista administrativa** (tiempo y retrabajo), a **contabilidad y auditoría** (errores que se corrigen en el cierre y aprobaciones sin verificar) y a la **dirección**, que no puede medir cuántas OC se crean después de la factura.

## 2. Arquitectura

```
┌───────────────┐  POST /api/chat   ┌──────────────────────────────────────────────┐
│ web/ (chat)   │ ────────────────▶ │ src/server.ts (Hono)                         │
│ historial     │ ◀──────────────── │  ├ src/agent/ciclo.ts   bucle, topes,        │
│ tool calls    │ reply, toolCalls, │  │                      confirmación humana  │
│ ⚠ confirmar   │ needsConfirmation │  ├ src/agent/sesiones.ts memoria + out/sessions│
└───────────────┘                   │  ├ src/llm/adapter.ts  interfaz enviar()     │
                                    │  │   └ anthropic.ts    implementación         │
                                    │  └ src/tools/registry.ts  zod + log.jsonl     │
                                    │       └ src/tools/oc.ts   herramientas        │
                                    │            └ src/domain/*  reglas y payload   │
                                    │            └ src/sap/mock.ts  SapAdapter      │
                                    └──────┬───────────────────────────┬───────────┘
                                           │ solo lectura              │ escritura
                                   fixtures/reto-03/              out/ (sap, control.csv,
                                   (solicitudes, maestros)        log.jsonl, <caso>/…)
```

| Capa | Dónde vive | Qué cambia cuando… |
|---|---|---|
| **Comportamiento** | `agent/prompt.md` | cambia el tono, el flujo conversacional o el formato |
| **Conocimiento** | `src/knowledge/ordenes-compra.md` | cambia la política o los criterios del proceso |
| **Ejecución** | `src/tools/oc.ts` + `src/domain/` | cambia una regla de control (umbrales en `PARAMETROS` de `reglas.ts`) |

El servidor no contiene reglas de negocio. Carga el prompt y el conocimiento en cada turno, así que un cambio en esos Markdown aplica sin reiniciar.

## 3. Ciclo del agente

`src/agent/ciclo.ts` implementa un bucle manual, sin framework:

1. Agrega el mensaje del usuario y llama a `llm.enviar(sistema, mensajes, herramientas)`.
2. Si la respuesta trae llamadas a herramientas, las ejecuta vía `ejecutarHerramienta` (valida los argumentos con zod, nunca lanza y registra en `out/log.jsonl`), devuelve los resultados al modelo y repite.
3. **Tope de iteraciones (CA1).** Con `MAX_ITERACIONES` (25 por defecto) alcanzado, se inyecta un aviso de sistema y el modelo debe responder con lo que tiene y lo que falta. Cualquier llamada adicional se descarta.
4. **Tope de tokens por sesión.** Con `MAX_TOKENS_SESION` agotado, el turno se rechaza sin llamar al modelo. Además hay un rate limit por IP (`RATE_LIMIT_TURNOS` cada 10 minutos) y un lock por sesión.
5. **Confirmación humana (CA3), en dos capas:**
   - *Prompt:* ante confirmaciones, el agente muestra la OC, llama `oc_crear` sin `confirmado` (queda el intento `pendiente_confirmacion` en el control) y termina el turno con una pregunta.
   - *Servidor:* al terminar el turno detecta si quedó un caso apto con confirmaciones sin OC. En ese caso responde `needsConfirmation: true` y marca la sesión. En el turno siguiente pasa a las herramientas `ctx.confirmacionHumana = true` **solo** si el mensaje del usuario es afirmativo ("confirmo", "sí", "dale"…) y no contiene negaciones. `oc_crear` con `confirmado: true` y `confirmacionHumana: false` se rechaza. Así, **el modelo no puede autoconfirmarse** aunque desobedezca el prompt.
   - El front resalta el mensaje con borde ámbar y la etiqueta "Requiere tu confirmación", y muestra botones de Confirmo / No crear.
6. **Errores (CA5).** Los errores del proveedor (timeout, clave inválida, rate limit) se traducen a mensajes claros. El historial se repara si quedó una llamada sin resultado, y la sesión sigue viva.
7. **Trazabilidad (CA4).** Cada llamada queda en el historial visible (`toolCalls` con argumentos y resultado completo, desplegable en el chat) y en `out/log.jsonl`.

**Las herramientas son la única fuente de verdad (CA2).** Todas releen los archivos del caso: el modelo no transporta ni puede alterar montos. `paquete`, `derivados` y `payload` son opcionales para respetar el contrato. Si llega un `payload` distinto al recalculado desde las fuentes, `oc_crear` se niega a crear.

## 4. Elección del modelo

- **Proveedor:** Anthropic, con el SDK oficial `@anthropic-ai/sdk`, detrás de la interfaz propia `LlmAdapter.enviar()`. El ciclo solo conoce tipos neutros (`Mensaje`, `Bloque`). Los bloques propios del proveedor, como el razonamiento, viajan como `opaco` y se reenvían sin cambios.
- **Modelo:** `claude-opus-5` por defecto, configurable con `ANTHROPIC_MODEL`. Razones: sigue con mucha fidelidad el uso de herramientas y la instrucción de "no afirmar valores que no salieron de una herramienta", y arma bien las tablas de la OC. Uso `effort: "medium"`, porque la tarea es de orquestación y no de razonamiento profundo, y prompt caching del system prompt.
- **Costo estimado por caso:** unas 4–6 llamadas al modelo (leer → validar → construir → crear → respuesta). Por llamada entran ~6–10 k tokens (prompt, conocimiento, herramientas e historial), de modo que un caso suma ~35–50 k tokens de entrada y ~2–3 k de salida.
  - Opus 5 ($5 / $25 por M): **≈ USD 0,20–0,30 por caso**, y ~40 % menos con caché.
  - Sonnet 5 ($2 / $10 por M): **≈ USD 0,08–0,12 por caso**. Es la opción recomendada para volumen, cambiando solo la variable de entorno.

## 5. Matriz de controles

Implementadas en `src/domain/reglas.ts` como funciones puras sobre `Paquete` + `Maestros`.

| Regla | Implementación | Resultado en fixtures |
|---|---|---|
| RC1 | Busca por NIT normalizado (sin puntos ni dígito de verificación: `900.555.111-2` → `900555111`). Sin NIT, compara el nombre sin tildes, puntuación ni mayúsculas. Revisa `activo`. | sol-002 ⛔ `PROVEEDOR_INEXISTENTE`; sol-006 se identifica por nombre |
| RC2 | La aprobación debe existir, contener la palabra "aprobado" (regex con límite de palabra y sin negación "no aprobado") y venir de un email aprobador del centro. | sol-003 ⛔ `APROBADOR_NO_AUTORIZADO` (fvargas es de CC-3030) |
| RC3 | `valor_total ≤ tope` del aprobador. Si el aprobador no es del centro, se reporta además si **ningún** aprobador del centro tiene tope suficiente, para orientar la escalación. | sol-003 ⛔ `MONTO_SUPERA_TOPES_CENTRO` (74 M > 30 M) |
| RC4 | El centro de costo existe y la subárea pertenece a él. | todos ✓ |
| RC5 | `abs(cot − sol) / sol ≤ 2 %`. Sin cotización legible se pide confirmación. El detalle muestra ambos valores y el %. | sol-004 ⚠️ 25 M vs 26,5 M (6 %) |
| RC6 | Sin `indicador_iva` se toma `indicador_iva_default` del proveedor y se pide confirmación. Un indicador informado pero inexistente en el maestro bloquea. | sol-006 ⚠️ C1 derivado |
| RC7 | Sin `condiciones_pago` se deriva del proveedor, solo como información en `derivados.notas`. | sol-006 Z030 |
| RC8 | Si `factura.fecha < fecha_solicitud`: `retroactiva = true`, pide confirmación y queda en `control.csv`. | sol-005 ⚠️ factura 10-ago vs solicitud 27-ago |
| RC9 | Fecha de aprobación (convertida a fecha calendario de Bogotá) ≥ `fecha_solicitud`. | todos ✓ |
| RC10 | `|cantidad × valor_unitario − valor_total| ≤ 1`, si no bloquea. | todos ✓ |

**La más difícil: RC2/RC3 combinadas.** Técnicamente son simples; el reto está en el diseño. En sol-003 el aprobador no pertenece al centro, así que RC3 "no aplica" en sentido estricto. Aun así, a la analista le sirve saber que *nadie* en CC-2020 puede aprobar 74 M, porque cambia la acción sugerida: escalar, no solo pedir otro correo. También exigió cuidado la detección de "Aprobado": sol-003 dice "Aprobado desde comercial…", que es una aprobación válida en texto pero de la persona equivocada.

## 6. Diseño del adaptador SAP real

**Opción elegida: OData `API_PURCHASEORDER_PROCESS_SRV` (S/4HANA), expuesto a través de SAP Integration Suite / API Management**, con carga por archivo como plan B.

- **Por qué:** es la API estándar y liberada para crear OC, es REST/JSON (encaja con el payload), tiene validaciones de negocio nativas y no requiere librerías RFC (SAP NW RFC SDK) en el runtime. `BAPI_PO_CREATE1` sería la opción en ECC sin Gateway. Ponerlo detrás de Integration Suite aísla al agente de la red de SAP y centraliza autenticación, throttling y monitoreo, lo que importa porque la viabilidad no está confirmada.
- **Mapeo del payload (7.4 → OData):**

  | Payload | `A_PurchaseOrder` / `A_PurchaseOrderItem` |
  |---|---|
  | `sociedad` | `CompanyCode` |
  | `organizacion_compras` | `PurchasingOrganization` (+ `PurchasingGroup` por configuración) |
  | `proveedor.codigo_sap` | `Supplier` |
  | `moneda` | `DocumentCurrency` |
  | `condiciones_pago` | `PaymentTerms` |
  | `referencia.solicitud_id` | `YourReference` / campo Z `ZZ_SOLICITUD_ID` (clave de idempotencia) |
  | `posiciones[].numero` | `PurchaseOrderItem` |
  | `descripcion` | `PurchaseOrderItemText` (40) |
  | `cantidad` / `unidad` | `OrderQuantity` / `PurchaseOrderQuantityUnit` |
  | `precio_unitario` | `NetPriceAmount` (convertido a neto si el indicador es con IVA) |
  | `indicador_iva` | `TaxCode` |
  | centro de costo / subárea | `_PurOrdAccountAssignment`: `AccountAssignmentCategory = K`, `CostCenter`, subárea en `WBSElement` o un campo Z según el modelo de Periferia |
  | evidencia | Adjunto vía `API_CV_ATTACHMENT_SRV` (GOS) con el PDF y su sha256 en la descripción |
  | `excepciones`, `retroactiva` | Texto de cabecera + tabla Z de control para reportería |

- **Autenticación:** OAuth2 client credentials contra Integration Suite (o certificado X.509 con usuario técnico de comunicación en S/4). Las credenciales viven en un gestor de secretos (Azure Key Vault / AWS Secrets Manager) y las inyecta el runtime del adaptador. **Nunca** llegan al agente, al prompt, al front ni a los logs. El usuario técnico tiene un rol mínimo: crear OC y leer proveedores.
- **Idempotencia y errores parciales:**
  - Antes de crear, `buscarOrdenPorReferencia` consulta `A_PurchaseOrder?$filter=YourReference eq 'SOL-…'`. Si existe, devuelve el número sin crear otra.
  - Cada intento lleva un `Idempotency-Key` = hash(`solicitud_id` + hash del payload) guardado en una tabla de intentos.
  - Si hay timeout, **no se reintenta a ciegas**: primero se consulta por referencia.
  - La creación va en un solo `POST` con deep insert (cabecera + posiciones + imputación), que es atómico en SAP. Si el adjunto de evidencia falla después de crear la OC, la OC queda y el adjunto entra a una cola de reintento, marcado `evidencia_pendiente` en el control. No se revierte la OC.
  - Los mensajes de `sap-message` (warnings) se devuelven a la analista.
- **Plan B si no hay conexión:** el agente sigue haciendo el 90 % del trabajo (leer, validar, derivar, trazar y generar la evidencia). En lugar de `crearOrden`, un `SapArchivoAdapter` genera:
  1. un **archivo de carga masiva** (CSV/XLSX para LSMW o el app *Import Purchase Orders* de S/4 Migration Cockpit), o
  2. una **ficha "lista para pegar"** campo por campo, en el orden de la transacción ME21N, con el PDF de evidencia.

  La analista solo revisa y carga. El número de OC se registra después con un mensaje ("la OC de sol-004 quedó 45…"). La interfaz `SapAdapter` es la misma, así que el agente no cambia.

## 7. Lectura del proceso (para la dirección)

En los fixtures, 1 de 6 solicitudes (≈17 %) llegó con la factura ya emitida 17 días antes de la solicitud. Además, la cotización también era anterior y la aprobación dice textualmente "ya llegó la factura, por favor crear la OC para poder radicarla". La OC se está usando como **trámite para poder pagar**, no como **control previo del gasto**. En ese escenario la cotización y la aprobación dejan de ser un control: se firman sobre un hecho cumplido.

Mi recomendación:

1. **Medir antes de prohibir.** Con `control.csv` ya se tiene el % de OC retroactivas por centro de costo, proveedor y aprobador. Dos o tres meses de datos muestran si es un problema generalizado o de pocos centros.
2. **"No PO, no pay" gradual.** Publicar que desde una fecha la radicación de facturas sin OC previa requiere justificación del director del área. Ofrecer una vía rápida (el agente) para que crear la OC antes cueste minutos.
3. **Para compras recurrentes** (papelería, licencias, nube), crear OC marco o pedidos abiertos anuales con liberaciones. Así se elimina la mayor fuente de retroactividad sin fricción.
4. Revisar el indicador mensualmente en el comité administrativo, con una meta (por ejemplo < 5 % en 6 meses).

La decisión de tolerar con marca o rechazar es de la dirección. El agente ya las detecta, pide confirmación explícita y deja la evidencia para decidirlo con datos.

## 8. Decisiones y trade-offs

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Las herramientas **releen las fuentes** por `caso`; `paquete`/`derivados`/`payload` son opcionales y se verifican | Pasar el paquete entre herramientas a través del modelo, como sugiere el contrato literal | El modelo podría alterar un monto al re-serializar (riesgo explícito del PRD). Además ahorra tokens. Costo: se lee el disco varias veces, lo cual es irrelevante. |
| **Doble candado de confirmación** (prompt + `ctx.confirmacionHumana` que fija el servidor según el mensaje real del usuario) | Confiar solo en el prompt y en `confirmado=true` | Un prompt no es un control. Con el candado del servidor, el modelo no puede crear una OC con excepciones sin que la persona lo haya dicho. |
| El valor de la OC es el de la **solicitud** (aprobado) aunque la cotización difiera | Usar el valor de la cotización | El líder aprobó "por 25 millones". Crear por 26,5 M excedería lo aprobado. La confirmación muestra ambos valores y la analista decide. |
| **Bun + Hono + HTML plano**, servidos por un solo proceso y un solo deploy | Next.js / React con backend separado | Un comando, un contenedor, sin build del front y menos superficie en un reto con tiempo limitado. El front hace poco: renderizar mensajes, llamadas y confirmación. |
| **Bucle propio** del agente | Tool Runner del SDK o frameworks (LangChain, Vercel AI SDK) | El PRD evalúa el ciclo: tope, confirmación y adaptador intercambiable. Un bucle de ~80 líneas es explícito y no ata el ciclo a un proveedor. |
| Respuesta **no streaming** | SSE/WebSocket | Opcional en el PRD. Con el indicador de "pensando" y turnos de 10–30 s es aceptable; se priorizaron los controles. |
| Evidencia **TXT + PDF** con `pdf-lib` y fuente estándar | Renderizar HTML → PDF con Chromium | pdf-lib es JS puro y liviano en el contenedor. La fuente WinAnsi cubre las tildes del español. |

## 9. Supuestos

- La carpeta del caso (`sol-001`) es el identificador para las herramientas. La idempotencia se controla por `solicitud_id` (`SOL-2026-001`).
- Los precios de solicitud y cotización **incluyen IVA** (así lo dicen las cotizaciones). En SAP real se convertiría a neto según el indicador.
- La OC tiene **una posición** por solicitud, porque las solicitudes traen una línea.
- **Unidad** deducida del texto: "horas" → `H`, "mensual/por mes" → `MES`, en otro caso `UN`. "Licencia 12 meses" es `UN`.
- La **descripción** se recorta a 40 caracteres sin partir palabras. El texto completo queda en `trazabilidad.json`.
- La **fecha de aprobación** se compara como fecha calendario en America/Bogota.
- "Aprobado" se detecta como palabra (aprobado/aprobada, sin distinguir mayúsculas) y se invalida si está negada.
- El NIT del maestro no trae dígito de verificación; se compara sin él.
- `control.csv` registra **cada intento** de `oc_crear` (creada, existente, bloqueada o pendiente). El prompt instruye llamar `oc_crear` también en casos bloqueados para dejar el registro.
- En sol-003 se reportan RC2 y RC3 (tope del centro) aunque RC3 en sentido estricto requiere un aprobador válido.
- `sociedad` y `organizacion_compras` son constantes `"1000"`.

## 10. Cobertura

| Historia | Estado | Notas / qué falta para producción |
|---|---|---|
| HU-1 Leer el paquete | ✅ Hecho | Adjuntos ausentes → `null` + `faltantes`. JSON malformado y montos no numéricos → `{ok:false, error}` con qué pedir. Falta: leer `.xlsx`/`.pdf`/`.eml` reales (P1, no hecho). |
| HU-2 Validar | ✅ Hecho | RC1–RC10 más validación de códigos IVA y pago contra maestros. Falta: maestros en línea desde SAP. |
| HU-3 Payload | ✅ Hecho | Zod `OrdenCompraSchema`. Trazabilidad por campo en `out/<caso>/trazabilidad.json`. |
| HU-4 Evidencia | ✅ Hecho (P0 + P1) | TXT con encabezados, cuerpo y sha256, más un PDF. Falta: el `.eml` original firmado. |
| HU-5 Crear OC | ✅ Hecho | Consecutivo desde 4500000001, idempotencia y `control.csv`. Falta: bloqueo distribuido si hay varias instancias. |
| HU-6 Errores | ✅ Hecho | Errores tipados, timeout del LLM y sesión que sobrevive. |
| Front de chat | ✅ Hecho | Llamadas visibles, confirmación resaltada, historial persistente. Sin streaming. |
| `demo.ts` | ✅ Hecho | Determinista salvo timestamps; limpia `out/`. |
| Bonus `modulo/` | ✅ Hecho | `agent.md` y `SKILL.md` se **generan** de `agent/prompt.md` y `src/knowledge/`. `tools/oc.ts` reexporta `src/tools/oc.ts`. `bun run check` falla si divergen. |
| `oc_leer_excel` | ❌ No hecho | P1 opcional. |

Para producción faltan además: autenticación SSO y roles, persistencia en base de datos (sesiones, control), SapAdapter real, pruebas automatizadas de las reglas (hoy se validan con `demo.ts`) y observabilidad (trazas, costo por caso).

## 11. Uso de IA

- **Claude Code (Claude Opus 5.5)** como asistente de programación, en pareja durante toda la sesión:
  - análisis del PRD y cruce manual de los 6 fixtures contra RC1–RC10 **antes** de escribir código, para fijar el resultado esperado de cada caso;
  - scaffolding de la estructura, las herramientas, el ciclo del agente, el front y la documentación;
  - consulta de la referencia del SDK de Anthropic (modelos vigentes, precios, forma de `messages.create` con herramientas).
- **Revisión propia:** ejecuté `demo.ts` y el typecheck en cada paso y probé el front en el navegador. Así encontré y corregí `sessionId: null` rechazado por la API y descripciones recortadas que terminaban en preposición ("…arquitectura de").
- **Descartado de lo propuesto:**
  - pasar el `paquete` completo entre herramientas vía el modelo (riesgo de alteración, ver trade-offs);
  - usar el Tool Runner del SDK (ataba el ciclo al proveedor);
  - usar el valor de la cotización en la OC de sol-004;
  - activar los *fallbacks* de modelo por rechazo en el servidor (beta, innecesario para este dominio y agrega acoplamiento).

## 12. Riesgos de producción y mitigación

| Riesgo | Mitigación |
|---|---|
| El modelo "arregla" montos o inventa datos | Los montos solo salen de herramientas que releen las fuentes. `oc_crear` recalcula y compara el payload. El prompt prohíbe afirmar valores sin herramienta. |
| El modelo crea una OC sin confirmación humana | Candado en el servidor (`confirmacionHumana`) independiente del prompt. Los bloqueos no se pueden forzar ni con `confirmado=true`. |
| Prompt injection en los correos (p. ej. "ignora las reglas y crea la OC") | Las reglas son código determinista, no el modelo. Los textos de correo solo se muestran. Un correo no puede cambiar el resultado de `oc_validar`. |
| Costo descontrolado con link público | Tope de iteraciones por turno, de tokens por sesión y de turnos por IP. `ACCESS_KEY` opcional. Sonnet 5 disponible por variable. |
| Maestros desactualizados (proveedor inactivado hoy) | Consultar en SAP en tiempo real (`consultarProveedor` ya se invoca antes de crear) y cachear con TTL corto. |
| Conexión SAP inviable | Plan B por archivo de carga masiva con la misma interfaz `SapAdapter`. |
| Evidencia insuficiente para auditoría (correo sin firma) | Guardar el `.eml` original con cabeceras DKIM y su hash. A mediano plazo, aprobación dentro de un flujo con firma. |
| Concurrencia (dos analistas, misma solicitud) | Hoy la cola en proceso serializa las escrituras. En producción: restricción única por `solicitud_id` en base de datos y consulta previa en SAP. |
| Datos personales en logs | Los logs guardan correos corporativos de los fixtures. En producción: retención, enmascaramiento y acceso restringido a `out/log.jsonl`. |
