import type { LlmAdapter } from "./adapter.ts"
import { AnthropicAdapter } from "./anthropic.ts"
import { GoogleAdapter } from "./google.ts"

/** Único punto que conoce las implementaciones concretas. Agregar un proveedor = nuevo archivo + un caso aquí. */
export function crearAdaptador(): LlmAdapter {
  const proveedor = process.env.LLM_PROVIDER ?? "anthropic"
  const timeout = Number(process.env.LLM_TIMEOUT_MS ?? 90000)
  switch (proveedor) {
    case "anthropic":
      return new AnthropicAdapter(process.env.ANTHROPIC_MODEL || "claude-opus-5", timeout)
    case "google":
      return new GoogleAdapter(process.env.GOOGLE_MODEL || "gemini-3.1-flash-lite", timeout)
    default:
      throw new Error(`Proveedor LLM no soportado: ${proveedor}`)
  }
}
