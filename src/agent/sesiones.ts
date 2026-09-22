import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { RUTA_OUT, escribirArchivo, leerTextoOpcional } from "../domain/fs.ts"
import type { Mensaje } from "../llm/adapter.ts"

export type ToolCallVista = { nombre: string; argumentos: unknown; ok: boolean; resumen: string; resultado: unknown }

export type EntradaVisible = {
  rol: "usuario" | "asistente"
  texto: string
  toolCalls?: ToolCallVista[]
  needsConfirmation?: boolean
  error?: string
  ts: string
}

export type Sesion = {
  id: string
  creada: string
  mensajes: Mensaje[]
  historial: EntradaVisible[]
  tokens: number
  confirmacionPendiente: boolean
}

const ID_VALIDO = /^[a-zA-Z0-9-]{8,64}$/

/** Sesiones en memoria con respaldo en out/sessions/<id>.json. */
export class AlmacenSesiones {
  private readonly sesiones = new Map<string, Sesion>()
  private readonly ocupadas = new Set<string>()

  constructor(private readonly directory: string) {}

  private ruta(id: string): string {
    return join(this.directory, RUTA_OUT, "sessions", `${id}.json`)
  }

  async obtener(id: string | undefined): Promise<Sesion> {
    if (id && ID_VALIDO.test(id)) {
      const enMemoria = this.sesiones.get(id)
      if (enMemoria) return enMemoria
      const guardada = await leerTextoOpcional(this.ruta(id))
      if (guardada) {
        const sesion = JSON.parse(guardada) as Sesion
        this.sesiones.set(id, sesion)
        return sesion
      }
    }
    const sesion: Sesion = { id: id && ID_VALIDO.test(id) ? id : randomUUID(), creada: new Date().toISOString(), mensajes: [], historial: [], tokens: 0, confirmacionPendiente: false }
    this.sesiones.set(sesion.id, sesion)
    return sesion
  }

  async buscar(id: string): Promise<Sesion | null> {
    if (!ID_VALIDO.test(id)) return null
    return this.sesiones.get(id) ?? (await this.obtener(id).then((s) => (s.historial.length ? s : null)))
  }

  async guardar(sesion: Sesion): Promise<void> {
    await escribirArchivo(this.ruta(sesion.id), JSON.stringify(sesion))
  }

  /** Evita dos turnos simultáneos sobre la misma sesión. */
  bloquear(id: string): boolean {
    if (this.ocupadas.has(id)) return false
    this.ocupadas.add(id)
    return true
  }

  liberar(id: string): void {
    this.ocupadas.delete(id)
  }
}
