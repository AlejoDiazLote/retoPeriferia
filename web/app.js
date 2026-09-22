const $ = (id) => document.getElementById(id)
const CASOS = [
  ["sol-001", "Flujo normal"],
  ["sol-002", "Proveedor inexistente"],
  ["sol-003", "Aprobador sin autoridad"],
  ["sol-004", "Cotización ≠ solicitud"],
  ["sol-005", "Factura retroactiva"],
  ["sol-006", "IVA no informado"],
]

let sessionId = localStorageGet("sessionId")
let accessKey = localStorageGet("accessKey") || ""
let ocupado = false

function localStorageGet(k) { try { return localStorage.getItem(k) } catch { return null } }
function localStorageSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v) } catch {} }

function md(texto) {
  const html = window.marked ? marked.parse(texto || "") : (texto || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c])
  return window.DOMPurify ? DOMPurify.sanitize(html) : html
}

function escapar(t) { return String(t).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]) }

/** Deja la pregunta arriba y la respuesta completa debajo; lo anterior sube. */
function enfocarTurno(ancla) {
  const m = $("mensajes")
  if (!ancla) {
    m.scrollTop = m.scrollHeight
    return
  }
  const arriba = ancla.getBoundingClientRect().top - m.getBoundingClientRect().top + m.scrollTop
  m.scrollTo({ top: Math.max(0, arriba - 16), behavior: "smooth" })
}

function ultimoUsuario() {
  const usuarios = $("mensajes").querySelectorAll(".msg.usuario")
  return usuarios[usuarios.length - 1] || null
}

function quitarBienvenida() { document.querySelector(".bienvenida")?.remove() }

function agregarUsuario(texto, enfocar = true) {
  quitarBienvenida()
  const div = document.createElement("div")
  div.className = "msg usuario"
  div.textContent = texto
  $("mensajes").appendChild(div)
  if (enfocar) enfocarTurno(div)
}

function renderTool(t) {
  const d = document.createElement("details")
  d.className = "tool"
  d.innerHTML = `<summary><span class="${t.ok ? "ok" : "fallo"}">${t.ok ? "✓" : "✗"}</span><span class="nombre">${escapar(t.nombre)}</span><span class="tenue">${escapar(JSON.stringify(t.argumentos))}</span><span class="resumen">${escapar(t.resumen)}</span></summary>
  <pre>${escapar(JSON.stringify({ argumentos: t.argumentos, resultado: t.resultado }, null, 2))}</pre>`
  return d
}

function agregarAsistente({ reply, texto, toolCalls = [], needsConfirmation, error }, enfocar = true) {
  quitarBienvenida()
  const div = document.createElement("div")
  div.className = `msg asistente${needsConfirmation ? " pide" : ""}${error ? " error" : ""}`
  if (toolCalls.length) {
    const cont = document.createElement("div")
    cont.className = "herramientas"
    toolCalls.forEach((t) => cont.appendChild(renderTool(t)))
    div.appendChild(cont)
  }
  if (needsConfirmation) {
    const et = document.createElement("span")
    et.className = "etiqueta-conf"
    et.textContent = "⚠️ Requiere tu confirmación"
    div.appendChild(et)
  }
  const cuerpo = document.createElement("div")
  cuerpo.innerHTML = md(reply ?? texto)
  div.appendChild(cuerpo)
  $("mensajes").appendChild(div)
  $("confirmar").classList.toggle("oculto", !needsConfirmation)
  if (enfocar) enfocarTurno(ultimoUsuario() || div)
}

function pensando(mostrar) {
  document.querySelector(".pensando")?.remove()
  if (!mostrar) return
  const div = document.createElement("div")
  div.className = "pensando"
  div.textContent = "El agente está pensando y usando herramientas…"
  $("mensajes").appendChild(div)
  enfocarTurno(ultimoUsuario() || div)
}

async function api(ruta, opciones = {}) {
  const r = await fetch(ruta, { ...opciones, headers: { "content-type": "application/json", "x-access-key": accessKey, ...(opciones.headers || {}) } })
  if (r.status === 401) {
    accessKey = prompt("Este agente está protegido. Ingresa la clave de acceso:") || ""
    localStorageSet("accessKey", accessKey)
    if (accessKey) return api(ruta, opciones)
  }
  const datos = await r.json().catch(() => ({ error: `Error HTTP ${r.status}` }))
  if (!r.ok) throw new Error(datos.error || `Error HTTP ${r.status}`)
  return datos
}

async function enviar(texto) {
  if (ocupado || !texto.trim()) return
  ocupado = true
  $("enviar").disabled = true
  $("confirmar").classList.add("oculto")
  agregarUsuario(texto)
  pensando(true)
  try {
    const r = await api("/api/chat", { method: "POST", body: JSON.stringify({ ...(sessionId ? { sessionId } : {}), message: texto }) })
    sessionId = r.sessionId
    localStorageSet("sessionId", sessionId)
    pensando(false)
    agregarAsistente(r)
  } catch (e) {
    pensando(false)
    agregarAsistente({ reply: `⚠️ ${e.message}`, error: true })
  } finally {
    ocupado = false
    $("enviar").disabled = false
    $("texto").focus()
  }
}

async function cargarHistorial() {
  if (!sessionId) return
  try {
    const s = await api(`/api/sessions/${sessionId}`)
    s.historial.forEach((e) => (e.rol === "usuario" ? agregarUsuario(e.texto, false) : agregarAsistente(e, false)))
    enfocarTurno(ultimoUsuario())
  } catch {
    sessionId = null
    localStorageSet("sessionId", null)
  }
}

function iniciar() {
  const casos = $("casos")
  CASOS.forEach(([id, nombre]) => {
    const b = document.createElement("button")
    b.innerHTML = `${id}<small>${nombre}</small>`
    b.onclick = () => enviar(`Procesa la solicitud ${id}`)
    casos.appendChild(b)
  })
  document.querySelectorAll(".ejemplo").forEach((b) => (b.onclick = () => enviar(b.textContent)))
  $("form").onsubmit = (e) => { e.preventDefault(); const t = $("texto").value; $("texto").value = ""; enviar(t) }
  $("texto").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("form").requestSubmit() } })
  $("btnSi").onclick = () => enviar("Confirmo, crea la OC.")
  $("btnNo").onclick = () => enviar("No, no crees la OC.")
  $("nueva").onclick = () => { sessionId = null; localStorageSet("sessionId", null); location.reload() }
  fetch("/api/health").then((r) => r.json()).then((h) => ($("modelo").textContent = `${h.provider} · ${h.model}`)).catch(() => {})
  cargarHistorial()
}

iniciar()
