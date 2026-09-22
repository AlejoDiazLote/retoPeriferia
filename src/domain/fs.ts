import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

export const RUTA_FIXTURES = join("fixtures", "reto-03")
export const RUTA_SOLICITUDES = join(RUTA_FIXTURES, "solicitudes")
export const RUTA_MAESTROS = join(RUTA_FIXTURES, "maestros")
export const RUTA_OUT = "out"

const NOMBRE_CASO = /^[a-z0-9][a-z0-9-]{0,63}$/i

/** Evita path traversal: el caso es solo un nombre de carpeta. */
export function casoSeguro(caso: string): string | null {
  const limpio = caso.trim().toLowerCase()
  return NOMBRE_CASO.test(limpio) ? limpio : null
}

export async function leerTextoOpcional(ruta: string): Promise<string | null> {
  try {
    return await readFile(ruta, "utf8")
  } catch {
    return null
  }
}

export async function escribirArchivo(ruta: string, contenido: string | Uint8Array): Promise<void> {
  await mkdir(dirname(ruta), { recursive: true })
  await writeFile(ruta, contenido)
}

export async function agregarLinea(ruta: string, linea: string): Promise<void> {
  await mkdir(dirname(ruta), { recursive: true })
  await appendFile(ruta, linea.endsWith("\n") ? linea : `${linea}\n`)
}
