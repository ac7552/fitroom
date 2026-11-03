// The garment hanging as a store photographs it (see redrape.js, which lays the store's photos on it by
// this shape), in a module of its own so the drape worker can run it too (drape_worker.js's "hang").
import { Drape } from "lib/garments/drape"

// Frames the hanger drape runs at most (it stops when still).
const HANGER_FRAMES = 400

// The garment hanging as a store photographs it: from the body drape's rest shape (restX: the sewn garment
// in the sewing pose, by simulated point), held at its shoulder seams and neck, let fall with no body under
// it until still. Run a few milliseconds at a time (advance), so the page keeps drawing; `positions` are the
// hanging positions by simulated point (the same points as the body drape's) once `done`.
export class HangerDrape {
  constructor(top, restX, { frames = HANGER_FRAMES } = {}) {
    const { cloth, pattern } = top
    const map = top.drape.map
    const n = cloth.points.length
    const start = new Float32Array(3 * n)
    for (let i = 0; i < n; i++) { const j = map[i]; start[3 * i] = restX[3 * j]; start[3 * i + 1] = restX[3 * j + 1]; start[3 * i + 2] = restX[3 * j + 2] }
    const nobody = { at: () => 1, hit: [0, 1, 0], layers: null }
    const drape = this.drape = new Drape(cloth, start, { field: nobody }, { fabric: pattern.fabric, friction: 0.3 })
    drape.releaseBands()
    drape.closeSeams()
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
    this.positions = drape.x
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
}

// What HangerDrape needs of a garment, as plain data a worker can be sent: the cloth, its fabric, the
// simulated point of each cloth point, and whether it's trousers or a skirt (held at the waist).
export function hangerSpec(top) {
  return { cloth: top.cloth, pattern: { fabric: top.pattern.fabric }, drape: { map: top.drape.map }, bottoms: Boolean(top.bottoms) }
}
