import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { type Bloque, ErrorLlm, type LlmAdapter, type Mensaje } from "../llm/adapter.ts"
import { ejecutarHerramienta, especificaciones } from "../tools/registry.ts"
import type { Sesion, ToolCallVista } from "./sesiones.ts"

export type ConfigCiclo = { maxIteraciones: number; maxTokensSesion: number }

export type ResultadoTurno = { reply: string; toolCalls: ToolCallVista[]; needsConfirmation: boolean; error?: string }

/** Comportamiento (agent/prompt.md) + conocimiento del proceso (src/knowledge/*.md). */
export async function cargarSistema(directory: string): Promise<string> {
  const [prompt, conocimiento] = await Promise.all([
    readFile(join(directory, "agent", "prompt.md"), "utf8"),
    readFile(join(directory, "src", "knowledge", "ordenes-compra.md"), "utf8"),
  ])
  return `${prompt.trim()}\n\n---\n\n# Conocimiento del proceso\n\n${conocimiento.trim()}\n`
}

const AFIRMATIVO = /^\s*(s[ií]|confirmo|confirmado|confirmada|dale|ok|okay|procede|proceder|adelante|de acuerdo|hazlo|cr[eé]ala|cr[eé]alas|listo|autorizo)\b/i
const NEGATIVO = /\b(no|cancela|espera|detente)\b/i

export function esConfirmacion(mensaje: string): boolean {
  return AFIRMATIVO.test(mensaje) && !NEGATIVO.test(mensaje.replace(/^\s*s[ií],?/i, ""))
}

type DatosHerramienta = { ok: boolean; error?: string; resultado?: string; data?: { apta?: boolean; confirmaciones?: unknown[]; numero_oc?: string } }

function resumir(nombre: string, r: DatosHerramienta): string {
  if (!r.ok) return `✗ ${r.error ?? "error"}`
  const d = r.data ?? {}
  if (nombre === "oc_validar") return `apta=${String(d.apta)} · ${(d.confirmaciones ?? []).length} confirmación(es)`
  if (nombre === "oc_crear") return `OC ${d.numero_oc ?? "?"}`
  return "✓ ok"
}

function textoDe(bloques: Bloque[]): string {
  return bloques.flatMap((b) => (b.tipo === "texto" ? [b.texto] : [])).join("\n").trim()
}

async function ejecutarLlamadas(sesion: Sesion, directory: string, llamadas: Extract<Bloque, { tipo: "llamada" }>[], confirmacionHumana: boolean, vistas: ToolCallVista[]): Promise<Bloque[]> {
  const resultados: Bloque[] = []
  for (const llamada of llamadas) {
    const contenido = await ejecutarHerramienta(llamada.nombre, llamada.argumentos, { directory, sessionId: sesion.id, confirmacionHumana })
    const parseado = JSON.parse(contenido) as DatosHerramienta
    vistas.push({ nombre: llamada.nombre, argumentos: llamada.argumentos, ok: parseado.ok, resumen: resumir(llamada.nombre, parseado), resultado: parseado })
    resultados.push({ tipo: "resultado", llamadaId: llamada.id, contenido, esError: !parseado.ok })
  }
  return resultados
}

/** Hay confirmación pendiente si en el turno algún caso quedó apto con confirmaciones y no se creó la OC. */
function quedaPendiente(vistas: ToolCallVista[]): boolean {
  const pendientes = new Set<string>()
  for (const v of vistas) {
    const caso = (v.argumentos as { caso?: string } | null)?.caso ?? ""
    const r = v.resultado as DatosHerramienta
    if (v.nombre === "oc_validar" && r.ok && r.data?.apta && (r.data.confirmaciones ?? []).length > 0) pendientes.add(caso)
    if (v.nombre === "oc_crear" && !r.ok && r.resultado === "pendiente_confirmacion") pendientes.add(caso)
    if (v.nombre === "oc_crear" && r.ok) pendientes.delete(caso)
  }
  return pendientes.size > 0
}

export async function ejecutarTurno(sesion: Sesion, mensaje: string, llm: LlmAdapter, directory: string, config: ConfigCiclo): Promise<ResultadoTurno> {
  if (sesion.tokens >= config.maxTokensSesion) {
    return { reply: `Esta sesión alcanzó el tope de ${config.maxTokensSesion.toLocaleString("es-CO")} tokens. Abre una sesión nueva para continuar.`, toolCalls: [], needsConfirmation: false, error: "tope_tokens" }
  }
  const confirmacionHumana = sesion.confirmacionPendiente && esConfirmacion(mensaje)
  const sistema = await cargarSistema(directory)
  const herramientas = especificaciones()
  const vistas: ToolCallVista[] = []
  sesion.mensajes.push({ rol: "usuario", bloques: [{ tipo: "texto", texto: mensaje }] })

  let reply = ""
  let error: string | undefined
  try {
    for (let iteracion = 0; ; iteracion++) {
      const topeAlcanzado = iteracion >= config.maxIteraciones
      if (topeAlcanzado) agregarAvisoTope(sesion.mensajes, config.maxIteraciones)
      const respuesta = await llm.enviar(sistema, sesion.mensajes, herramientas)
      sesion.tokens += respuesta.uso.entrada + respuesta.uso.salida
      const llamadas = respuesta.bloques.filter((b): b is Extract<Bloque, { tipo: "llamada" }> => b.tipo === "llamada")
      if (topeAlcanzado || respuesta.fin !== "herramientas" || llamadas.length === 0) {
        const finales = respuesta.bloques.filter((b) => b.tipo !== "llamada")
        sesion.mensajes.push({ rol: "asistente", bloques: finales.length ? finales : [{ tipo: "texto", texto: "(sin respuesta)" }] })
        reply = textoDe(finales) || (respuesta.fin === "rechazo" ? "El modelo declinó responder esta solicitud." : "No obtuve respuesta del modelo.")
        break
      }
      sesion.mensajes.push({ rol: "asistente", bloques: respuesta.bloques })
      sesion.mensajes.push({ rol: "usuario", bloques: await ejecutarLlamadas(sesion, directory, llamadas, confirmacionHumana, vistas) })
    }
  } catch (e) {
    error = e instanceof ErrorLlm ? e.message : `Error interno: ${e instanceof Error ? e.message : String(e)}`
    reply = `⚠️ ${error} La sesión sigue activa; puedes reintentar.`
    repararHistorial(sesion.mensajes)
  }
  const needsConfirmation = !error && quedaPendiente(vistas)
  sesion.confirmacionPendiente = needsConfirmation || (Boolean(error) && sesion.confirmacionPendiente)
  return { reply, toolCalls: vistas, needsConfirmation, error }
}

function agregarAvisoTope(mensajes: Mensaje[], tope: number): void {
  const ultimo = mensajes.at(-1)
  const aviso: Bloque = { tipo: "texto", texto: `[Sistema] Se alcanzó el tope de ${tope} iteraciones de este turno. No llames más herramientas: responde con lo que ya tienes y lo que falta.` }
  if (ultimo?.rol === "usuario") ultimo.bloques.push(aviso)
  else mensajes.push({ rol: "usuario", bloques: [aviso] })
}

/** Si el turno falló a mitad, deja el historial en un estado válido (sin llamadas sin resultado). */
function repararHistorial(mensajes: Mensaje[]): void {
  const ultimo = mensajes.at(-1)
  if (ultimo?.rol === "asistente" && ultimo.bloques.some((b) => b.tipo === "llamada")) mensajes.pop()
}
