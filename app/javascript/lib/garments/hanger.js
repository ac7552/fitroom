// The garment hanging as a store photographs it (see redrape.js, which lays the store's photos on it by
// this shape), in a module of its own so the drape worker can run it too (drape_worker.js's "hang").
import { Drape } from "lib/garments/drape"

// Frames the hanger drape runs at most (it stops when still). In the worker, 400 frames of a 6,000-point
// top take about five seconds; fewer (240) shifted a flannel's sleeve on its photo enough to fail a check.
const HANGER_FRAMES = 400

// The garment hanging as a store photographs it: from the body drape's rest shape (restX: the sewn garment
// in the sewing pose, by simulated point), held at its shoulder seams and neck, let fall with no body under
// it until still. Run a few milliseconds at a time (advance), so the page keeps drawing; `positions` are the
// hanging positions by simulated point (the same points as the body drape's) once `done`.
//
// flat: { angle } lays it flat instead, as a shop photographs a garment laid out on a table: its sleeves turned
// out to `angle` radians below level from the shoulder, the garment laid on its back (front up) and let
// settle onto the table. `positions` are then as a photo from above sees them, in the hanging frame (x across,
// y up the photo), so either can be laid on a photo.
export class HangerDrape {
  constructor(top, restX, { frames = HANGER_FRAMES, flat = null } = {}) {
    const { cloth, pattern } = top
    const map = top.drape.map
    const n = cloth.points.length
    const start = new Float32Array(3 * n)
    for (let i = 0; i < n; i++) { const j = map[i]; start[3 * i] = restX[3 * j]; start[3 * i + 1] = restX[3 * j + 1]; start[3 * i + 2] = restX[3 * j + 2] }
    this.flat = flat && !top.bottoms ? flat : null
    const floor = this.flat ? layOut(start, cloth, this.flat.angle) : null
    const nobody = { at: () => 1, hit: [0, 1, 0], layers: null }
    const drape = this.drape = new Drape(cloth, start, { field: nobody }, { fabric: pattern.fabric, friction: 0.3, floor })
    drape.releaseBands()
    drape.closeSeams()
    if (this.flat) {
      // Nothing holds it: it lies on the table, which keeps it where it lands.
      this.held = []
      this.at = new Float32Array(0)
      this.still = drape.stillness()
      this.frames = frames
      this.frame = 0
      this.done = false
      this.flatX = new Float32Array(0)
      return
    }
    // The points a hanger holds: a top's shoulder seams and neck (a sleeveless top's straps are its
    // shoulders); trousers' or a skirt's waist.
    const heldEdge = top.bottoms ? key => /\/waist$/.test(key) || /^waistband\//.test(key) : key => /\/(shoulder_[LR]|neck_[LR]|strap.*|top)$/.test(key) || /^collar\//.test(key)
    const held = this.held = [...new Set(Object.keys(cloth.edges).filter(heldEdge).flatMap(key => cloth.edges[key].map(i => drape.map[i])))]
    const at = this.at = new Float32Array(3 * held.length)
    held.forEach((j, k) => { at[3 * k] = drape.x[3 * j]; at[3 * k + 1] = drape.x[3 * j + 1]; at[3 * k + 2] = drape.x[3 * j + 2] })
    for (const j of held) drape.w[j] = 0
    this.still = drape.stillness()
    this.frames = frames
    this.frame = 0
    this.done = held.length === 0   // nothing to hang it by: no hanging shape
  }

  hold() {
    const { drape, held, at } = this
    held.forEach((j, k) => { drape.x[3 * j] = at[3 * k]; drape.x[3 * j + 1] = at[3 * k + 1]; drape.x[3 * j + 2] = at[3 * k + 2]; drape.v[3 * j] = drape.v[3 * j + 1] = drape.v[3 * j + 2] = 0 })
  }

  // Runs for up to `budget` milliseconds. Returns true while there's more to do.
  advance(budget = 10) {
    if (this.done) return false
    const end = performance.now() + budget
    do {
      this.drape.step({ gravity: true, sew: false })
      this.hold()
      this.frame++
      if (this.frame >= this.frames || (this.frame > 60 && this.still.quiet(0.00025))) { this.done = true; break }
    } while (performance.now() < end)
    return !this.done
  }

  // Where the points are, as a photo sees them (laid flat: from above, turned back into the hanging frame).
  get positions() {
    const x = this.drape.x
    if (!this.flat) return x
    if (this.flatX.length !== x.length) this.flatX = new Float32Array(x.length)
    // Laid out, (x, y, z) went to (x, z, -y): back again.
    for (let i = 0; i < x.length; i += 3) { this.flatX[i] = x[i]; this.flatX[i + 1] = -x[i + 2]; this.flatX[i + 2] = x[i + 1] }
    return this.flatX
  }
}

// The sleeves turned out to `angle` below level, each about its shoulder (its end nearest the body's middle),
// then the whole garment laid on its back, (x, y, z) to (x, z, -y), front up. Returns the table's height,
// just under the garment, for the drape's floor.
export function layOut(x, cloth, angle) {
  for (const side of ["L", "R"]) {
    const pieces = new Set(cloth.panels.flatMap((name, p) => (name === `sleeve_${side}` || name === `cuff_${side}` ? [p] : [])))
    const points = []
    for (let i = 0; i < cloth.points.length; i++) if (pieces.has(cloth.panel[i])) points.push(i)
    if (points.length < 4) continue
    const out = side === "L" ? 1 : -1
    let lo = Infinity, hi = -Infinity
    for (const i of points) { lo = Math.min(lo, out * x[3 * i]); hi = Math.max(hi, out * x[3 * i]) }
    const near = points.filter(i => out * x[3 * i] < lo + 0.04), far = points.filter(i => out * x[3 * i] > hi - 0.04)
    const mean = (list, c) => list.reduce((sum, i) => sum + x[3 * i + c], 0) / list.length
    const px = mean(near, 0), py = mean(near, 1), fx = mean(far, 0), fy = mean(far, 1)
    // Its angle below level now, and the turn that takes it to `angle` (seen from the front).
    const now = Math.atan2(py - fy, Math.abs(fx - px))
    const turn = (now - angle) * out
    const c = Math.cos(turn), sn = Math.sin(turn)
    for (const i of points) {
      const dx = x[3 * i] - px, dy = x[3 * i + 1] - py
      x[3 * i] = px + dx * c - dy * sn
      x[3 * i + 1] = py + dx * sn + dy * c
    }
  }
  let lowest = Infinity
  for (let i = 0; i < x.length; i += 3) {
    const y = x[i + 1], z = x[i + 2]
    x[i + 1] = z; x[i + 2] = -y
    lowest = Math.min(lowest, z)
  }
  return lowest - 0.002
}

// What HangerDrape needs of a garment, as plain data a worker can be sent: the cloth, its fabric, the
// simulated point of each cloth point, and whether it's trousers or a skirt (held at the waist).
export function hangerSpec(top) {
  return { cloth: top.cloth, pattern: { fabric: top.pattern.fabric }, drape: { map: top.drape.map }, bottoms: Boolean(top.bottoms) }
}
