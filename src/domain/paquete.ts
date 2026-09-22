import { join } from "node:path"
import { z } from "zod"
import { RUTA_SOLICITUDES, leerTextoOpcional } from "./fs.ts"
import { campo, parsearMonto, sumarDias } from "./texto.ts"
import { type Paquete, SolicitudSchema } from "./tipos.ts"

export class ErrorPaquete extends Error {}

const CorreoCrudoSchema = z.object({ id: z.string(), de: z.string(), asunto: z.string(), fecha: z.string() })
const AprobacionCrudaSchema = z.object({
  de: z.string(),
  para: z.string().optional(),
  fecha: z.string(),
  asunto: z.string().optional(),
  cuerpo: z.string(),
})

function parsearJson(texto: string, archivo: string): unknown {
  try {
    return JSON.parse(texto)
  } catch {
    throw new ErrorPaquete(`${archivo} no es un JSON válido. Pide al solicitante que reenvíe el archivo.`)
  }
}

function validar<T>(schema: z.ZodType<T>, dato: unknown, archivo: string): T {
  const resultado = schema.safeParse(dato)
  if (resultado.success) return resultado.data
  const detalle = resultado.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
  throw new ErrorPaquete(`${archivo} tiene datos inválidos (${detalle}). Pide al solicitante que lo corrija.`)
}

export function parsearCotizacion(texto: string): NonNullable<Paquete["cotizacion"]> {
  const totalLinea = campo(texto, /^TOTAL[^:\n]*:\s*(.+)$/im) ?? ""
  const fecha = campo(texto, /^Fecha:\s*(\d{4}-\d{2}-\d{2})/im)
  const diasValidez = campo(texto, /^Validez[^:\n]*:\s*(\d+)\s*d[ií]as/im)
  return {
    referencia: campo(texto, /^COTIZACI[ÓO]N\s+(\S+)/im),
    proveedor: campo(texto, /^Proveedor:\s*(.+)$/im) ?? "",
    nit: campo(texto, /^NIT:\s*(.+)$/im),
    total: parsearMonto(totalLinea) ?? Number.NaN,
    moneda: campo(totalLinea, /\b(COP|USD)\b/) ?? "COP",
    fecha,
    validez_hasta: fecha && diasValidez ? sumarDias(fecha, Number(diasValidez)) : null,
    texto,
  }
}

export function parsearFactura(texto: string): NonNullable<Paquete["factura"]> {
  return {
    numero: campo(texto, /No\.\s*(\S+)/i) ?? "sin-numero",
    fecha: campo(texto, /Fecha(?: de emisi[óo]n)?:\s*(\d{4}-\d{2}-\d{2})/i) ?? "",
    total: parsearMonto(campo(texto, /^TOTAL:\s*(.+)$/im) ?? "") ?? Number.NaN,
  }
}

/** Contiene la palabra "aprobado" y no está negada ("no aprobado"). */
export function contieneAprobado(cuerpo: string): boolean {
  return /\baprobad[oa]\b/i.test(cuerpo) && !/\bno\s+(queda\s+)?aprobad[oa]\b/i.test(cuerpo)
}

export async function leerPaquete(directory: string, caso: string): Promise<Paquete> {
  const base = join(directory, RUTA_SOLICITUDES, caso)
  const [correoTxt, solicitudTxt, cotizacionTxt, aprobacionTxt, facturaTxt] = await Promise.all(
    ["correo.json", "solicitud.json", "cotizacion.txt", "aprobacion.json", "factura.txt"].map((a) =>
      leerTextoOpcional(join(base, a)),
    ),
  )
  if (correoTxt === null && solicitudTxt === null) {
    throw new ErrorPaquete(`No existe el caso "${caso}" o está vacío.`)
  }
  if (solicitudTxt === null) {
    throw new ErrorPaquete("Falta solicitud.json (Excel de solicitud). Pide al solicitante que lo adjunte.")
  }
  const faltantes: string[] = []
  const correo = correoTxt
    ? validar(CorreoCrudoSchema, parsearJson(correoTxt, "correo.json"), "correo.json")
    : (faltantes.push("correo.json"), { id: `${caso}-correo`, de: "", asunto: "", fecha: "" })
  const solicitud = validar(SolicitudSchema, parsearJson(solicitudTxt, "solicitud.json"), "solicitud.json")

  let aprobacion: Paquete["aprobacion"] = null
  if (aprobacionTxt === null) faltantes.push("aprobacion.json (correo de aprobación del líder)")
  else {
    const cruda = validar(AprobacionCrudaSchema, parsearJson(aprobacionTxt, "aprobacion.json"), "aprobacion.json")
    aprobacion = { de: cruda.de, para: cruda.para, asunto: cruda.asunto, fecha: cruda.fecha, aprobado: contieneAprobado(cruda.cuerpo), texto: cruda.cuerpo }
  }
  if (cotizacionTxt === null) faltantes.push("cotizacion.txt (cotización del proveedor)")

  return {
    correo: { id: correo.id, de: correo.de, asunto: correo.asunto, fecha: correo.fecha },
    solicitud,
    cotizacion: cotizacionTxt === null ? null : parsearCotizacion(cotizacionTxt),
    aprobacion,
    factura: facturaTxt === null ? null : parsearFactura(facturaTxt),
    faltantes,
  }
}
