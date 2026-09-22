/**
 * Herramientas del agente, importables sin el servidor HTTP.
 * Es el mismo módulo que usa la aplicación (src/tools/oc.ts), no una copia.
 * Cada export sigue el contrato { description, args (zod), execute(args, ctx) → string JSON }.
 */
export * from "../../src/tools/oc.ts"
