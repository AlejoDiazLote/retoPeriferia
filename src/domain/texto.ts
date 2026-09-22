/** Utilidades puras de normalización y parseo de los adjuntos en texto. */

export function soloDigitos(valor: string): string {
  return valor.replace(/\D/g, "")
}

/** "900.555.111-2" → "900555111" (se descarta el dígito de verificación). */
export function normalizarNit(valor: string | null | undefined): string | null {
  if (!valor) return null
  const base = valor.includes("-") ? valor.split("-")[0] ?? "" : valor
  const digitos = soloDigitos(base)
  return digitos.length > 0 ? digitos : null
}

/** Minúsculas, sin tildes, sin puntuación ni espacios repetidos: "TecnoSuministros S.A.S." → "tecnosuministros sas". */
export function normalizarNombre(valor: string): string {
  return valor
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

/** "COP 11.400.000" → 11400000. Formato colombiano: punto de miles, coma decimal. */
export function parsearMonto(valor: string): number | null {
  const limpio = valor.replace(/[^\d.,]/g, "").replace(/\./g, "").replace(",", ".")
  if (limpio === "") return null
  const numero = Number(limpio)
  return Number.isFinite(numero) ? numero : null
}

export function campo(texto: string, etiqueta: RegExp): string | null {
  const match = texto.match(etiqueta)
  return match?.[1]?.trim() ?? null
}

/** Fecha calendario (AAAA-MM-DD) en hora de Colombia, aunque venga con zona horaria. */
export function fechaCalendario(valor: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(valor)) return valor
  const fecha = new Date(valor)
  if (Number.isNaN(fecha.getTime())) return valor.slice(0, 10)
  return fecha.toLocaleDateString("en-CA", { timeZone: "America/Bogota" })
}

export function sumarDias(fecha: string, dias: number): string {
  const base = new Date(`${fecha}T00:00:00Z`)
  base.setUTCDate(base.getUTCDate() + dias)
  return base.toISOString().slice(0, 10)
}

/** Recorta a `max` caracteres sin partir palabras. */
export function textoBreve(valor: string, max: number): string {
  if (valor.length <= max) return valor
  const corte = valor.slice(0, max + 1)
  const ultimoEspacio = corte.lastIndexOf(" ")
  const recorte = ultimoEspacio > max / 2 ? corte.slice(0, ultimoEspacio) : valor.slice(0, max)
  return recorte.replace(/(\s+(de|del|la|el|los|las|para|con|y|en|a))+$/i, "").replace(/[\s,.;:]+$/, "")
}

export function formatoCop(valor: number): string {
  return `COP ${valor.toLocaleString("es-CO")}`
}
