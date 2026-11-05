// The cloth solver's inner loops in WebAssembly (script/wasm/cloth.c, built into cloth_wasm.js): Drape keeps
// its points and constraints in the module's memory, as typed arrays looking into it, so the JavaScript
// that does the rest (seams, waistbands, cuffs on the arms, pants off the feet) works on the same arrays
// with nothing copied, and the loops that take most of a step (moving the points, holding the threads and
// bends, cloth off itself and off the skin) run there, the same arithmetic in the same order, about twice
// as fast. Where WebAssembly isn't there, or the page's address says ?wasm=off, Drape does it all in
// JavaScript as before.
import { CLOTH_WASM } from "lib/garments/cloth_wasm"

function decode(base64) {
  const text = atob(base64)
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i)
  return bytes
}

// Compiled once (it's under 4 KB, so a page may compile it at once on its main thread).
let MODULE = null
try { if (typeof WebAssembly !== "undefined") MODULE = new WebAssembly.Module(decode(CLOTH_WASM)) } catch { MODULE = null }

export const KERNEL_ON = Boolean(MODULE) && (typeof location === "undefined" || new URLSearchParams(location.search).get("wasm") !== "off")

// The hashed grid's buckets for cloth touching itself (as Drape#selfCollide's).
const HASH = 1 << 16
const PAGE = 65536
// The most ellipsoids a field may have to be looked up here (the hands' and the head's, a few).
const MAX_ELLIPSOIDS = 16

// What Drape keeps in the module's memory: [property, array type, length from the drape].
const LAYOUT = [
  ["x", Float32Array, d => d.x.length], ["p", Float32Array, d => d.p.length], ["v", Float32Array, d => d.v.length],
  ["w", Float32Array, d => d.w.length], ["clear", Float32Array, d => d.w.length],
  ["edges", Int32Array, d => d.edges.length], ["rest", Float32Array, d => d.rest.length], ["edgeRib", Uint8Array, d => d.edgeRib.length],
  ["bends", Int32Array, d => d.bends.length], ["bendRest", Float32Array, d => d.bendRest.length], ["bendHem", Uint8Array, d => d.bendHem.length],
  ["neighbourStart", Int32Array, d => d.neighbourStart.length], ["neighbours", Int32Array, d => d.neighbours.length],
  ["hashHead", Int32Array, () => HASH], ["hashNext", Int32Array, d => d.w.length]
]

export class ClothKernel {
  // Moves the drape's arrays into a module of its own (each drape has its own memory, so one growing
  // doesn't move another's arrays).
  constructor(drape) {
    this.drape = drape
    this.instance = new WebAssembly.Instance(MODULE, {})
    this.fn = this.instance.exports
    this.memory = this.fn.memory
    let at = align(this.fn.heap_base())
    this.slots = LAYOUT.map(([name, Type, length]) => {
      const count = length(drape)
      const slot = { name, Type, count, at }
      at = align(at + count * Type.BYTES_PER_ELEMENT)
      return slot
    })
    this.fieldAt = at
    this.fieldBytes = 0
    this.field = null
    this.reserve(at)
    const old = Object.fromEntries(this.slots.map(s => [s.name, drape[s.name]]))
    this.views()
    for (const s of this.slots) if (old[s.name]) drape[s.name].set(old[s.name].subarray(0, s.count))
    // (The clear distances start at nothing: every point is looked up the first step, as Drape does.)
    drape.clearField = null
  }

  reserve(bytes) {
    const have = this.memory.buffer.byteLength
    if (bytes > have) this.memory.grow(Math.ceil((bytes - have) / PAGE))
  }

  // The drape's arrays as views into the memory (again after it grows: the old views are emptied then).
  views() {
    const buffer = this.memory.buffer
    for (const s of this.slots) this.drape[s.name] = new s.Type(buffer, s.at, s.count)
    this.ptr = Object.fromEntries(this.slots.map(s => [s.name, s.at]))
    if (this.field) this.fieldViews()
  }

  fieldViews() {
    const buffer = this.memory.buffer, f = this.fieldLayout
    this.D = new Float32Array(buffer, f.D, f.count)
    this.M = new Int8Array(buffer, f.M, 3 * f.count)
    this.dims = new Int32Array(buffer, f.dims, 3)
    this.frame = new Float64Array(buffer, f.frame, 5)
    this.ell = new Float64Array(buffer, f.ell, 6 * MAX_ELLIPSOIDS)
  }

  // Whether the skin's field can be looked up here: a grid (with any ellipsoids added to it).
  static gridded(field) {
    return Boolean(field?.distance && field.normal && field.dims && (field.ellipsoids?.length ?? 0) <= MAX_ELLIPSOIDS)
  }

  // The drape's skin field copied in when it's a new one (a new pose or body). Call before taking the drape's
  // arrays for a step: growing the memory for a bigger field empties the old views (they're made again).
  sync() {
    const field = this.drape.field
    if (field === this.field || !ClothKernel.gridded(field)) return
    const count = field.distance.length
    const D = align(this.fieldAt), M = align(D + 4 * count), dims = align(M + 3 * count), frame = align(dims + 12), ell = align(frame + 40)
    const end = ell + 48 * MAX_ELLIPSOIDS
    if (end > this.memory.buffer.byteLength) {
      // With room for a somewhat bigger field next time, so it grows rarely.
      this.reserve(this.fieldAt + Math.ceil((end - this.fieldAt) * 1.25))
      this.field = null
      this.views()
    }
    this.field = field
    this.fieldLayout = { count, D, M, dims, frame, ell, ells: field.ellipsoids?.length ?? 0 }
    this.fieldViews()
    this.D.set(field.distance)
    this.M.set(field.normal)
    this.dims.set(field.dims)
    this.frame.set([field.min[0], field.min[1], field.min[2], field.cell, field.band])
    ;(field.ellipsoids ?? []).forEach(({ centre, radii }, k) => this.ell.set([...centre, ...radii], 6 * k))
  }

  get hasField() { return this.field !== null && this.field === this.drape.field }

  predict(n, h, fall) { this.fn.predict(this.ptr.x, this.ptr.v, this.ptr.p, n, h, fall) }

  solveEdges(compliance, ribCompliance, squeeze) {
    this.fn.solve(this.ptr.p, this.ptr.w, this.ptr.edges, this.ptr.rest, this.drape.rest.length, compliance, ribCompliance, this.ptr.edgeRib, squeeze)
  }

  solveBends(compliance, hemCompliance) {
    this.fn.solve(this.ptr.p, this.ptr.w, this.ptr.bends, this.ptr.bendRest, this.drape.bendRest.length, compliance, hemCompliance, this.ptr.bendHem, 1)
  }

  selfCollide(n, radius) {
    this.fn.self_collide(this.ptr.p, n, radius, this.ptr.hashHead, HASH, this.ptr.hashNext, this.ptr.neighbourStart, this.ptr.neighbours)
  }

  collideSkin(n, thick, keep, margin) {
    const f = this.fieldLayout
    this.fn.collide_skin(this.ptr.p, this.ptr.x, this.ptr.clear, n, thick, keep, margin, f.D, f.M, f.dims, f.frame, f.ell, f.ells)
  }

  finish(n3, h, drag, still) { this.fn.finish(this.ptr.x, this.ptr.v, this.ptr.p, n3, h, drag, still ? 1 : 0) }
}

function align(at) { return (at + 15) & ~15 }
