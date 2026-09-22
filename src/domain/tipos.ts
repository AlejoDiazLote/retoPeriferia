import { z } from "zod"

export const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string(),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: z.number({ error: "cantidad debe ser numérica" }).positive(),
  valor_unitario: z.number({ error: "valor_unitario debe ser numérico" }).nonnegative(),
  valor_total: z.number({ error: "valor_total debe ser numérico" }).positive(),
  moneda: z.enum(["COP", "USD"]),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fecha_solicitud debe ser AAAA-MM-DD"),
})
export type Solicitud = z.infer<typeof SolicitudSchema>

export const CorreoSchema = z.object({
  id: z.string(),
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
})

export const CotizacionSchema = z.object({
  referencia: z.string().nullable(),
  proveedor: z.string(),
  nit: z.string().nullable(),
  total: z.number(),
  moneda: z.string(),
  fecha: z.string().nullable(),
  validez_hasta: z.string().nullable(),
  texto: z.string(),
})

export const AprobacionSchema = z.object({
  de: z.string(),
  para: z.string().optional(),
  asunto: z.string().optional(),
  fecha: z.string(),
  aprobado: z.boolean(),
  texto: z.string(),
})

export const FacturaSchema = z.object({
  numero: z.string(),
  fecha: z.string(),
  total: z.number(),
})

export const PaqueteSchema = z.object({
  correo: CorreoSchema,
  solicitud: SolicitudSchema,
  cotizacion: CotizacionSchema.nullable(),
  aprobacion: AprobacionSchema.nullable(),
  factura: FacturaSchema.nullable(),
  faltantes: z.array(z.string()),
})
export type Paquete = z.infer<typeof PaqueteSchema>

export const HallazgoSchema = z.object({
  codigo: z.string(),
  regla: z.string(),
  detalle: z.string(),
  accion_sugerida: z.string(),
})
export type Hallazgo = z.infer<typeof HallazgoSchema>

export const DerivadosSchema = z.object({
  proveedor: z.object({ codigo_sap: z.string(), nit: z.string(), nombre: z.string() }).nullable(),
  indicador_iva: z.string().nullable(),
  condiciones_pago: z.string().nullable(),
  aprobador: z.object({ email: z.string(), nombre: z.string(), tope: z.number() }).nullable(),
  notas: z.array(z.string()),
})
export type Derivados = z.infer<typeof DerivadosSchema>

export type Validacion = {
  apta: boolean
  bloqueos: Hallazgo[]
  confirmaciones: Hallazgo[]
  derivados: Derivados
  retroactiva: boolean
}

export const OrdenCompraSchema = z.object({
  referencia: z.object({
    solicitud_id: z.string(),
    correo_id: z.string(),
    cotizacion_ref: z.string().nullable(),
  }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string(), nit: z.string(), nombre: z.string() }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string(),
  aprobador: z.object({
    email: z.string(),
    fecha_aprobacion: z.string(),
    evidencia_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  posiciones: z
    .array(
      z.object({
        numero: z.number().int(),
        descripcion: z.string().max(40),
        cantidad: z.number().positive(),
        unidad: z.enum(["UN", "H", "MES"]),
        precio_unitario: z.number().nonnegative(),
        centro_costo: z.string(),
        subarea: z.string(),
        indicador_iva: z.string(),
      }),
    )
    .min(1),
  excepciones: z.array(
    z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() }),
  ),
})
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>

export type Fuente = "solicitud" | "cotizacion" | "aprobacion" | "correo" | "derivado" | "constante" | `maestro.${string}`
export type Trazabilidad = Record<string, { valor: unknown; fuente: Fuente; nota?: string }>
