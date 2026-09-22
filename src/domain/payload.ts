import { join } from "node:path"
import { RUTA_OUT, escribirArchivo } from "./fs.ts"
import { fechaCalendario, textoBreve } from "./texto.ts"
import { type OrdenCompra, OrdenCompraSchema, type Paquete, type Trazabilidad, type Validacion } from "./tipos.ts"

const LIMITE_TEXTO_BREVE = 40

/** Unidad de medida SAP deducida del texto: horas → H, mensualidades → MES, resto → UN. */
export function deducirUnidad(...textos: string[]): OrdenCompra["posiciones"][number]["unidad"] {
  const texto = textos.join(" ").toLowerCase()
  if (/\bhoras?\b/.test(texto)) return "H"
  if (/\b(mensualidad(es)?|por mes|mensual)\b/.test(texto)) return "MES"
  return "UN"
}

export type ResultadoPayload = { payload: OrdenCompra; trazabilidad: Trazabilidad; ruta_trazabilidad: string; ruta_payload: string }

export function construirPayload(paquete: Paquete, validacion: Validacion, evidenciaSha256: string): { payload: OrdenCompra; trazabilidad: Trazabilidad } {
  const { solicitud, cotizacion, aprobacion, correo } = paquete
  const { derivados } = validacion
  if (!validacion.apta || !derivados.proveedor || !aprobacion || !derivados.indicador_iva || !derivados.condiciones_pago) {
    throw new Error("La solicitud no es apta: resuelve los bloqueos antes de construir el payload.")
  }
  const itemCotizacion = cotizacion?.texto.match(/^1\.\s*([^|\n]+)/m)?.[1]?.trim() ?? ""
  const descripcion = textoBreve(solicitud.descripcion, LIMITE_TEXTO_BREVE)
  const unidad = deducirUnidad(solicitud.descripcion, itemCotizacion)
  const excepciones = [...validacion.confirmaciones.map((c) => ({ codigo: c.codigo, detalle: c.detalle, confirmado_por: null }))]
  if (validacion.retroactiva && !excepciones.some((e) => e.codigo === "OC_RETROACTIVA")) {
    excepciones.push({ codigo: "OC_RETROACTIVA", detalle: "Factura anterior a la solicitud", confirmado_por: null })
  }

  const payload = OrdenCompraSchema.parse({
    referencia: { solicitud_id: solicitud.solicitud_id, correo_id: correo.id, cotizacion_ref: cotizacion?.referencia ?? null },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: derivados.proveedor,
    moneda: solicitud.moneda,
    condiciones_pago: derivados.condiciones_pago,
    aprobador: { email: aprobacion.de, fecha_aprobacion: fechaCalendario(aprobacion.fecha), evidencia_sha256: evidenciaSha256 },
    posiciones: [{
      numero: 10,
      descripcion,
      cantidad: solicitud.cantidad,
      unidad,
      precio_unitario: solicitud.valor_unitario,
      centro_costo: solicitud.centro_costo,
      subarea: solicitud.subarea,
      indicador_iva: derivados.indicador_iva,
    }],
    excepciones,
  })

  const fuenteIva = solicitud.indicador_iva ? "solicitud" : "maestro.proveedores"
  const fuentePago = solicitud.condiciones_pago ? "solicitud" : "maestro.proveedores"
  const trazabilidad: Trazabilidad = {
    "referencia.solicitud_id": { valor: solicitud.solicitud_id, fuente: "solicitud" },
    "referencia.correo_id": { valor: correo.id, fuente: "correo" },
    "referencia.cotizacion_ref": { valor: payload.referencia.cotizacion_ref, fuente: "cotizacion" },
    sociedad: { valor: "1000", fuente: "constante", nota: "Sociedad única del reto" },
    organizacion_compras: { valor: "1000", fuente: "constante" },
    proveedor: { valor: payload.proveedor, fuente: "maestro.proveedores", nota: solicitud.proveedor_nit ? "Buscado por NIT" : "Buscado por nombre normalizado" },
    moneda: { valor: payload.moneda, fuente: "solicitud" },
    condiciones_pago: { valor: payload.condiciones_pago, fuente: fuentePago },
    "aprobador.email": { valor: aprobacion.de, fuente: "aprobacion", nota: "Verificado contra maestro.centros-costo" },
    "aprobador.fecha_aprobacion": { valor: payload.aprobador.fecha_aprobacion, fuente: "aprobacion" },
    "aprobador.evidencia_sha256": { valor: evidenciaSha256, fuente: "derivado", nota: "sha256 de out/<caso>/aprobacion.txt" },
    "posiciones[0].numero": { valor: 10, fuente: "constante" },
    "posiciones[0].descripcion": { valor: descripcion, fuente: descripcion === solicitud.descripcion ? "solicitud" : "derivado", nota: descripcion === solicitud.descripcion ? undefined : `Texto breve SAP (máx. 40) de: "${solicitud.descripcion}"` },
    "posiciones[0].cantidad": { valor: solicitud.cantidad, fuente: "solicitud" },
    "posiciones[0].unidad": { valor: unidad, fuente: "derivado", nota: "Deducida de la descripción y del ítem de la cotización" },
    "posiciones[0].precio_unitario": { valor: solicitud.valor_unitario, fuente: "solicitud", nota: "IVA incluido, valor aprobado" },
    "posiciones[0].centro_costo": { valor: solicitud.centro_costo, fuente: "solicitud" },
    "posiciones[0].subarea": { valor: solicitud.subarea, fuente: "solicitud" },
    "posiciones[0].indicador_iva": { valor: derivados.indicador_iva, fuente: fuenteIva },
    excepciones: { valor: excepciones.map((e) => e.codigo), fuente: "derivado", nota: "Confirmaciones de oc_validar" },
  }
  return { payload, trazabilidad }
}

export async function guardarPayload(directory: string, caso: string, payload: OrdenCompra, trazabilidad: Trazabilidad): Promise<{ ruta_trazabilidad: string; ruta_payload: string }> {
  const ruta_trazabilidad = join(RUTA_OUT, caso, "trazabilidad.json")
  const ruta_payload = join(RUTA_OUT, caso, "payload.json")
  await escribirArchivo(join(directory, ruta_trazabilidad), JSON.stringify(trazabilidad, null, 2))
  await escribirArchivo(join(directory, ruta_payload), JSON.stringify(payload, null, 2))
  return { ruta_trazabilidad, ruta_payload }
}
