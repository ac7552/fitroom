// The drape in a Web Worker, from the page's side (the worker's side is drape_worker.js). A worker can't use
// the page's import map, so it's started with a small loader that fetches each module the drape needs (by the
// map's URLs), points its imports at the others, and runs them from blob URLs. Nothing leaves the device: the
// modules come from this site, and the cloth and the body stay in the browser.
//
//   const remote = RemoteDrape.start()       // null where workers aren't there (remote.ready once they've loaded)
//   const job = remote.sew(id, { item, body, over, egg, measures, arms })
//   job.x (the newest points, or null once taken), job.sewn, job.frames, job.phase
//   const step = remote.pose(id, { posed, before, now, bottom, last, long })   // step.done, step.x, step.field
//   remote.drop(id)
import { SkinField } from "lib/garments/body"

// How many workers: one for each garment draped at once (pants and a top; a jacket waits for both).
const WORKERS = 2

const LOADER = `
const cache = new Map()
const IMPORT = /(\\bimport\\s*(?:[\\w*{}\\s,]+?\\s*from\\s*)?|\\bexport\\s*(?:\\*(?:\\s+as\\s+\\w+)?|\\{[^}]*\\})\\s*from\\s*)(["'])([^"']+)\\2/g
function resolve(spec, from, map, base) {
  if (map[spec]) return new URL(map[spec], base).href
  if (/^(\\.|\\/|https?:)/.test(spec)) return new URL(spec, from).href
  const prefix = Object.keys(map).filter(key => key.endsWith("/") && spec.startsWith(key)).sort((a, b) => b.length - a.length)[0]
  return prefix ? new URL(map[prefix] + spec.slice(prefix.length), base).href : null
}
function load(url, map, base) {
  if (!cache.has(url)) cache.set(url, (async () => {
    const response = await fetch(url)
    if (!response.ok) throw new Error("couldn't load " + url)
    const text = await response.text()
    const specs = new Set()
    for (const m of text.matchAll(IMPORT)) specs.add(m[3])
    const blobs = {}
    for (const spec of specs) {
      const target = resolve(spec, url, map, base)
      if (target) blobs[spec] = await load(target, map, base)
    }
    const code = text.replace(IMPORT, (all, head, quote, spec) => blobs[spec] ? head + quote + blobs[spec] + quote : all)
    return URL.createObjectURL(new Blob([code], { type: "text/javascript" }))
  })())
  return cache.get(url)
}
let module = null
const waiting = []
const post = (message, transfer = []) => self.postMessage(message, transfer)
self.onmessage = async event => {
  const message = event.data
  if (message.type === "boot") {
    try {
      const url = await load(resolve(message.entry, message.base, message.map, message.base), message.map, message.base)
      module = await import(url)
      post({ type: "ready" })
      for (const m of waiting.splice(0)) module.handle(m, post)
    } catch (error) {
      post({ type: "failed", error: String(error && error.message || error) })
    }
    return
  }
  if (module) module.handle(message, post); else waiting.push(message)
}
`

export class RemoteDrape {
  // Workers running the drape (one a garment at a time: pants being posed and the top over them being sewn
  // go on side by side), or null where there's no Worker or import map to start them from.
  static start(count = WORKERS) {
    if (typeof Worker === "undefined") return null
    const script = document.querySelector('script[type="importmap"]')
    if (!script) return null
    const map = JSON.parse(script.textContent).imports ?? {}
    if (!map["lib/garments/drape_worker"] && !map["lib/"]) return null
    const url = URL.createObjectURL(new Blob([LOADER], { type: "text/javascript" }))
    const workers = Array.from({ length: count }, () => new Worker(url, { type: "module" }))
    return new RemoteDrape(workers, map)
  }

  constructor(workers, map) {
    this.workers = workers
    this.jobs = new Map()
    this.steps = new Map()
    this.failed = null
    this.started = 0
    for (const worker of workers) {
      worker.onmessage = event => this.receive(event.data)
      worker.onerror = event => this.fail(event.message || "the drape worker stopped")
      worker.postMessage({ type: "boot", entry: "lib/garments/drape_worker", map, base: location.href })
    }
  }

  get ready() {
    return this.started === this.workers.length
  }

  receive(message) {
    if (message.type === "ready") { this.started++; return }
    if (message.type === "failed") { this.fail(message.error); return }
    const step = this.steps.get(message.id)
    const job = this.jobs.get(message.id)
    if (message.type === "error") {
      console.warn("[drape] worker:", message.error)
      if (job) job.failed = true
      if (step) step.failed = true
      return
    }
    if (message.type === "progress") {
      if (step) { step.x = message.x; step.frame = message.frame }
      else if (job) Object.assign(job, { x: message.x, frames: message.frames, phase: message.phase, frame: message.frame })
    } else if (message.type === "sewn" && job) {
      Object.assign(job, { x: message.x, frames: message.frames, frame: message.frame, sewn: true })
    } else if (message.type === "posed" && step) {
      Object.assign(step, { x: message.x, frame: message.frame, field: fieldFrom(message.field), done: true })
      this.steps.delete(message.id)
    }
  }

  // The worker couldn't start or stopped: what's being sewn there is sewn on the page instead.
  fail(error) {
    this.failed = error
    console.warn("[drape] worker:", error)
    for (const job of this.jobs.values()) job.failed = true
  }

  // A garment to sew, on the worker with the fewest garments; it's posed there later too.
  sew(id, spec) {
    const load = this.workers.map(() => 0)
    for (const job of this.jobs.values()) load[job.worker]++
    const worker = load.indexOf(Math.min(...load))
    const job = { id, worker, x: null, frames: 0, phase: "sewing", frame: 0, sewn: false, started: performance.now() }
    this.jobs.set(id, job)
    this.workers[worker].postMessage({ type: "sew", id, ...spec })
    return job
  }

  pose(id, spec) {
    const step = { id, x: null, frame: 0, field: null, done: false }
    this.steps.set(id, step)
    this.workers[this.jobs.get(id)?.worker ?? 0].postMessage({ type: "pose", id, ...spec })
    return step
  }

  drop(id) {
    const worker = this.jobs.get(id)?.worker ?? 0
    this.jobs.delete(id)
    this.steps.delete(id)
    this.workers[worker].postMessage({ type: "drop", id })
  }

  stop() {
    for (const worker of this.workers) worker.terminate()
  }
}

// A collision field sent from the worker (drape_worker.js's fieldData), as a SkinField again.
export function fieldFrom(data) {
  if (!data) return null
  const field = Object.assign(Object.create(SkinField.prototype), {
    cell: data.cell, band: data.band, min: data.min, dims: data.dims, distance: data.distance, normal: data.normal,
    ellipsoids: data.ellipsoids ?? [], hit: new Float32Array(3)
  })
  const layers = fieldFrom(data.layers)
  if (layers) field.layers = layers
  return field
}

// A collision field (body.js's SkinField) as plain data, to send to the page, which rebuilds it with
// fieldFrom (the field's own layers too).
export function fieldData(field) {
  if (!field) return null
  const { cell, band, min, dims, distance, normal, ellipsoids } = field
  return { cell, band, min, dims, distance, normal, ellipsoids, layers: fieldData(field.layers) }
}
