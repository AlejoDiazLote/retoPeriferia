import type { HerramientaSpec } from "../tools/registry.ts"
import { type Bloque, ErrorLlm, type LlmAdapter, type Mensaje, type Respuesta } from "./adapter.ts"

const PROVEEDOR = "google"
const URL_BASE = "https://generativelanguage.googleapis.com/v1beta/models"

type Parte = {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string }
  functionResponse?: { name: string; id?: string; response: Record<string, unknown> }
}

type Contenido = { role: "user" | "model"; parts: Parte[] }

type CuerpoError = { error?: { message?: string; status?: string } }
type RespuestaApi = CuerpoError & {
  candidates?: Array<{ content?: { parts?: Parte[] }; finishReason?: string }>
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }
  promptFeedback?: { blockReason?: string }
}

function esParte(dato: unknown): dato is Parte {
  return typeof dato === "object" && dato !== null
}

function objeto(valor: unknown): Record<string, unknown> {
  if (valor && typeof valor === "object" && !Array.isArray(valor)) return valor as Record<string, unknown>
  return {}
}

function comoObjeto(contenido: string): Record<string, unknown> {
  try {
    const valor = JSON.parse(contenido) as unknown
    return objeto(valor).resultado === undefined && (valor === null || typeof valor !== "object" || Array.isArray(valor))
      ? { resultado: valor }
      : objeto(valor)
  } catch {
    return { resultado: contenido }
  }
}

const CLAVES_GEMINI = new Set(["type", "format", "description", "nullable", "enum", "items", "properties", "required", "maxItems", "minItems", "maximum", "minimum"])

/** Gemini acepta un subconjunto de OpenAPI. Zod emite claves (`const`, `exclusiveMinimum`) que la API rechaza. La validación estricta sigue en el servidor. */
function esquemaGemini(valor: unknown): Record<string, unknown> {
  if (!valor || typeof valor !== "object" || Array.isArray(valor)) return { type: "object", properties: {} }
  const entrada = { ...(valor as Record<string, unknown>) }
  if ("const" in entrada && !Array.isArray(entrada.enum)) entrada.enum = [entrada.const]
  if (typeof entrada.exclusiveMinimum === "number" && typeof entrada.minimum !== "number") entrada.minimum = entrada.exclusiveMinimum
  if (typeof entrada.exclusiveMaximum === "number" && typeof entrada.maximum !== "number") entrada.maximum = entrada.exclusiveMaximum
  if (Array.isArray(entrada.anyOf) || Array.isArray(entrada.oneOf)) {
    const opciones = (entrada.anyOf ?? entrada.oneOf) as unknown[]
    const esquemas = opciones.map((opcion) => esquemaGemini(opcion))
    const noNulo = esquemas.find((opcion) => opcion.type !== "null")
    if (noNulo) Object.assign(entrada, noNulo, esquemas.some((opcion) => opcion.type === "null") ? { nullable: true } : {})
  }
  const salida: Record<string, unknown> = {}
  for (const [clave, item] of Object.entries(entrada)) {
    if (!CLAVES_GEMINI.has(clave)) continue
    if (clave === "properties" && item && typeof item === "object" && !Array.isArray(item)) {
      salida.properties = Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([k, v]) => [k, esquemaGemini(v)]))
    } else if (clave === "items") {
      salida.items = esquemaGemini(item)
    } else if (clave === "type" && Array.isArray(item)) {
      const tipos = item.filter((tipo) => tipo !== "null")
      salida.type = tipos[0] ?? "string"
      if (item.includes("null")) salida.nullable = true
    } else {
      salida[clave] = item
    }
  }
  if (!salida.type && salida.properties) salida.type = "object"
  return salida
}

function nombreDeLlamada(mensajes: Mensaje[], id: string): string {
  for (const mensaje of mensajes) {
    for (const bloque of mensaje.bloques) {
      if (bloque.tipo === "llamada" && bloque.id === id) return bloque.nombre
    }
  }
  return "herramienta"
}

function partesDe(mensaje: Mensaje, mensajes: Mensaje[]): Parte[] {
  if (mensaje.rol === "asistente") {
    const opacos = mensaje.bloques.flatMap((bloque): Parte[] =>
      bloque.tipo === "opaco" && bloque.proveedor === PROVEEDOR && esParte(bloque.dato) ? [bloque.dato] : [],
    )
    const idsEnOpaco = new Set(opacos.flatMap((parte) => parte.functionCall?.id ? [parte.functionCall.id] : []))
    const llamadas = mensaje.bloques.flatMap((bloque): Parte[] =>
      bloque.tipo === "llamada" && !idsEnOpaco.has(bloque.id)
        ? [{ functionCall: { name: bloque.nombre, args: objeto(bloque.argumentos), id: bloque.id } }]
        : [],
    )
    if (opacos.length) return [...opacos, ...llamadas]
    return mensaje.bloques.flatMap((bloque): Parte[] => {
      if (bloque.tipo === "texto") return [{ text: bloque.texto }]
      if (bloque.tipo === "llamada") return [{ functionCall: { name: bloque.nombre, args: objeto(bloque.argumentos), id: bloque.id } }]
      return []
    })
  }
  return mensaje.bloques.flatMap((bloque): Parte[] => {
    if (bloque.tipo === "texto") return [{ text: bloque.texto }]
    if (bloque.tipo === "resultado") {
      return [{ functionResponse: { name: nombreDeLlamada(mensajes, bloque.llamadaId), id: bloque.llamadaId, response: comoObjeto(bloque.contenido) } }]
    }
    return []
  })
}

function contenidos(mensajes: Mensaje[]): Contenido[] {
  const lista: Contenido[] = []
  for (const mensaje of mensajes) {
    const parts = partesDe(mensaje, mensajes)
    if (parts.length === 0) continue
    const role = mensaje.rol === "asistente" ? "model" : "user"
    const ultimo = lista.at(-1)
    if (ultimo?.role === role) ultimo.parts.push(...parts)
    else lista.push({ role, parts })
  }
  return lista
}

function dePartes(parts: Parte[]): Bloque[] {
  const bloques: Bloque[] = []
  for (const parte of parts) {
    if (parte.functionCall) {
      const id = parte.functionCall.id ?? crypto.randomUUID()
      const dato: Parte = { ...parte, functionCall: { ...parte.functionCall, id, args: parte.functionCall.args ?? {} } }
      bloques.push({ tipo: "opaco", proveedor: PROVEEDOR, dato })
      bloques.push({ tipo: "llamada", id, nombre: parte.functionCall.name, argumentos: parte.functionCall.args ?? {} })
    } else if (parte.thought) {
      bloques.push({ tipo: "opaco", proveedor: PROVEEDOR, dato: parte })
    } else if (typeof parte.text === "string") {
      if (parte.thoughtSignature) bloques.push({ tipo: "opaco", proveedor: PROVEEDOR, dato: parte })
      bloques.push({ tipo: "texto", texto: parte.text })
    } else {
      bloques.push({ tipo: "opaco", proveedor: PROVEEDOR, dato: parte })
    }
  }
  return bloques
}

function finDe(motivo: string | undefined, hayLlamadas: boolean): Respuesta["fin"] {
  if (hayLlamadas) return "herramientas"
  if (motivo === "MAX_TOKENS") return "limite"
  if (motivo === "SAFETY" || motivo === "RECITATION" || motivo === "BLOCKLIST" || motivo === "PROHIBITED_CONTENT") return "rechazo"
  return "turno"
}

function describirError(status: number, cuerpo: CuerpoError): string {
  const detalle = cuerpo.error?.message?.split("\n")[0]
  if (status === 401 || status === 403) return "La clave de Google no es válida o no está configurada en el servidor."
  if (status === 429) return "Gemini está limitando las solicitudes del plan gratuito. Espera un momento e intenta de nuevo."
  if (status === 503 || status === 500) return "Gemini está saturado en este momento. Intenta de nuevo."
  if (status === 404) return detalle ? `Gemini: ${detalle}` : "El modelo de Gemini configurado no existe. Revisa GOOGLE_MODEL."
  if (status === 400 && detalle) return `Gemini rechazó la solicitud: ${detalle}`
  return "No fue posible conectar con Gemini."
}

export class GoogleAdapter implements LlmAdapter {
  readonly proveedor = PROVEEDOR

  constructor(readonly modelo: string, private readonly timeoutMs: number) {}

  /** El razonamiento largo de Flash pasa de 90 s. En Lite no existe y la API lo rechaza. */
  private configuracion(): Record<string, unknown> {
    const config: Record<string, unknown> = { maxOutputTokens: 8000 }
    if (!this.modelo.includes("lite")) config.thinkingConfig = { thinkingBudget: 0 }
    return config
  }

  /** Reintenta si el plan gratuito responde saturado. La cuota diaria no se reintenta. */
  private async generar(clave: string, cuerpo: string): Promise<Response> {
    let respuesta: Response | undefined
    for (let intento = 0; intento < 3; intento++) {
      respuesta = await fetch(`${URL_BASE}/${encodeURIComponent(this.modelo)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": clave },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: cuerpo,
      })
      if (respuesta.ok || (respuesta.status !== 503 && respuesta.status !== 500 && respuesta.status !== 429)) return respuesta
      const texto = await respuesta.text()
      if (texto.includes("PerDay") || intento === 2) return new Response(texto, { status: respuesta.status, headers: { "content-type": "application/json" } })
      await new Promise((resolver) => setTimeout(resolver, 8000))
    }
    return respuesta as Response
  }

  async enviar(sistema: string, mensajes: Mensaje[], herramientas: HerramientaSpec[]): Promise<Respuesta> {
    const clave = process.env.GOOGLE_API_KEY
    if (!clave) throw new ErrorLlm("El servidor no tiene configurada la clave de Google (GOOGLE_API_KEY).")
    const cuerpoPeticion = JSON.stringify({
      systemInstruction: { parts: [{ text: sistema }] },
      contents: contenidos(mensajes),
      tools: [{ functionDeclarations: herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, parameters: esquemaGemini(h.esquema) })) }],
      generationConfig: this.configuracion(),
    })
    let respuestaHttp: Response
    try {
      respuestaHttp = await this.generar(clave, cuerpoPeticion)
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") throw new ErrorLlm("El modelo tardó demasiado en responder (timeout). Intenta de nuevo.")
      throw new ErrorLlm("No fue posible conectar con Gemini.")
    }
    const cuerpo = await respuestaHttp.json().catch(() => ({})) as RespuestaApi
    if (!respuestaHttp.ok) {
      console.error(`[llm] Google: ${respuestaHttp.status}`)
      throw new ErrorLlm(describirError(respuestaHttp.status, cuerpo))
    }
    if (cuerpo.promptFeedback?.blockReason) throw new ErrorLlm("Gemini declinó responder esta solicitud.")
    const candidato = cuerpo.candidates?.[0]
    const partes = candidato?.content?.parts ?? []
    const bloques = dePartes(partes)
    const uso = cuerpo.usageMetadata
    return {
      bloques,
      fin: finDe(candidato?.finishReason, bloques.some((b) => b.tipo === "llamada")),
      uso: {
        entrada: uso?.promptTokenCount ?? 0,
        salida: (uso?.candidatesTokenCount ?? 0) + (uso?.thoughtsTokenCount ?? 0),
      },
    }
  }
}
