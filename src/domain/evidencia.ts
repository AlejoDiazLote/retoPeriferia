import { createHash } from "node:crypto"
import { join } from "node:path"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { RUTA_OUT, escribirArchivo } from "./fs.ts"
import type { Paquete } from "./tipos.ts"

export type Evidencia = { ruta: string; ruta_pdf: string; sha256: string }

function contenidoAprobacion(aprobacion: NonNullable<Paquete["aprobacion"]>, solicitudId: string): string {
  return [
    `EVIDENCIA DE APROBACIÓN · ${solicitudId}`,
    `De: ${aprobacion.de}`,
    `Para: ${aprobacion.para ?? ""}`,
    `Fecha: ${aprobacion.fecha}`,
    `Asunto: ${aprobacion.asunto ?? ""}`,
    "",
    aprobacion.texto,
    "",
  ].join("\n")
}

/** WinAnsi (fuente estándar del PDF) no cubre todo Unicode: se reemplaza lo que no soporta. */
function aWinAnsi(texto: string): string {
  return texto.replace(/[^\n\x20-\x7e -ÿ]/g, "?")
}

async function generarPdf(contenido: string, sha256: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const fuente = await pdf.embedFont(StandardFonts.Helvetica)
  const pagina = pdf.addPage([595, 842])
  const lineas = [...contenido.split("\n"), "", `SHA-256 del contenido: ${sha256}`]
  let y = 800
  for (const linea of lineas) {
    pagina.drawText(aWinAnsi(linea), { x: 50, y, size: linea === lineas[0] ? 13 : 10, font: fuente, maxWidth: 495 })
    y -= 16
  }
  pdf.setTitle("Evidencia de aprobación")
  pdf.setCreationDate(new Date(0))
  pdf.setModificationDate(new Date(0))
  return pdf.save()
}

/** Genera out/<caso>/aprobacion.txt y aprobacion.pdf. El sha256 es del contenido (encabezados + cuerpo). */
export async function generarEvidencia(directory: string, caso: string, paquete: Paquete): Promise<Evidencia> {
  if (!paquete.aprobacion) throw new Error("No hay correo de aprobación para generar la evidencia.")
  const contenido = contenidoAprobacion(paquete.aprobacion, paquete.solicitud.solicitud_id)
  const sha256 = createHash("sha256").update(contenido, "utf8").digest("hex")
  const ruta = join(RUTA_OUT, caso, "aprobacion.txt")
  const rutaPdf = join(RUTA_OUT, caso, "aprobacion.pdf")
  await escribirArchivo(join(directory, ruta), `${contenido}---\nsha256: ${sha256}\n`)
  await escribirArchivo(join(directory, rutaPdf), await generarPdf(contenido, sha256))
  return { ruta, ruta_pdf: rutaPdf, sha256 }
}
