// The validation runner (development only): runs a list of outfits through the page as a person would (each
// store link added in turn, fitted, draped, checked against its photo), and keeps what each came out as, with
// small pictures to review. In the page at http://localhost:3000, from the console or a harness:
//
//   const VAL = (await import("/validation/runner.js")).default   // served from public/validation/
//   VAL.load(runs); VAL.start()                                   // runs: see script/validation/README.md
//   await VAL.wait(); VAL.export(0, 20)                            // results, pictures as JPEG data URLs
//
// A run: { key, body: "men" | "women", items: [{ handle, cat }] }, cat being what the sample says it is
// ("top", "outerwear", "bottom", "dress"). The checks a run gets are listed in check() below.
const VAL = window.__val = window.__val ?? { runs: [], results: {}, log: [], running: false, current: null }
const el = document.querySelector('[data-controller~="fitting-room"]')
const c = window.Stimulus.getControllerForElementAndIdentifier(el, "fitting-room")
const s = c.stage
VAL.c = c; VAL.s = s
const P = await import("lib/garments/print")

// The photo check runs once, its first reading kept (VAL.firstLook, on by default): a check that fails is tried
// again up to three times, each a new reading and a new drape, which in a hidden pane takes minutes. What the
// first check said is kept with the garment (look.ok, look.failed), so a run still shows where it would have
// been tried again.
VAL.firstLook ??= true
if (VAL.firstLook && !c.__firstLook) {
  c.__firstLook = true
  c.runLookCheck = async function (garment) {
    await this.lookReady()
    if (this.outfit.top?.garment !== garment) return
    garment.lookChecks = await this.lookResult(garment)
    garment.lookDone = true
    this.setLookWords(null)
  }
}

// Without the photo check at all (VAL.noLook): it takes a quarter of a run in a busy tab, and the grade looks at
// the photo anyway. Its result isn't kept then (look: null).
if (VAL.noLook && !c.__noLook) {
  c.__noLook = true
  c.runLookCheck = async function (garment) { garment.lookDone = true; this.setLookWords(null) }
}

// A hidden pane runs timers about once a second; the drape and the look check need them sooner.
if (!window.__fastTimers) {
  const realClear = window.clearTimeout.bind(window), realSet = window.setTimeout.bind(window)
  const timers = new Map(); let nextId = 1e7, pumping = false
  const ch = new MessageChannel()
  ch.port1.onmessage = () => {
    const now = performance.now()
    for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); try { t.fn(...t.args) } catch (e) { console.error(e) } }
    if (timers.size) ch.port2.postMessage(0); else pumping = false
  }
  window.setTimeout = (fn, ms = 0, ...args) => {
    if (typeof fn !== "function") return realSet(fn, ms, ...args)
    const id = nextId++
    timers.set(id, { fn, args, at: performance.now() + (Number(ms) || 0) })
    if (!pumping) { pumping = true; ch.port2.postMessage(0) }
    return id
  }
  window.clearTimeout = id => { if (timers.has(id)) timers.delete(id); else realClear(id) }
  window.requestAnimationFrame = cb => window.setTimeout(() => cb(performance.now()), 16)
  window.__fastTimers = true
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const say = line => { VAL.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`); if (VAL.log.length > 300) VAL.log.shift() }

function pump(ms = 2000) {
  const end = performance.now() + ms
  while (performance.now() < end && !s.settled) { s.animate?.(); s.controls?.update?.(); s.advanceDrape(); s.fitTuck?.(); s.wearBelt?.(); s.wearScarf?.(); s.wearCollars?.(); s.hideCovered?.() }
  s.advanceDrape(); s.finishFades?.(); s.wearBelt?.(); s.wearScarf?.(); s.wearCollars?.(); s.hideCovered?.(); s.draw()
}
async function settle(limit, look) {
  const t0 = performance.now(); let stable = 0
  while (performance.now() - t0 < limit) {
    pump()
    const lookDone = !look || (!c.lookRunning && (!c.lookWords || c.lookStuckOn))
    // Every garment's photo read (its colour, the pants' photo laid on), or a while gone by: until then the
    // 3D view shows the colour the listing's words guessed.
    const late = performance.now() - t0 > (VAL.readMs ?? 150000)
    const read = Object.entries(c.outfit).every(([kind, item]) => !item.garment.lookPending &&
      (!item.garment.photo || late || ("photoColor" in item.garment && (kind !== "trousers" || "photoMap" in item.garment))))
    const at = Math.round(performance.now() - t0), w = VAL.current?.waits
    if (w) { if (s.settled) w.drape ??= at; if (lookDone) w.look ??= at; if (read) w.read ??= at }
    stable = s.settled && lookDone && read ? stable + 1 : 0
    if (stable >= 2) return true
    await sleep(100)
  }
  return false
}

// A small JPEG of an image (a URL or a canvas), at most `most` px tall.
async function thumb(src, most = 240, quality = 0.72) {
  const image = src instanceof HTMLCanvasElement ? src : await P.loadImage(src).catch(() => null)
  if (!image) return null
  const w = image.naturalWidth ?? image.width, h = image.naturalHeight ?? image.height
  const k = Math.min(1, most / h)
  const cv = document.createElement("canvas")
  cv.width = Math.max(1, Math.round(w * k)); cv.height = Math.max(1, Math.round(h * k))
  const g = cv.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, cv.width, cv.height); g.drawImage(image, 0, 0, cv.width, cv.height)
  return cv.toDataURL("image/jpeg", quality)
}

// The figure from the front, the wearer's left and behind.
async function pictures() {
  const shot = async (angle, front) => {
    const facing = s.faceFront()
    try {
      if (angle) { s.turnCamera(angle); s.controls.update() }
      s.draw()
      const { image } = await s.photoPasses({ width: 200, height: 300, guides: false, front, record: false, close: true })
      return await thumb(URL.createObjectURL(image), 300)
    } finally { s.camera.position.copy(facing.position); s.controls.update(); s.draw() }
  }
  return { front: await shot(0, true), side: await shot(Math.PI / 2, false), back: await shot(Math.PI, false) }
}

const EXPECT = { top: ["top"], outerwear: ["jacket", "coat"], bottom: ["trousers"], dress: ["top"] }
const LONG = ["longsleeve", "sweatshirt", "hoodie", "shirt", "sweater", "cardigan", "rugby", "zip", "bomber", "coat", "tailored"]

// What an item came out as, and the automatic checks on it.
async function check(item, kind, slot) {
  const g = slot?.garment
  if (!g) return { ...item, error: "not added" }
  const out = {
    ...item, kind, style: g.style ?? null, fabric: g.fabric ?? null, women: Boolean(g.women), color: g.color, color_name: g.color_name ?? null,
    name: g.name, chart: g.chart ? { kind: g.chart.kind, sizes: g.chart.sizes.length, missing: g.chart.missing ?? [] } : null,
    cut: g.cut ? Object.fromEntries(Object.entries(g.cut).filter(([k]) => k !== "shape")) : null, shaped: Boolean(g.cut?.shape),
    best: slot.fit?.best ?? null, verdict: slot.fit?.sizes?.find(x => x.size === slot.fit?.best)?.verdict ?? null,
    colorRead: Boolean(g.photoColor), print: Boolean(g.print), allOver: Boolean(g.print?.tile), stripes: Boolean(g.print?.strip), backPrint: Boolean(g.backPrint),
    sleevePrint: Boolean(g.sleevePrint && Object.values(g.sleevePrint).some(s => s.front || s.back)), photoMap: g.photoMap ? true : g.photoMap === null ? false : null,
    look: g.lookChecks ? { ok: g.lookChecks.ok, failed: g.lookChecks.failed, stuck: c.lookStuckOn === g, shape: g.lookChecks.checks?.shape?.score ?? null } : null,
    checks: {}
  }
  // The kind it was sorted as against the sample's.
  out.checks.kind = EXPECT[item.cat].includes(kind) && (item.cat !== "dress" || /^dress/.test(g.style ?? "")) && (item.cat !== "top" || !/^dress/.test(g.style ?? ""))
  // Its photo read as a garment on its own (kind and sleeves), against what's drawn (VAL.photoChecks, on by
  // default: the reading takes a while in a busy tab, and the grade looks at the photo anyway).
  if (VAL.photoChecks !== false && g.photo && kind !== "trousers") {
    const guess = await P.readGarment(g.photo).catch(() => null)
    const shape = await P.readTopShape(g.photo).catch(() => null)
    out.photo = { kind: guess?.kind ?? null, style: guess?.style ?? null, sleeve: shape?.sleeve ?? null, sleeveDown: shape?.sleeveDown ?? null }
    const longInPhoto = shape?.sleeve >= 1.0 && shape?.sleeveDown >= 0.7
    const shortInPhoto = shape?.sleeve > 0 && shape.sleeve < 0.75
    const longDrawn = LONG.includes(g.style) || (g.style === "dress" && ["long"].includes(g.cut?.sleeves))
    out.checks.sleeves = !(longInPhoto && !longDrawn) && !(shortInPhoto && longDrawn && !["tank"].includes(g.style))
  }
  if (kind === "top" && g.photo) out.checks.look = Boolean(g.lookChecks?.ok)
  if (kind === "trousers" && g.photo) out.checks.photoRead = Boolean(g.photoMap)
  out.photoThumb = g.photo ? await thumb(g.photo, 200) : null
  return out
}

async function runOne(run) {
  const rec = VAL.current = { key: run.key, body: run.body, items: [], errors: [], began: Date.now(), t: {}, waits: {} }
  let mark = performance.now()
  const lap = name => { const now = performance.now(); rec.t[name] = Math.round(now - mark); mark = now }
  say(`${run.key}: start`)
  try {
    for (let i = 0; i < 8 && document.querySelector(".rail-remove"); i++) { document.querySelector(".rail-remove").click(); await sleep(50) }
    if (c.bodyType !== run.body) c.changeBodyType({ target: { value: run.body } })
    await settle(20000, false)
    lap("clear")
    const added = []
    for (const item of run.items) {
      const before = new Set(Object.values(c.outfit).map(x => x.garment))
      const t0 = performance.now()
      await c.importGarment({ url: `https://kith.com/products/${item.handle}` })
      const entry = Object.entries(c.outfit).find(([, x]) => !before.has(x.garment))
      if (!entry) { rec.items.push({ ...item, error: c.importErrorTarget.hidden ? "not added" : c.importErrorTarget.textContent.trim() }); continue }
      for (let k = 0; k < 150 && !c.outfit[entry[0]]?.fit; k++) await sleep(200)
      added.push({ item, kind: entry[0], garment: entry[1].garment, ms: Math.round(performance.now() - t0) })
    }
    // Back on the run's body (a women's piece moves the example body over).
    if (c.bodyType !== run.body && !added.some(a => a.garment.women)) c.changeBodyType({ target: { value: run.body } })
    lap("import")
    rec.waits = {}
    rec.settled = await settle(VAL.settleMs ?? 360000, !VAL.noLook)
    lap("settle")
    for (const a of added) {
      const slot = Object.values(c.outfit).find(x => x.garment === a.garment)
      // The outfit holds one garment of each kind: a later one of the same kind (a jacket filed under tops,
      // then the outerwear) took this one's place. That's the run's doing, not the app's.
      const later = !slot && added.find(b => b !== a && b.kind === a.kind && added.indexOf(b) > added.indexOf(a))
      if (later) { rec.items.push({ ...a.item, kind: a.kind, error: `replaced by ${later.item.handle} (both ${a.kind})`, importMs: a.ms, shown: false }); continue }
      rec.items.push({ ...(await check(a.item, a.kind, slot)), importMs: a.ms, shown: Boolean(slot) })
    }
    // Garments the outfit didn't keep (a second top swapped the first out).
    rec.notes = [...document.querySelectorAll(".rail-notes, .rail-note")].map(n => n.textContent.trim())
    lap("check")
    // The 3D view as the garments now are (a reading that finished after the last render).
    c.render()
    await settle(60000, false)
    rec.pics = await pictures()
    lap("pics")
  } catch (error) { rec.errors.push(`runner: ${error.message}`) }
  rec.ms = Date.now() - rec.began
  VAL.results[run.key] = rec
  VAL.current = null
  say(`${run.key}: done in ${Math.round(rec.ms / 1000)} s${rec.errors.length ? `, ${rec.errors.join("; ")}` : ""}`)
}

VAL.load = runs => { VAL.runs.push(...runs); return VAL.runs.length }
VAL.start = async () => {
  if (VAL.running) return "already running"
  VAL.running = true
  try { while (VAL.runs.length) { const run = VAL.runs.shift(); if (!VAL.results[run.key]) await runOne(run) } } finally { VAL.running = false; say("queue empty") }
}
VAL.wait = async (ms = 30000) => { const end = Date.now() + ms; while (VAL.running && Date.now() < end) await sleep(1000); return { left: VAL.runs.length, done: Object.keys(VAL.results).length, log: VAL.log.slice(-3) } }
// The results of runs `from` to `to` (in the order they finished), with or without their pictures.
VAL.export = (from = 0, to = Infinity, { pics = true } = {}) => JSON.stringify(Object.values(VAL.results).slice(from, to).map(r => pics ? r : { ...r, pics: undefined, items: r.items.map(i => ({ ...i, photoThumb: undefined })) }))
export default VAL
