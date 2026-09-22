# Reto 03 · Agente conversacional "Órdenes de Compra SAP"

Agente que lee el paquete de una solicitud de compra (correo, solicitud, cotización, aprobación y factura), lo valida contra los maestros (reglas RC1–RC10), construye la OC con trazabilidad, genera la evidencia de aprobación (TXT + PDF con sha256) y la crea en un SAP simulado, pidiendo confirmación humana para las excepciones.

- **Link de prueba:** _ver sección Despliegue_ (`https://<servicio>.up.railway.app`)
- **Clave de acceso:** no requerida por defecto. Si se define `ACCESS_KEY`, el front la pide al primer mensaje.

## Requisitos

- [Bun](https://bun.sh) ≥ 1.1 (o `npm i -g bun`)
- Una clave de Anthropic **solo** para el chat. `demo.ts` no necesita ninguna.

## Levantar en local (un comando)

```bash
cp .env.example .env        # y pon tu ANTHROPIC_API_KEY
bun install && bun run dev  # front + backend en http://localhost:3000
```

Con Docker: `docker build -t agente-oc . && docker run -p 3000:3000 --env-file .env agente-oc`.

## Verificación sin modelo

```bash
bun install && bun run demo.ts
```

Limpia `out/`, procesa los 6 casos llamando directamente a las herramientas e imprime por caso `apta`, bloqueos, confirmaciones, `retroactiva` y número de OC o motivo. Además muestra la idempotencia (sol-001 dos veces), las confirmaciones explícitas (sol-004, sol-005, sol-006) y que un caso bloqueado no se puede forzar.

`bun run check` corre el typecheck, verifica que `modulo/` esté sincronizado y ejecuta la demo.

## Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `ANTHROPIC_API_KEY` | Para el chat | Clave del modelo. Solo vive en el backend. |
| `ANTHROPIC_MODEL` | No | Por defecto `claude-opus-5`. Opción económica: `claude-sonnet-5`. |
| `PORT` | No | Puerto HTTP (por defecto 3000). |
| `MAX_ITERACIONES` | No | Tope de ciclos modelo → herramientas por turno (por defecto 25). |
| `MAX_TOKENS_SESION` | No | Tope de tokens por sesión (por defecto 300000). |
| `LLM_TIMEOUT_MS` | No | Timeout por llamada al modelo (por defecto 90000). |
| `RATE_LIMIT_TURNOS` | No | Turnos por IP cada 10 minutos (por defecto 30). |
| `ACCESS_KEY` | No | Si se define, la API exige el header `x-access-key`. |

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId?, message }` → `{ sessionId, reply, toolCalls[], needsConfirmation, error?, tokensSesion }` |
| `GET` | `/api/sessions/:id` | Historial visible completo de la sesión (mensajes y llamadas a herramientas) |
| `GET` | `/api/health` | `{ ok: true, provider, model }`, sin claves |

Cada elemento de `toolCalls` es `{ nombre, argumentos, ok, resumen, resultado }`.

## Estructura

```
agent/prompt.md                 comportamiento (system prompt)
src/knowledge/ordenes-compra.md conocimiento del proceso
src/tools/oc.ts                 herramientas (oc_leer_paquete, oc_validar, oc_construir_payload, oc_generar_evidencia, oc_crear, oc_listar_casos)
src/tools/registry.ts           nombres <archivo>_<export>, validación zod, log en out/log.jsonl
src/domain/                     reglas RC1–RC10, parseo, payload, evidencia, control.csv (lógica pura)
src/sap/adapter.ts · mock.ts    interfaz SapAdapter y SAP simulado sobre out/sap/
src/llm/adapter.ts · anthropic.ts  interfaz propia del proveedor LLM e implementación Anthropic
src/agent/ciclo.ts · sesiones.ts   ciclo del agente, tope de iteraciones/tokens, confirmación humana, sesiones
src/server.ts                   API HTTP (Hono) y front estático
web/                            front de chat (HTML + JS plano)
modulo/                         agente empaquetado (bonus), generado desde las mismas fuentes
demo.ts                         verificación sin modelo
```

## Salidas (`out/`)

- `out/sap/ordenes.jsonl`: OC creadas (consecutivo desde 4500000001)
- `out/control.csv`: una fila por intento: `solicitud_id, resultado, numero_oc, retroactiva, bloqueos, confirmaciones, ts`
- `out/<caso>/aprobacion.txt|pdf`, `payload.json`, `trazabilidad.json`
- `out/log.jsonl`: cada llamada a herramienta. `out/sessions/`: sesiones del chat

## Despliegue (Railway)

El repositorio incluye `Dockerfile` y `railway.json` (healthcheck en `/api/health`).

1. Railway → New Project → Deploy from GitHub repo (o `railway up` con la CLI).
2. Variables: `ANTHROPIC_API_KEY` (y opcionalmente `ACCESS_KEY` y `ANTHROPIC_MODEL`).
3. Settings → Networking → Generate Domain.
