/**
 * Verificación sin modelo: procesa los 6 casos llamando directamente a las herramientas.
 * Uso: bun install && bun run demo.ts
 */
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { crear, construir_payload, leer_paquete, listar_casos, validar } from "./src/tools/oc.ts"
import type { ToolContext } from "./src/tools/oc.ts"

type Hallazgo = { codigo: string; regla: string; detalle: string }
type Respuesta<T> = { ok: true; data: T } | { ok: false; error: string; [k: string]: unknown }
type DatosValidacion = { solicitud_id: string; apta: boolean; bloqueos: Hallazgo[]; confirmaciones: Hallazgo[]; retroactiva: boolean; derivados: { notas: string[] } }
type DatosCrear = { numero_oc: string; idempotente: boolean; evidencia?: { ruta: string; ruta_pdf: string } }

const directory = process.cwd()
const ctx: ToolContext = { directory, sessionId: "demo" }

const parse = <T,>(s: string): Respuesta<T> => JSON.parse(s) as Respuesta<T>
const lista = (h: Hallazgo[]): string => (h.length ? h.map((x) => `${x.regla} ${x.codigo}`).join(", ") : "—")

async function crearCaso(caso: string, confirmado?: boolean): Promise<string> {
  const r = parse<DatosCrear>(await crear.execute({ caso, confirmado }, ctx))
  if (r.ok) return `OC ${r.data.numero_oc}${r.data.idempotente ? " (idempotente: ya existía)" : ""}${r.data.evidencia ? ` · evidencia ${r.data.evidencia.ruta_pdf}` : ""}`
  return `NO CREADA · ${r.error}`
}

async function procesar(caso: string): Promise<void> {
  const paquete = parse<{ faltantes: string[] }>(await leer_paquete.execute({ caso }, ctx))
  if (!paquete.ok) return void console.log(`\n■ ${caso}: error de lectura · ${paquete.error}`)
  const v = parse<DatosValidacion>(await validar.execute({ caso }, ctx))
  if (!v.ok) return void console.log(`\n■ ${caso}: error de validación · ${v.error}`)
  const d = v.data
  console.log(`\n■ ${caso} (${d.solicitud_id})`)
  console.log(`  apta: ${d.apta} · retroactiva: ${d.retroactiva}`)
  console.log(`  bloqueos: ${lista(d.bloqueos)}`)
  for (const b of d.bloqueos) console.log(`    - ${b.detalle}`)
  console.log(`  confirmaciones: ${lista(d.confirmaciones)}`)
  for (const c of d.confirmaciones) console.log(`    - ${c.detalle}`)
  for (const n of d.derivados.notas) console.log(`  derivado: ${n}`)
  if (d.apta) {
    const p = parse<{ payload: { posiciones: { descripcion: string; unidad: string; indicador_iva: string }[]; condiciones_pago: string } }>(await construir_payload.execute({ caso }, ctx))
    if (p.ok) {
      const pos = p.data.payload.posiciones[0]
      console.log(`  payload: "${pos?.descripcion}" · ${pos?.unidad} · IVA ${pos?.indicador_iva} · pago ${p.data.payload.condiciones_pago}`)
    }
  }
  console.log(`  resultado: ${await crearCaso(caso)}`)
}

async function main(): Promise<void> {
  await rm(join(directory, "out"), { recursive: true, force: true })
  const casos = parse<{ casos: string[] }>(await listar_casos.execute({}, ctx))
  if (!casos.ok) throw new Error(casos.error)

  console.log("═══ 1. Procesamiento de los casos (sin confirmar) ═══")
  for (const caso of casos.data.casos) await procesar(caso)

  console.log("\n═══ 2. Idempotencia: sol-001 por segunda vez ═══")
  console.log(`  ${await crearCaso("sol-001")}`)

  console.log("\n═══ 3. Confirmación explícita del usuario ═══")
  for (const caso of ["sol-004", "sol-005", "sol-006"]) console.log(`  ${caso} con confirmado=true → ${await crearCaso(caso, true)}`)

  console.log("\n═══ 4. Casos bloqueados no se pueden forzar ═══")
  console.log(`  sol-002 con confirmado=true → ${await crearCaso("sol-002", true)}`)

  console.log("\nSalidas: out/sap/ordenes.jsonl · out/control.csv · out/<caso>/{aprobacion.txt,aprobacion.pdf,payload.json,trazabilidad.json}")
}

await main()
