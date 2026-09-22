import { existsSync } from "node:fs"
import { join } from "node:path"
import { RUTA_OUT, agregarLinea } from "./fs.ts"

export type ResultadoControl = "creada" | "existente" | "bloqueada" | "pendiente_confirmacion" | "error"

export type FilaControl = {
  solicitud_id: string
  resultado: ResultadoControl
  numero_oc: string | null
  retroactiva: boolean
  bloqueos: string[]
  confirmaciones: string[]
}

const ENCABEZADO = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts"

function csv(valor: string): string {
  return /[",\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor
}

/** Agrega una fila a out/control.csv por cada intento de creación. */
export async function registrarControl(directory: string, fila: FilaControl): Promise<void> {
  const ruta = join(directory, RUTA_OUT, "control.csv")
  if (!existsSync(ruta)) await agregarLinea(ruta, ENCABEZADO)
  const valores = [
    fila.solicitud_id,
    fila.resultado,
    fila.numero_oc ?? "",
    String(fila.retroactiva),
    fila.bloqueos.join("|"),
    fila.confirmaciones.join("|"),
    new Date().toISOString(),
  ]
  await agregarLinea(ruta, valores.map(csv).join(","))
}
