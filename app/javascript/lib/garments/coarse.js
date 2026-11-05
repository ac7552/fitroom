// Coarse first, then fine: a garment is sewn and settled as a coarser cloth (about half as many points across,
// so a quarter as many in all), and only then cut at its full resolution, laid where the coarse cloth ended
// up, and settled a moment more. Sewing closes the seams a few millimetres a step and the hang settles over a
// couple of hundred frames however fine the cloth is, so nearly all the drape's time goes on the coarse cloth,
// each frame of it about a quarter of the work. The fine cloth only has its last folds to find.
//
// While the coarse cloth runs, the fine cloth's points follow it (each is carried by the coarse triangle it
// lies in on its pattern piece), so the page draws the garment settling as before, at its full resolution.
import { Drape } from "lib/garments/drape"

// How much coarser the first cloth is (its spacing over the fine one's).
export const COARSE_FACTOR = 2
// What the fine cloth does once it's laid where the coarse one settled: a few frames easing to its own size
// (keeping no speed: its rows are a little long or short where the coarse cloth curved between its points),
// then a short settle (the garment settles again, at full resolution, as it is posed: see stage.js#posing).
const FINE_PHASES = { relaxFrames: 4, settleFrames: 20, calmFrames: 10 }

// Whether the drape starts coarse: on unless the page's address says ?coarse=off.
export const COARSE_ON = typeof location === "undefined" || new URLSearchParams(location.search).get("coarse") !== "off"

// For each point of the fine cloth, the coarse cloth's three points (of the triangle it lies in on the same
// pattern piece, or the nearest one) and its weights on them. Returns { index: Int32Array(3n), weight:
// Float32Array(3n) }.
export function carrier(fine, coarse) {
  const n = fine.points.length
  const index = new Int32Array(3 * n), weight = new Float32Array(3 * n)
  // The coarse triangles by piece, named (the two cloths have the same pieces, in the same order).
  const byPanel = new Map()
  for (const [a, b, c] of coarse.triangles) {
    const name = coarse.panels[coarse.panel[a]]
    if (!byPanel.has(name)) byPanel.set(name, [])
    byPanel.get(name).push([a, b, c])
  }
  const P = coarse.points
  for (let i = 0; i < n; i++) {
    const [x, y] = fine.points[i]
    const tris = byPanel.get(fine.panels[fine.panel[i]]) ?? []
    let best = null, bestOff = Infinity
    for (const t of tris) {
      const [ax, ay] = P[t[0]], [bx, by] = P[t[1]], [cx, cy] = P[t[2]]
      const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
      if (Math.abs(det) < 1e-12) continue
      const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det
      const v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det
      const w = 1 - u - v
      // How far outside the triangle it is (0 inside), in weights.
      const off = Math.max(0, -u) + Math.max(0, -v) + Math.max(0, -w)
      if (off < bestOff) { bestOff = off; best = [t, u, v, w]; if (off === 0) break }
    }
    if (!best) continue
    const [t, u, v, w] = best
    // Outside every triangle (a point on the fine outline between two coarse ones): the weights clamped onto
    // the nearest triangle, so the point stays on the cloth.
    let wu = Math.max(0, u), wv = Math.max(0, v), ww = Math.max(0, w)
    const sum = wu + wv + ww || 1
    index[3 * i] = t[0]; index[3 * i + 1] = t[1]; index[3 * i + 2] = t[2]
    weight[3 * i] = wu / sum; weight[3 * i + 1] = wv / sum; weight[3 * i + 2] = ww / sum
  }
  return { index, weight }
}

// Writes into `out` (3 numbers a fine pattern point) where the fine cloth's points are, carried by the coarse
// drape's pattern points (Drape#pattern).
export function carry(out, coarsePattern, { index, weight }) {
  const n = index.length / 3
  for (let i = 0; i < n; i++) {
    let x = 0, y = 0, z = 0
    for (let k = 0; k < 3; k++) {
      const j = 3 * index[3 * i + k], w = weight[3 * i + k]
      x += coarsePattern[j] * w; y += coarsePattern[j + 1] * w; z += coarsePattern[j + 2] * w
    }
    out[3 * i] = x; out[3 * i + 1] = y; out[3 * i + 2] = z
  }
  return out
}

// The drape's phases, coarse first: a generator yielding each frame's phase, as Drape#phases does, while it
// runs `fine` (a Drape not yet sewn, the cloth the page draws). coarse: { cloth, start, options } for the coarse
// Drape (its own placed points, and its own attachments and waistband, from the coarse cloth); phases: what
// the drape would have done (Drape#phases's options), for the coarse cloth.
export function* coarseFirst(fine, coarse, body, phases) {
  const drape = new Drape(coarse.cloth, coarse.start, body, coarse.options)
  const carried = carrier(fine.cloth, coarse.cloth)
  fine.coarse = drape
  let frames = 0
  for (const phase of drape.phases(phases)) {
    frames++
    // The fine cloth drawn where the coarse one is (every few frames: carrying it costs about a frame's work
    // of the coarse cloth).
    if (frames % 4 === 0) carry(fine.x, drape.pattern(), carried)
    yield phase
  }
  carry(fine.x, drape.pattern(), carried)
  fine.v.fill(0)
  fine.releaseBands()
  fine.closeSeams()
  fine.coarseFrames = frames
  fine.coarse = null
  yield* fine.phases(FINE_PHASES)
}

// How many frames the fine cloth adds, for a progress estimate.
export const FINE_FRAMES = FINE_PHASES.relaxFrames + FINE_PHASES.settleFrames
