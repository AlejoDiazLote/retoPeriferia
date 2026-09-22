import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { registrarControl } from "../domain/control.ts"
import { generarEvidencia } from "../domain/evidencia.ts"
import { RUTA_SOLICITUDES, casoSeguro } from "../domain/fs.ts"
import { cargarMaestros } from "../domain/maestros.ts"
import { ErrorPaquete, leerPaquete } from "../domain/paquete.ts"
import { construirPayload, guardarPayload } from "../domain/payload.ts"
import { validarPaquete } from "../domain/reglas.ts"
import { DerivadosSchema, type OrdenCompra, OrdenCompraSchema, type Paquete, PaqueteSchema, type Validacion } from "../domain/tipos.ts"
import type { SapAdapter } from "../sap/adapter.ts"
import { SapMock } from "../sap/mock.ts"

/**
 * Herramientas del agente. Cada export es una herramienta que el modelo ve como `oc_<export>`.
 * Son la única fuente de valores: siempre releen los archivos del caso, así el modelo no puede
 * alterar datos ni montos. Nunca lanzan: devuelven JSON con { ok: true, data } o { ok: false, error }.
 */

export type ToolContext = {
  directory: string
  sessionId: string
  /** Lo fija el servidor: true solo si el último mensaje del usuario confirma una pregunta pendiente. Sin servidor (demo, módulo) no se usa. */
  confirmacionHumana?: boolean
  sap?: SapAdapter
}

const sapPorDirectorio = new Map<string, SapAdapter>()
function sapDe(ctx: ToolContext): SapAdapter {
  if (ctx.sap) return ctx.sap
  const existente = sapPorDirectorio.get(ctx.directory)
  if (existente) return existente
  const nuevo = new SapMock(ctx.directory)
  sapPorDirectorio.set(ctx.directory, nuevo)
  return nuevo
}

class ErrorHerramienta extends Error {
  constructor(message: string, readonly extra: Record<string, unknown> = {}) {
    super(message)
  }
}

async function responder(fn: () => Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify({ ok: true, data: await fn() })
  } catch (error) {
    if (error instanceof ErrorHerramienta) return JSON.stringify({ ok: false, error: error.message, ...error.extra })
    if (error instanceof ErrorPaquete) return JSON.stringify({ ok: false, error: error.message })
    const mensaje = error instanceof Error ? error.message : String(error)
    return JSON.stringify({ ok: false, error: `Error inesperado: ${mensaje}` })
  }
}

function resolverCaso(caso: string): string {
  const seguro = casoSeguro(caso)
  if (!seguro) throw new ErrorHerramienta(`Nombre de caso inválido: "${caso}". Usa el nombre de la carpeta, por ejemplo "sol-001".`)
  return seguro
}

type Analisis = { caso: string; paquete: Paquete; validacion: Validacion }

async function analizar(ctx: ToolContext, casoCrudo: string): Promise<Analisis> {
  const caso = resolverCaso(casoCrudo)
  const [paquete, maestros] = await Promise.all([leerPaquete(ctx.directory, caso), cargarMaestros(ctx.directory)])
  return { caso, paquete, validacion: validarPaquete(paquete, maestros) }
}

function codigos(h: { codigo: string }[]): string[] {
  return h.map((x) => x.codigo)
}

/** JSON con claves ordenadas, para comparar payloads sin depender del orden. */
function estable(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(estable).join(",")}]`
  if (valor && typeof valor === "object") {
    const entradas = Object.entries(valor as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entradas.map(([k, v]) => `${JSON.stringify(k)}:${estable(v)}`).join(",")}}`
  }
  return JSON.stringify(valor)
}

const argCaso = z.string().describe('Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, por ejemplo "sol-001"')

export const listar_casos = {
  description: "Lista los casos (carpetas de solicitudes) disponibles para procesar.",
  args: {},
  async execute(_args: Record<string, never>, ctx: ToolContext): Promise<string> {
    return responder(async () => {
      const entradas = await readdir(join(ctx.directory, RUTA_SOLICITUDES), { withFileTypes: true })
      return { casos: entradas.filter((e) => e.isDirectory()).map((e) => e.name).sort() }
    })
  },
}

export const leer_paquete = {
  description: "Lee y normaliza el paquete de un caso: correo, solicitud, cotización, aprobación y factura (si existe); los adjuntos ausentes vienen en null y se listan en faltantes.",
  args: { caso: argCaso },
  async execute(args: { caso: string }, ctx: ToolContext): Promise<string> {
    return responder(async () => {
      const caso = resolverCaso(args.caso)
      return leerPaquete(ctx.directory, caso)
    })
  },
}

export const validar = {
  description: "Aplica las reglas de control RC1–RC10 contra los maestros y devuelve apta, bloqueos, confirmaciones, derivados y si la OC es retroactiva.",
  args: {
    caso: argCaso,
    paquete: PaqueteSchema.optional().describe("Paquete de oc_leer_paquete. Opcional: la herramienta relee siempre los archivos del caso como fuente de verdad."),
  },
  async execute(args: { caso: string; paquete?: Paquete }, ctx: ToolContext): Promise<string> {
    return responder(async () => {
      const { paquete, validacion } = await analizar(ctx, args.caso)
      const advertencias = args.paquete && estable(args.paquete.solicitud) !== estable(paquete.solicitud)
        ? ["El paquete recibido difiere de los archivos del caso; se usaron los archivos."]
        : []
      return { solicitud_id: paquete.solicitud.solicitud_id, ...validacion, advertencias }
    })
  },
}

export const generar_evidencia = {
  description: "Genera la evidencia de aprobación del caso (out/<caso>/aprobacion.txt y aprobacion.pdf) y devuelve su ruta y sha256.",
  args: { caso: argCaso },
  async execute(args: { caso: string }, ctx: ToolContext): Promise<string> {
    return responder(async () => {
      const caso = resolverCaso(args.caso)
      const paquete = await leerPaquete(ctx.directory, caso)
      if (!paquete.aprobacion) throw new ErrorHerramienta("El caso no tiene correo de aprobación; pide al solicitante la aprobación del líder.")
      return generarEvidencia(ctx.directory, caso, paquete)
    })
  },
}

async function prepararOrden(ctx: ToolContext, analisis: Analisis): Promise<{ payload: OrdenCompra; ruta_trazabilidad: string; ruta_payload: string; evidencia: Awaited<ReturnType<typeof generarEvidencia>> }> {
  const evidencia = await generarEvidencia(ctx.directory, analisis.caso, analisis.paquete)
  const { payload, trazabilidad } = construirPayload(analisis.paquete, analisis.validacion, evidencia.sha256)
  const rutas = await guardarPayload(ctx.directory, analisis.caso, payload, trazabilidad)
  return { payload, evidencia, ...rutas }
}

export const construir_payload = {
  description: "Construye la orden de compra exactamente como quedaría en SAP (validada con zod) y guarda su trazabilidad en out/<caso>/trazabilidad.json; solo funciona si el caso no tiene bloqueos.",
  args: {
    caso: argCaso,
    paquete: PaqueteSchema.optional().describe("Paquete de oc_leer_paquete. Opcional: se releen los archivos del caso."),
    derivados: DerivadosSchema.optional().describe("Derivados de oc_validar. Opcional: se recalculan desde los maestros."),
  },
  async execute(args: { caso: string; paquete?: Paquete; derivados?: unknown }, ctx: ToolContext): Promise<string> {
    return responder(async () => {
      const analisis = await analizar(ctx, args.caso)
      if (!analisis.validacion.apta) {
        throw new ErrorHerramienta("La solicitud tiene bloqueos; no se construye la OC.", { bloqueos: analisis.validacion.bloqueos })
      }
      const { payload, ruta_trazabilidad, ruta_payload } = await prepararOrden(ctx, analisis)
      return { payload, ruta_trazabilidad, ruta_payload, confirmaciones_pendientes: analisis.validacion.confirmaciones, retroactiva: analisis.validacion.retroactiva }
    })
  },
}

export const crear = {
  description: "Crea la OC en SAP (simulado) si no hay bloqueos y, cuando hay confirmaciones, solo con confirmado=true tras la confirmación explícita del usuario; es idempotente por solicitud_id y registra cada intento en out/control.csv.",
  args: {
    caso: argCaso,
    payload: OrdenCompraSchema.optional().describe("Payload devuelto por oc_construir_payload. Opcional; si se envía debe coincidir exactamente con el que la herramienta recalcula."),
    confirmado: z.boolean().optional().describe("true solo si el usuario confirmó explícitamente en su último mensaje las confirmaciones pendientes"),
  },
  async execute(args: { caso: string; payload?: OrdenCompra; confirmado?: boolean }, ctx: ToolContext): Promise<string> {
    return responder(() => crearOrden(args, ctx))
  },
}

async function crearOrden(args: { caso: string; payload?: OrdenCompra; confirmado?: boolean }, ctx: ToolContext) {
  const analisis = await analizar(ctx, args.caso)
  const { paquete, validacion } = analisis
  const sap = sapDe(ctx)
  const fila = { solicitud_id: paquete.solicitud.solicitud_id, retroactiva: validacion.retroactiva, bloqueos: codigos(validacion.bloqueos), confirmaciones: codigos(validacion.confirmaciones) }

  const existente = await sap.buscarOrdenPorReferencia(paquete.solicitud.solicitud_id)
  if (existente) {
    await registrarControl(ctx.directory, { ...fila, resultado: "existente", numero_oc: existente.numero_oc })
    return { numero_oc: existente.numero_oc, fecha: null, idempotente: true, mensaje: "La OC ya existía para esta solicitud; no se creó otra." }
  }
  if (!validacion.apta) {
    await registrarControl(ctx.directory, { ...fila, resultado: "bloqueada", numero_oc: null })
    throw new ErrorHerramienta("OC no creada: la solicitud tiene bloqueos.", { resultado: "bloqueada", bloqueos: validacion.bloqueos })
  }
  const requiereConfirmacion = validacion.confirmaciones.length > 0
  const confirmado = args.confirmado === true && ctx.confirmacionHumana !== false
  if (requiereConfirmacion && !confirmado) {
    await registrarControl(ctx.directory, { ...fila, resultado: "pendiente_confirmacion", numero_oc: null })
    const motivo = args.confirmado && ctx.confirmacionHumana === false
      ? "El usuario aún no ha confirmado en el chat. Pregúntale y espera su respuesta."
      : "OC no creada: requiere confirmación explícita del usuario."
    throw new ErrorHerramienta(motivo, { resultado: "pendiente_confirmacion", confirmaciones: validacion.confirmaciones })
  }

  const { payload, evidencia } = await prepararOrden(ctx, analisis)
  if (args.payload && estable(args.payload) !== estable(payload)) {
    throw new ErrorHerramienta("El payload recibido no coincide con el calculado desde las fuentes; no se crea la OC. Omite el payload o usa el de oc_construir_payload sin modificarlo.")
  }
  const orden: OrdenCompra = requiereConfirmacion
    ? { ...payload, excepciones: payload.excepciones.map((e) => ({ ...e, confirmado_por: `analista (sesión ${ctx.sessionId})` })) }
    : payload
  const proveedorSap = await sap.consultarProveedor(orden.proveedor.nit)
  if (!proveedorSap?.activo) throw new ErrorHerramienta("SAP reporta el proveedor como inexistente o inactivo; no se crea la OC.")

  const { numero_oc, fecha } = await sap.crearOrden(orden)
  await registrarControl(ctx.directory, { ...fila, resultado: "creada", numero_oc })
  return { numero_oc, fecha, idempotente: false, retroactiva: validacion.retroactiva, evidencia: { ruta: evidencia.ruta, ruta_pdf: evidencia.ruta_pdf, sha256: evidencia.sha256 }, excepciones: orden.excepciones }
}
