/**
 * Genera modulo/agent.md y modulo/skill/ordenes-compra/SKILL.md a partir de las mismas
 * fuentes que usa la aplicación (agent/prompt.md y src/knowledge/ordenes-compra.md).
 * modulo/tools/oc.ts reexporta src/tools/oc.ts, así que no hay copias divergentes.
 * Uso: bun run scripts/build-modulo.ts            (genera)
 *      bun run scripts/build-modulo.ts --check    (falla si el módulo está desactualizado)
 */
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"

const prompt = (await readFile("agent/prompt.md", "utf8")).trim()
const conocimiento = (await readFile("src/knowledge/ordenes-compra.md", "utf8")).trim()

const salidas: Record<string, string> = {
  "modulo/agent.md": `---
description: Agente que lee paquetes de solicitud de compra, los valida contra maestros (RC1–RC10), construye la OC y la crea en SAP con confirmación humana para las excepciones.
mode: primary
permission:
  edit: deny
  bash: deny
---

${prompt}
`,
  "modulo/skill/ordenes-compra/SKILL.md": `---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra SAP de Periferia — reglas de control RC1–RC10, criterios de negocio (valor aprobado, IVA incluido, texto breve de 40 caracteres, OC retroactivas) y acciones sugeridas ante bloqueos.
---

${conocimiento}
`,
}

const check = process.argv.includes("--check")
let desactualizado = false
for (const [ruta, contenido] of Object.entries(salidas)) {
  const actual = await readFile(ruta, "utf8").catch(() => "")
  if (actual === contenido) continue
  desactualizado = true
  if (!check) {
    await mkdir(dirname(ruta), { recursive: true })
    await writeFile(ruta, contenido)
    console.log(`generado ${ruta}`)
  } else console.error(`desactualizado: ${ruta}`)
}
if (check && desactualizado) process.exit(1)
if (!desactualizado) console.log("modulo/ al día")
