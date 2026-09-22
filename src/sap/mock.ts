import { join } from "node:path"
import { RUTA_OUT, agregarLinea, leerTextoOpcional } from "../domain/fs.ts"
import { cargarMaestros } from "../domain/maestros.ts"
import { normalizarNit } from "../domain/texto.ts"
import type { OrdenCompra, SapAdapter } from "./adapter.ts"

const PRIMER_NUMERO = 4500000001

type Registro = { numero_oc: string; fecha: string; orden: OrdenCompra }

/** SAP simulado: persiste en out/sap/ordenes.jsonl. Las escrituras se serializan para mantener el consecutivo. */
export class SapMock implements SapAdapter {
  private cola: Promise<unknown> = Promise.resolve()

  constructor(private readonly directory: string) {}

  private get ruta(): string {
    return join(this.directory, RUTA_OUT, "sap", "ordenes.jsonl")
  }

  private async registros(): Promise<Registro[]> {
    const contenido = (await leerTextoOpcional(this.ruta)) ?? ""
    return contenido.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Registro)
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const { proveedores } = await cargarMaestros(this.directory)
    const p = proveedores.find((x) => normalizarNit(x.nit) === normalizarNit(nit))
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null> {
    const r = (await this.registros()).find((x) => x.orden.referencia.solicitud_id === solicitud_id)
    return r ? { numero_oc: r.numero_oc } : null
  }

  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    const tarea = this.cola.then(async () => {
      const existentes = await this.registros()
      const numero_oc = String(PRIMER_NUMERO + existentes.length)
      const fecha = new Date().toISOString()
      await agregarLinea(this.ruta, JSON.stringify({ numero_oc, fecha, orden } satisfies Registro))
      return { numero_oc, fecha }
    })
    this.cola = tarea.catch(() => undefined)
    return tarea
  }
}
