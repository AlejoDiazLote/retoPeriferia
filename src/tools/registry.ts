import { join } from "node:path"
import { z } from "zod"
import { RUTA_OUT, agregarLinea } from "../domain/fs.ts"
import * as oc from "./oc.ts"
import type { ToolContext } from "./oc.ts"

/** Forma común de una herramienta: description + args (zod) + execute. */
export type Herramienta = {
  description: string
  args: z.ZodRawShape
  execute(args: never, ctx: ToolContext): Promise<string>
}

export type HerramientaSpec = { nombre: string; descripcion: string; esquema: Record<string, unknown> }

/** Nombre visible para el modelo: <archivo>_<export>. */
const MODULOS: Record<string, Record<string, Herramienta>> = { oc }

export const HERRAMIENTAS: Record<string, Herramienta> = Object.fromEntries(
  Object.entries(MODULOS).flatMap(([archivo, exports]) =>
    Object.entries(exports)
      .filter(([, valor]) => typeof valor === "object" && valor !== null && "execute" in valor)
      .map(([nombre, herramienta]) => [`${archivo}_${nombre}`, herramienta]),
  ),
)

export function especificaciones(): HerramientaSpec[] {
  return Object.entries(HERRAMIENTAS).map(([nombre, h]) => ({
    nombre,
    descripcion: h.description,
    esquema: z.toJSONSchema(z.object(h.args), { io: "input", unrepresentable: "any" }) as Record<string, unknown>,
  }))
}

/** Valida los argumentos con zod y ejecuta. Nunca lanza; registra en out/log.jsonl. */
export async function ejecutarHerramienta(nombre: string, argumentos: unknown, ctx: ToolContext): Promise<string> {
  const inicio = Date.now()
  const herramienta = HERRAMIENTAS[nombre]
  let resultado: string
  if (!herramienta) {
    resultado = JSON.stringify({ ok: false, error: `Herramienta desconocida: ${nombre}` })
  } else {
    const parseo = z.object(herramienta.args).safeParse(argumentos ?? {})
    resultado = parseo.success
      ? await herramienta.execute(parseo.data as never, ctx)
      : JSON.stringify({ ok: false, error: `Argumentos inválidos: ${parseo.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` })
  }
  await agregarLinea(join(ctx.directory, RUTA_OUT, "log.jsonl"), JSON.stringify({
    ts: new Date().toISOString(),
    sessionId: ctx.sessionId,
    herramienta: nombre,
    argumentos,
    ok: (JSON.parse(resultado) as { ok: boolean }).ok,
    ms: Date.now() - inicio,
    resultado: JSON.parse(resultado) as unknown,
  })).catch(() => undefined)
  return resultado
}
