import type { HerramientaSpec } from "../tools/registry.ts"

/** Formato neutro de conversación: el ciclo del agente solo conoce estos tipos, no los del proveedor. */
export type Bloque =
  | { tipo: "texto"; texto: string }
  | { tipo: "llamada"; id: string; nombre: string; argumentos: unknown }
  | { tipo: "resultado"; llamadaId: string; contenido: string; esError: boolean }
  /** Bloques propios del proveedor (p. ej. razonamiento) que deben reenviarse sin cambios. */
  | { tipo: "opaco"; proveedor: string; dato: unknown }

export type Mensaje = { rol: "usuario" | "asistente"; bloques: Bloque[] }

export type Respuesta = {
  bloques: Bloque[]
  fin: "turno" | "herramientas" | "limite" | "rechazo"
  uso: { entrada: number; salida: number }
}

export interface LlmAdapter {
  readonly proveedor: string
  readonly modelo: string
  enviar(sistema: string, mensajes: Mensaje[], herramientas: HerramientaSpec[]): Promise<Respuesta>
}

export class ErrorLlm extends Error {}
