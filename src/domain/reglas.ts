import { buscarProveedor, type Maestros } from "./maestros.ts"
import { fechaCalendario, formatoCop } from "./texto.ts"
import type { Derivados, Hallazgo, Paquete, Validacion } from "./tipos.ts"

/** Parámetros de negocio de las reglas de control (ver src/knowledge/ordenes-compra.md). */
export const PARAMETROS = {
  toleranciaCotizacion: 0.02,
  toleranciaAritmetica: 1,
} as const

type Contexto = { paquete: Paquete; maestros: Maestros; derivados: Derivados; bloqueos: Hallazgo[]; confirmaciones: Hallazgo[] }

function bloqueo(ctx: Contexto, codigo: string, regla: string, detalle: string, accion_sugerida: string): void {
  ctx.bloqueos.push({ codigo, regla, detalle, accion_sugerida })
}
function confirmacion(ctx: Contexto, codigo: string, regla: string, detalle: string, accion_sugerida: string): void {
  ctx.confirmaciones.push({ codigo, regla, detalle, accion_sugerida })
}

function rc1Proveedor(ctx: Contexto): void {
  const { solicitud } = ctx.paquete
  const { proveedor, criterio } = buscarProveedor(ctx.maestros, solicitud.proveedor_nit, solicitud.proveedor_nombre)
  const clave = criterio === "nit" ? `NIT ${solicitud.proveedor_nit}` : `nombre "${solicitud.proveedor_nombre}"`
  if (!proveedor) {
    bloqueo(ctx, "PROVEEDOR_INEXISTENTE", "RC1", `El proveedor ${solicitud.proveedor_nombre} (${clave}) no existe en el maestro de proveedores.`, "Solicitar a Compras la creación del proveedor en SAP (RUT, certificación bancaria) o cambiar a un proveedor registrado.")
    return
  }
  if (criterio === "nombre") ctx.derivados.notas.push(`Proveedor identificado por nombre normalizado (la solicitud no trae NIT): ${proveedor.nombre}, NIT ${proveedor.nit}.`)
  if (!proveedor.activo) {
    bloqueo(ctx, "PROVEEDOR_INACTIVO", "RC1", `El proveedor ${proveedor.nombre} (código SAP ${proveedor.codigo_sap}) está inactivo.`, "Solicitar a Compras la reactivación del proveedor o cambiar de proveedor.")
    return
  }
  ctx.derivados.proveedor = { codigo_sap: proveedor.codigo_sap, nit: proveedor.nit, nombre: proveedor.nombre }
}

function rc2rc3rc4CentroYAprobador(ctx: Contexto): void {
  const { solicitud, aprobacion } = ctx.paquete
  const centro = ctx.maestros.centrosCosto.find((c) => c.centro_costo === solicitud.centro_costo)
  if (!centro) {
    bloqueo(ctx, "CENTRO_COSTO_INEXISTENTE", "RC4", `El centro de costo ${solicitud.centro_costo} no existe.`, "Pedir al solicitante el centro de costo correcto.")
    return
  }
  if (!centro.subareas.includes(solicitud.subarea)) {
    bloqueo(ctx, "SUBAREA_INVALIDA", "RC4", `La subárea "${solicitud.subarea}" no pertenece a ${centro.centro_costo} (válidas: ${centro.subareas.join(", ")}).`, "Pedir al solicitante que corrija la subárea o el centro de costo.")
  }
  if (!aprobacion) {
    bloqueo(ctx, "APROBACION_AUSENTE", "RC2", "No hay correo de aprobación del líder.", "Pedir al solicitante el correo de aprobación de un aprobador del centro de costo.")
    return
  }
  if (!aprobacion.aprobado) {
    bloqueo(ctx, "APROBACION_SIN_APROBADO", "RC2", `El correo de ${aprobacion.de} no contiene la palabra "Aprobado".`, "Pedir al líder una aprobación explícita.")
  }
  const aprobador = centro.aprobadores.find((a) => a.email.toLowerCase() === aprobacion.de.toLowerCase())
  const topeMaximo = Math.max(...centro.aprobadores.map((a) => a.tope))
  if (!aprobador) {
    const validos = centro.aprobadores.map((a) => `${a.nombre || a.email} <${a.email}> (tope ${formatoCop(a.tope)})`).join("; ")
    bloqueo(ctx, "APROBADOR_NO_AUTORIZADO", "RC2", `${aprobacion.de} no es aprobador de ${centro.centro_costo}. Aprobadores válidos: ${validos}.`, "Obtener la aprobación de un aprobador del centro de costo, o corregir el centro de costo si la compra pertenece a otra área.")
    if (solicitud.valor_total > topeMaximo) {
      bloqueo(ctx, "MONTO_SUPERA_TOPES_CENTRO", "RC3", `El valor ${formatoCop(solicitud.valor_total)} supera el tope máximo de cualquier aprobador de ${centro.centro_costo} (${formatoCop(topeMaximo)}).`, "Escalar a un nivel de aprobación superior o dividir la compra según la política vigente.")
    }
    return
  }
  ctx.derivados.aprobador = { email: aprobador.email, nombre: aprobador.nombre, tope: aprobador.tope }
  if (solicitud.valor_total > aprobador.tope) {
    bloqueo(ctx, "MONTO_SUPERA_TOPE", "RC3", `El valor ${formatoCop(solicitud.valor_total)} supera el tope de ${aprobador.email} (${formatoCop(aprobador.tope)}).`, "Obtener aprobación de un aprobador con tope suficiente en el centro de costo.")
  }
}

function rc5Cotizacion(ctx: Contexto): void {
  const { solicitud, cotizacion } = ctx.paquete
  if (!cotizacion || !Number.isFinite(cotizacion.total)) {
    confirmacion(ctx, "SIN_COTIZACION", "RC5", "No hay cotización legible del proveedor para contrastar el valor.", "Confirmar que se crea la OC sin cotización, o pedirla al solicitante.")
    return
  }
  const diferencia = Math.abs(cotizacion.total - solicitud.valor_total) / solicitud.valor_total
  if (diferencia > PARAMETROS.toleranciaCotizacion) {
    confirmacion(ctx, "COTIZACION_DIFIERE", "RC5", `Solicitud: ${formatoCop(solicitud.valor_total)} vs cotización ${cotizacion.referencia ?? ""}: ${formatoCop(cotizacion.total)} (diferencia ${(diferencia * 100).toFixed(1)} %, tolerancia ${PARAMETROS.toleranciaCotizacion * 100} %). La OC se crea con el valor de la solicitud, que es el aprobado.`, "Confirmar crear con el valor de la solicitud, o pedir al solicitante que actualice la solicitud y la aprobación al valor cotizado.")
  }
}

function rc6rc7Derivados(ctx: Contexto): void {
  const { solicitud } = ctx.paquete
  const proveedor = buscarProveedor(ctx.maestros, solicitud.proveedor_nit, solicitud.proveedor_nombre).proveedor
  if (solicitud.indicador_iva) {
    if (!ctx.maestros.indicadoresIva.some((i) => i.codigo === solicitud.indicador_iva)) {
      bloqueo(ctx, "INDICADOR_IVA_INVALIDO", "RC6", `El indicador de IVA ${solicitud.indicador_iva} no existe en el maestro.`, "Pedir el indicador correcto (C0, C1, C2).")
    } else ctx.derivados.indicador_iva = solicitud.indicador_iva
  } else if (proveedor) {
    const iva = ctx.maestros.indicadoresIva.find((i) => i.codigo === proveedor.indicador_iva_default)
    ctx.derivados.indicador_iva = proveedor.indicador_iva_default
    confirmacion(ctx, "IVA_DERIVADO", "RC6", `La solicitud no informa indicador de IVA. Se propone ${proveedor.indicador_iva_default} (${iva?.descripcion ?? "?"}) por defecto del proveedor ${proveedor.nombre}.`, "Confirmar el indicador de IVA derivado o indicar el correcto.")
  }
  if (solicitud.condiciones_pago) {
    if (!ctx.maestros.condicionesPago.some((c) => c.codigo === solicitud.condiciones_pago)) {
      bloqueo(ctx, "CONDICION_PAGO_INVALIDA", "RC7", `La condición de pago ${solicitud.condiciones_pago} no existe en el maestro.`, "Pedir la condición de pago correcta.")
    } else ctx.derivados.condiciones_pago = solicitud.condiciones_pago
  } else if (proveedor) {
    const cond = ctx.maestros.condicionesPago.find((c) => c.codigo === proveedor.condiciones_pago_default)
    ctx.derivados.condiciones_pago = proveedor.condiciones_pago_default
    ctx.derivados.notas.push(`Condiciones de pago derivadas del proveedor: ${proveedor.condiciones_pago_default} (${cond?.descripcion ?? "?"}).`)
  }
}

function rc8Retroactiva(ctx: Contexto): boolean {
  const { solicitud, factura } = ctx.paquete
  if (!factura || !factura.fecha || factura.fecha >= solicitud.fecha_solicitud) return false
  confirmacion(ctx, "OC_RETROACTIVA", "RC8", `La factura ${factura.numero} es del ${factura.fecha}, anterior a la solicitud (${solicitud.fecha_solicitud}). La OC es retroactiva y quedará marcada en el log de control.`, "Confirmar la creación de la OC retroactiva; se registrará para medición del desvío de proceso.")
  return true
}

function rc9FechaAprobacion(ctx: Contexto): void {
  const { solicitud, aprobacion } = ctx.paquete
  if (!aprobacion) return
  const fecha = fechaCalendario(aprobacion.fecha)
  if (fecha < solicitud.fecha_solicitud) {
    confirmacion(ctx, "APROBACION_ANTERIOR", "RC9", `La aprobación (${fecha}) es anterior a la solicitud (${solicitud.fecha_solicitud}).`, "Confirmar que la aprobación corresponde a esta solicitud.")
  }
}

function rc10Aritmetica(ctx: Contexto): void {
  const { cantidad, valor_unitario, valor_total } = ctx.paquete.solicitud
  const calculado = cantidad * valor_unitario
  if (Math.abs(calculado - valor_total) > PARAMETROS.toleranciaAritmetica) {
    bloqueo(ctx, "TOTAL_NO_CUADRA", "RC10", `cantidad × valor_unitario = ${formatoCop(calculado)} no coincide con valor_total ${formatoCop(valor_total)}.`, "Pedir al solicitante que corrija cantidad, valor unitario o total en el Excel.")
  }
}

export function validarPaquete(paquete: Paquete, maestros: Maestros): Validacion {
  const ctx: Contexto = {
    paquete,
    maestros,
    derivados: { proveedor: null, indicador_iva: null, condiciones_pago: null, aprobador: null, notas: [] },
    bloqueos: [],
    confirmaciones: [],
  }
  rc1Proveedor(ctx)
  rc2rc3rc4CentroYAprobador(ctx)
  rc10Aritmetica(ctx)
  rc5Cotizacion(ctx)
  rc6rc7Derivados(ctx)
  const retroactiva = rc8Retroactiva(ctx)
  rc9FechaAprobacion(ctx)
  return { apta: ctx.bloqueos.length === 0, bloqueos: ctx.bloqueos, confirmaciones: ctx.confirmaciones, derivados: ctx.derivados, retroactiva }
}
