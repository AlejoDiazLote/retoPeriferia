import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { RUTA_MAESTROS } from "./fs.ts"
import { normalizarNit, normalizarNombre } from "./texto.ts"

const ProveedorSchema = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
})
const CentroCostoSchema = z.object({
  centro_costo: z.string(),
  nombre: z.string().optional(),
  subareas: z.array(z.string()),
  aprobadores: z.array(z.object({ email: z.string(), nombre: z.string().default(""), tope: z.number() })),
})
const IndicadorIvaSchema = z.object({ codigo: z.string(), descripcion: z.string(), tasa: z.number() })
const CondicionPagoSchema = z.object({ codigo: z.string(), descripcion: z.string(), dias: z.number() })

export type Proveedor = z.infer<typeof ProveedorSchema>
export type CentroCosto = z.infer<typeof CentroCostoSchema>

export type Maestros = {
  proveedores: Proveedor[]
  centrosCosto: CentroCosto[]
  indicadoresIva: z.infer<typeof IndicadorIvaSchema>[]
  condicionesPago: z.infer<typeof CondicionPagoSchema>[]
}

async function leerMaestro<T>(directory: string, archivo: string, schema: z.ZodType<T>): Promise<T[]> {
  const contenido = await readFile(join(directory, RUTA_MAESTROS, archivo), "utf8")
  return z.array(schema).parse(JSON.parse(contenido))
}

export async function cargarMaestros(directory: string): Promise<Maestros> {
  const [proveedores, centrosCosto, indicadoresIva, condicionesPago] = await Promise.all([
    leerMaestro(directory, "proveedores.json", ProveedorSchema),
    leerMaestro(directory, "centros-costo.json", CentroCostoSchema),
    leerMaestro(directory, "indicadores-iva.json", IndicadorIvaSchema),
    leerMaestro(directory, "condiciones-pago.json", CondicionPagoSchema),
  ])
  return { proveedores, centrosCosto, indicadoresIva, condicionesPago }
}

export type BusquedaProveedor = { proveedor: Proveedor | null; criterio: "nit" | "nombre" }

/** RC1: por NIT si lo hay; si no, por nombre normalizado. */
export function buscarProveedor(maestros: Maestros, nit: string | undefined, nombre: string): BusquedaProveedor {
  const nitNormalizado = normalizarNit(nit)
  if (nitNormalizado) {
    const proveedor = maestros.proveedores.find((p) => normalizarNit(p.nit) === nitNormalizado) ?? null
    return { proveedor, criterio: "nit" }
  }
  const nombreNormalizado = normalizarNombre(nombre)
  const proveedor = maestros.proveedores.find((p) => normalizarNombre(p.nombre) === nombreNormalizado) ?? null
  return { proveedor, criterio: "nombre" }
}
