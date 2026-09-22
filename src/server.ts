import { Hono } from "hono"
import { serveStatic } from "hono/bun"
import { z } from "zod"
import { ejecutarTurno } from "./agent/ciclo.ts"
import { AlmacenSesiones } from "./agent/sesiones.ts"
import { crearAdaptador } from "./llm/index.ts"

const directory = process.cwd()
const config = {
  maxIteraciones: Number(process.env.MAX_ITERACIONES ?? 25),
  maxTokensSesion: Number(process.env.MAX_TOKENS_SESION ?? 300000),
}
const limiteTurnos = Number(process.env.RATE_LIMIT_TURNOS ?? 30)
const accessKey = process.env.ACCESS_KEY ?? ""

const llm = crearAdaptador()
const sesiones = new AlmacenSesiones(directory)
const app = new Hono()

// Límite de turnos por IP en ventana de 10 minutos: nadie gasta la clave sin tope.
const ventanas = new Map<string, number[]>()
function permitido(ip: string): boolean {
  const ahora = Date.now()
  const recientes = (ventanas.get(ip) ?? []).filter((t) => ahora - t < 10 * 60_000)
  if (recientes.length >= limiteTurnos) return false
  recientes.push(ahora)
  ventanas.set(ip, recientes)
  return true
}

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health" || c.req.path === "/api/config") return next()
  if (accessKey && c.req.header("x-access-key") !== accessKey) return c.json({ error: "Clave de acceso inválida" }, 401)
  return next()
})

app.get("/api/health", (c) => c.json({ ok: true, provider: llm.proveedor, model: llm.modelo }))
app.get("/api/config", (c) => c.json({ requiereClave: Boolean(accessKey), maxIteraciones: config.maxIteraciones }))

const ChatSchema = z.object({ sessionId: z.string().optional(), message: z.string().trim().min(1).max(4000) })

app.post("/api/chat", async (c) => {
  const cuerpo = ChatSchema.safeParse(await c.req.json().catch(() => null))
  if (!cuerpo.success) return c.json({ error: "Cuerpo inválido: se espera { sessionId?, message }" }, 400)
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local"
  if (!permitido(ip)) return c.json({ error: "Demasiados mensajes. Espera unos minutos." }, 429)

  const sesion = await sesiones.obtener(cuerpo.data.sessionId)
  if (!sesiones.bloquear(sesion.id)) return c.json({ error: "La sesión está procesando otro mensaje." }, 409)
  try {
    sesion.historial.push({ rol: "usuario", texto: cuerpo.data.message, ts: new Date().toISOString() })
    const turno = await ejecutarTurno(sesion, cuerpo.data.message, llm, directory, config)
    sesion.historial.push({ rol: "asistente", texto: turno.reply, toolCalls: turno.toolCalls, needsConfirmation: turno.needsConfirmation, error: turno.error, ts: new Date().toISOString() })
    await sesiones.guardar(sesion)
    return c.json({ sessionId: sesion.id, ...turno, tokensSesion: sesion.tokens })
  } finally {
    sesiones.liberar(sesion.id)
  }
})

app.get("/api/sessions/:id", async (c) => {
  const sesion = await sesiones.buscar(c.req.param("id"))
  if (!sesion) return c.json({ error: "Sesión no encontrada" }, 404)
  return c.json({ id: sesion.id, creada: sesion.creada, tokens: sesion.tokens, confirmacionPendiente: sesion.confirmacionPendiente, historial: sesion.historial })
})

app.use("/*", serveStatic({ root: "./web" }))

const port = Number(process.env.PORT ?? 3000)
console.log(`Agente OC escuchando en http://localhost:${port} · ${llm.proveedor}/${llm.modelo}`)
export default { port, fetch: app.fetch, idleTimeout: 255 }
