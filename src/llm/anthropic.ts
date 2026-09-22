import Anthropic from "@anthropic-ai/sdk"
import type { HerramientaSpec } from "../tools/registry.ts"
import { type Bloque, ErrorLlm, type LlmAdapter, type Mensaje, type Respuesta } from "./adapter.ts"

const PROVEEDOR = "anthropic"

function aContenido(bloque: Bloque): Anthropic.ContentBlockParam {
  switch (bloque.tipo) {
    case "texto":
      return { type: "text", text: bloque.texto }
    case "llamada":
      return { type: "tool_use", id: bloque.id, name: bloque.nombre, input: bloque.argumentos }
    case "resultado":
      return { type: "tool_result", tool_use_id: bloque.llamadaId, content: bloque.contenido, is_error: bloque.esError }
    case "opaco":
      return bloque.dato as Anthropic.ContentBlockParam
  }
}

function deContenido(bloque: Anthropic.ContentBlock): Bloque {
  if (bloque.type === "text") return { tipo: "texto", texto: bloque.text }
  if (bloque.type === "tool_use") return { tipo: "llamada", id: bloque.id, nombre: bloque.name, argumentos: bloque.input }
  return { tipo: "opaco", proveedor: PROVEEDOR, dato: bloque }
}

function describirError(error: unknown): string {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return "El modelo tardó demasiado en responder (timeout). Intenta de nuevo."
  if (error instanceof Anthropic.AuthenticationError) return "La clave del proveedor LLM no es válida o no está configurada en el servidor."
  if (error instanceof Anthropic.RateLimitError) return "El proveedor LLM está limitando las solicitudes. Espera un momento e intenta de nuevo."
  if (error instanceof Anthropic.APIConnectionError) return "No fue posible conectar con el proveedor LLM."
  if (error instanceof Anthropic.APIError) return `El proveedor LLM respondió con error ${error.status ?? ""}.`
  return "Error inesperado al llamar al modelo."
}

export class AnthropicAdapter implements LlmAdapter {
  readonly proveedor = PROVEEDOR
  private readonly cliente: Anthropic

  constructor(readonly modelo: string, timeoutMs: number) {
    this.cliente = new Anthropic({ timeout: timeoutMs, maxRetries: 1 })
  }

  async enviar(sistema: string, mensajes: Mensaje[], herramientas: HerramientaSpec[]): Promise<Respuesta> {
    if (!process.env.ANTHROPIC_API_KEY) throw new ErrorLlm("El servidor no tiene configurada la clave del proveedor LLM (ANTHROPIC_API_KEY).")
    try {
      const respuesta = await this.cliente.messages.create({
        model: this.modelo,
        max_tokens: 8000,
        output_config: { effort: "medium" },
        system: [{ type: "text", text: sistema, cache_control: { type: "ephemeral" } }],
        tools: herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, input_schema: h.esquema as Anthropic.Tool.InputSchema })),
        messages: mensajes.map((m) => ({ role: m.rol === "usuario" ? "user" : "assistant", content: m.bloques.map(aContenido) })),
      })
      const fin = respuesta.stop_reason === "tool_use" ? "herramientas"
        : respuesta.stop_reason === "max_tokens" ? "limite"
        : respuesta.stop_reason === "refusal" ? "rechazo"
        : "turno"
      return { bloques: respuesta.content.map(deContenido), fin, uso: { entrada: respuesta.usage.input_tokens + (respuesta.usage.cache_read_input_tokens ?? 0) + (respuesta.usage.cache_creation_input_tokens ?? 0), salida: respuesta.usage.output_tokens } }
    } catch (error) {
      console.error(`[llm] ${error instanceof Error ? error.name : "Error"}: ${error instanceof Anthropic.APIError ? error.status : ""}`)
      throw new ErrorLlm(describirError(error))
    }
  }
}
