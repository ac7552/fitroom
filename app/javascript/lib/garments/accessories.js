// Shoes, socks and a belt: drawn on the mannequin as they look, not draped or fitted.
//
// Shoes and socks are lofted round the mannequin's own feet and legs: the leg is cut into thin level slices,
// each slice's outline is made convex (so toes and ankle bones don't show through) and pushed out by the
// thickness of the sock or the shoe, and the outlines are joined into one smooth surface. A shoe keeps its
// toe box as long as its sole up to the top of the toes, comes up to its collar (high at the heel, lower at
// the sides and the tongue), and has its sole round the bottom in its own colour. A belt is a band laid round
// the pants' waistband, as the pants are draped, with a buckle at the front.
//
// Pure geometry in world space (metres, y up, the body facing +z, its left at +x), built from a body snapshot
// (dress.js's bodySnapshot) and its frame (body.js's bodyFrame).

import * as THREE from "three"
import { convexHull } from "lib/garments/body"

const STEP = 0.005        // m between slices
const AROUND = 64         // points round each outline
const BODY_HEIGHT = 1.76  // the heights below are for a body this tall (m); they scale with the body

// Each shoe's shape (m): its collar's height at the heel and at the front (the tongue, or a loafer's vamp),
// how far it dips at the sides, the sole's height, the toe's room in front of the toes, the upper's
// thickness, how far the sole stands out past it, and how high the toe box rises; and, for a boot, how
// square its toe is (2 is an oval; more is blunter), how many lugs stand out round its sole and how far,
// how thick its padded collar is, and how much of the toe box's height keeps the toes' full length (a boot's
// toe is tall and round, not sloping down to a point).
export const SHOES = {
  sneaker: { back: 0.1, front: 0.088, dip: 0.016, sole: 0.027, toe: 0.014, thick: 0.007, flare: 0.004, box: 0.045 },
  hightop: { back: 0.145, front: 0.135, dip: 0.006, sole: 0.03, toe: 0.014, thick: 0.007, flare: 0.004, box: 0.045 },
  boot: { back: 0.195, front: 0.18, dip: 0.004, sole: 0.036, toe: 0.016, thick: 0.009, flare: 0.007, box: 0.066, square: 2.6, lugs: 16, lug: 0.0024, pad: 0.011, full: 0.8 },
  loafer: { back: 0.066, front: 0.052, dip: 0.012, sole: 0.016, toe: 0.02, thick: 0.005, flare: 0.002, box: 0.038 },
  sandal: { back: 0.024, front: 0.024, dip: 0, sole: 0.024, toe: 0.006, thick: 0.004, flare: 0.006, box: 0.024, strap: [0.035, 0.058] }
}
// How high each sock comes: just over the ankle bone, to mid-calf, or to below the knee.
export const SOCKS = { ankle: 0.02, crew: 0.15, knee: -0.05 }
const SOCK_THICK = 0.0022

// The slices of one leg (side "L", +x, or "R"), from the floor up to `top`: each a convex outline (an array of
// [x, z]) about its middle, smoothed from slice to slice. body: a snapshot; frame: its bodyFrame.
export function legSlices(body, frame, side, top) {
  const { positions, index } = body
  const sign = side === "L" ? 1 : -1
  const floor = frame.floor
  const rows = Math.max(2, Math.ceil((top - floor) / STEP) + 1)
  const buckets = Array.from({ length: rows }, () => [])
  const leg = i => frame.part[i] === 4 && positions[3 * i] * sign > 0
  // Each slice is where the skin's triangles cross its height (exact, however far apart the mesh's points
  // are), with the points of the skin within half a step of it.
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2]
    if (!leg(a) && !leg(b) && !leg(c)) continue
    const ya = positions[3 * a + 1], yb = positions[3 * b + 1], yc = positions[3 * c + 1]
    const lo = Math.min(ya, yb, yc), hi = Math.max(ya, yb, yc)
    if (lo > top + STEP || hi < floor) continue
    const k0 = Math.max(0, Math.ceil((lo - floor) / STEP)), k1 = Math.min(rows - 1, Math.floor((hi - floor) / STEP))
    for (let k = k0; k <= k1; k++) {
      const y = floor + k * STEP
      for (const [p, q] of [[a, b], [b, c], [c, a]]) {
        const yp = positions[3 * p + 1], yq = positions[3 * q + 1]
        if ((yp - y) * (yq - y) > 0 || yp === yq) continue
        const t2 = (y - yp) / (yq - yp)
        buckets[k].push([positions[3 * p] + t2 * (positions[3 * q] - positions[3 * p]), positions[3 * p + 2] + t2 * (positions[3 * q + 2] - positions[3 * p + 2])])
      }
    }
  }
  const n = positions.length / 3
  for (let i = 0; i < n; i++) {
    if (!leg(i)) continue
    const r = (positions[3 * i + 1] - floor) / STEP, k = Math.round(r)
    if (k >= 0 && k < rows && Math.abs(r - k) < 0.5) buckets[k].push([positions[3 * i], positions[3 * i + 2]])
  }
  const hulls = []
  for (let k = 0; k < rows; k++) hulls.push(buckets[k].length >= 3 ? convexHull(buckets[k]) : hulls[k - 1] ?? null)
  for (let k = rows - 1; k >= 0; k--) hulls[k] ??= hulls[k + 1]
  const centres = hulls.map(h => centroid(h))
  // The middles drift smoothly from slice to slice.
  for (let pass = 0; pass < 3; pass++) {
    const c = centres.map(p => p.slice())
    for (let k = 1; k < rows - 1; k++) for (let d = 0; d < 2; d++) centres[k][d] = (c[k - 1][d] + 2 * c[k][d] + c[k + 1][d]) / 4
  }
  // Each outline as how far it reaches from its middle at each angle (0 to the front, +z), smoothed up and down.
  const reach = hulls.map((h, k) => Float64Array.from({ length: AROUND }, (_, j) => ray(h, centres[k], angleOf(j))))
  for (let pass = 0; pass < 2; pass++) {
    const r = reach.map(a => Float64Array.from(a))
    for (let k = 1; k < rows - 1; k++) for (let j = 0; j < AROUND; j++) reach[k][j] = Math.max(r[k][j], (r[k - 1][j] + 2 * r[k][j] + r[k + 1][j]) / 4)
  }
  return { floor, rows, centres, reach, at: (y) => sliceAt(floor, rows, centres, reach, y) }
}

function angleOf(j) { return (j / AROUND) * 2 * Math.PI }

// The middle and the reach at each angle at height y (between slices, blended).
function sliceAt(floor, rows, centres, reach, y) {
  const r = Math.min(rows - 1, Math.max(0, (y - floor) / STEP))
  const k = Math.min(rows - 2, Math.floor(r)), t = r - k
  const c = [centres[k][0] * (1 - t) + centres[k + 1][0] * t, centres[k][1] * (1 - t) + centres[k + 1][1] * t]
  const a = Float64Array.from({ length: AROUND }, (_, j) => reach[k][j] * (1 - t) + reach[k + 1][j] * t)
  return { centre: c, reach: a }
}

function centroid(hull) {
  let ax = 0, az = 0, area = 0
  for (let i = 0; i < hull.length; i++) {
    const [x0, z0] = hull[i], [x1, z1] = hull[(i + 1) % hull.length]
    const c = x0 * z1 - x1 * z0
    area += c; ax += (x0 + x1) * c; az += (z0 + z1) * c
  }
  if (Math.abs(area) < 1e-12) {
    const n = hull.length
    return [hull.reduce((s, p) => s + p[0], 0) / n, hull.reduce((s, p) => s + p[1], 0) / n]
  }
  return [ax / (3 * area), az / (3 * area)]
}

// How far from `from` a ray at angle a (0 toward +z, turning toward +x) runs before leaving a convex outline.
function ray(hull, from, a) {
  const dx = Math.sin(a), dz = Math.cos(a)
  let best = 0
  for (let i = 0; i < hull.length; i++) {
    const ax = hull[i][0] - from[0], az = hull[i][1] - from[1]
    const bx = hull[(i + 1) % hull.length][0] - from[0], bz = hull[(i + 1) % hull.length][1] - from[1]
    const ex = bx - ax, ez = bz - az
    const denom = dx * ez - dz * ex
    if (Math.abs(denom) < 1e-12) continue
    const t = (ax * ez - az * ex) / denom
    const u = (ax * dz - az * dx) / denom
    if (t > 0 && u >= -1e-9 && u <= 1 + 1e-9) best = Math.max(best, t)
  }
  return best
}

// One shoe's geometry (side "L" or "R"): groups 0 the sole (and its underside), 1 the upper, 2 laces, 3 a
// boot's padded collar, 4 its eyelets.
export function shoeGeometry(body, frame, side, styleName) {
  const style = SHOES[styleName] ?? SHOES.sneaker
  const s = (frame.top - frame.floor) / BODY_HEIGHT
  const h = key => style[key] * s
  const floor = frame.floor
  const slices = legSlices(body, frame, side, floor + h("back") + 0.02)
  // Rounded off round the foot (a shoe's toe is round, not the point of the big toe).
  // The front half is filled out to an ellipse as long as the foot and as wide as its ball.
  const square = style.square ?? 2
  const round = reach => {
    const blurred = Float64Array.from(reach, (_, j) => {
      let sum = 0, w = 0
      for (let d = -5; d <= 5; d++) { const k = Math.cos((d / 6) * (Math.PI / 2)); sum += reach[(j + d + AROUND) % AROUND] * k; w += k }
      return Math.max(sum / w, reach[j] * 0.94)
    })
    const length = blurred[0]
    let left = 0, right = 0
    for (let j = 0; j < AROUND; j++) {
      const a = angleOf(j)
      if (Math.cos(a) > 0.6 || Math.cos(a) < -0.2) continue
      const across = blurred[j] * Math.abs(Math.sin(a))
      if (Math.sin(a) > 0) left = Math.max(left, across); else right = Math.max(right, across)
    }
    return Float64Array.from(blurred, (r, j) => {
      const a = angleOf(j), c = Math.cos(a)
      if (c <= 0) return r
      const width = Math.sin(a) > 0 ? left : right
      const ellipse = 1 / (Math.abs(c / length) ** square + Math.abs(Math.sin(a) / width) ** square) ** (1 / square)
      return Math.max(r, ellipse * 0.98)
    })
  }
  const toes = { ...slices.at(floor + STEP) }
  toes.reach = round(toes.reach)
  // The collar's height at each angle round the foot: high at the heel, lower in front, dipping at the sides.
  const collar = Float64Array.from({ length: AROUND }, (_, j) => {
    const a = angleOf(j), front = (1 + Math.cos(a)) / 2
    return floor + h("back") * (1 - front) + h("front") * front - h("dip") * Math.sin(a) ** 2
  })
  // The shoe's reach at height y and angle j: the foot's, keeping the toe box full length up to the top of
  // the toes, out by the upper's thickness, with room in front of the toes and the sole standing out.
  const rounded = new Map()
  const reachAt = (y, j) => {
    const key = y.toFixed(5)
    const slice = rounded.get(key) ?? rounded.set(key, (sl => ({ centre: sl.centre, reach: round(sl.reach) }))(slices.at(y))).get(key)
    const a = angleOf(j), dx = Math.sin(a), dz = Math.cos(a)
    const full = style.full ?? 0.55
    const lift = Math.min(1, Math.max(0, (y - floor - h("box") * full) / (h("box") * (1 - full) + 1e-6)))
    const keep = 1 - lift * lift * (3 - 2 * lift)
    // The toe box: the toes' outline (about their own middle), blended into this slice's as it rises.
    const sx = slice.centre[0] + slice.reach[j] * dx, sz = slice.centre[1] + slice.reach[j] * dz
    const tx = toes.centre[0] + toes.reach[j] * dx, tz = toes.centre[1] + toes.reach[j] * dz
    let x = tx * keep + sx * (1 - keep), z = tz * keep + sz * (1 - keep)
    // Never inside the foot itself.
    if ((sx - slice.centre[0]) * dx + (sz - slice.centre[1]) * dz > (x - slice.centre[0]) * dx + (z - slice.centre[1]) * dz) { x = sx; z = sz }
    const forward = Math.max(0, dz) ** 1.6
    let out = h("thick") + h("toe") * forward * (1 - lift * 0.6)
    if (y < floor + h("sole") + 1e-6) out += h("flare")
    // A boot's lugs: blocks of tread standing out round the bottom of the sole.
    if (style.lugs && y < floor + h("sole") * 0.6) out += h("lug") * (0.5 + 0.5 * Math.sin(style.lugs * a)) ** 2
    return { x: x + out * dx, z: z + out * dz, centre: slice.centre }
  }
  // Rows up each column: the sole's (level, so its top edge is straight), then the upper's up to the collar.
  const soleRows = (style.lugs ? [0, 0.3, 0.55, 0.62, 1] : [0, 0.5, 1]).map(t => floor + 0.0008 + t * (h("sole") - 0.0008))
  const upperRows = 14
  const sandal = styleName === "sandal"
  const positions = [], colors = [], indexSole = [], indexUpper = [], indexCollar = [], indexEyelets = []
  const columns = AROUND
  const grid = []   // grid[row][j]: vertex index
  const put = (x, y, z) => { positions.push(x, y, z); return positions.length / 3 - 1 }
  const rowsY = j => sandal ? soleRows : [...soleRows, ...Array.from({ length: upperRows }, (_, k) => soleRows[2] + ((k + 1) / upperRows) * (collar[j] - soleRows[2]))]
  const height = sandal ? soleRows.length : soleRows.length + upperRows
  for (let row = 0; row < height; row++) grid.push(new Array(columns))
  for (let j = 0; j < columns; j++) {
    const ys = rowsY(j), a = angleOf(j)
    ys.forEach((y, row) => {
      const { x, z } = reachAt(y, j)
      grid[row][j] = put(x, y, z)
    })
  }
  const quad = (list, a, b, c, d) => list.push(a, b, d, b, c, d)
  for (let row = 0; row + 1 < height; row++) {
    // The sole's rows, and with a welt (a boot's) the ledge from its top in to the upper, in the sole's colour.
    const list = row < soleRows.length - (style.lugs ? 0 : 1) ? indexSole : indexUpper
    for (let j = 0; j < columns; j++) {
      const jn = (j + 1) % columns
      quad(list, grid[row][j], grid[row][jn], grid[row + 1][jn], grid[row + 1][j])
    }
  }
  // The sole's underside, and for a sandal its top (the foot stands on it).
  const base = slices.at(floor)
  const under = put(base.centre[0], floor + 0.0008, base.centre[1])
  for (let j = 0; j < columns; j++) indexSole.push(under, grid[0][(j + 1) % columns], grid[0][j])
  const top = grid[soleRows.length - 1]
  if (sandal) {
    const middle = put(base.centre[0], soleRows[soleRows.length - 1], base.centre[1])
    for (let j = 0; j < columns; j++) indexSole.push(middle, top[j], top[(j + 1) % columns])
  } else {
    // The collar's padded edge: a rim turned in over the top, then down inside. A boot's is a thick padded
    // roll in its own leather: out round the top of the shaft, over, and down inside.
    const pad = style.pad ? h("pad") : 0
    const rings = pad
      ? [[0.45, -0.032, 0.35], [1, -0.02, 0.85], [1.15, -0.008, 1], [0.95, 0.002, 0.7], [0.3, 0.006, 0], [-0.5, 0.0, -0.6], [-0.9, -0.02, -1]]
      : [[0, 0.002, -1.1], [0, -0.018, -1.43]]
    const ringRows = rings.map(() => [])
    for (let j = 0; j < columns; j++) {
      const v = grid[height - 1][j]
      const x = positions[3 * v], y = positions[3 * v + 1], z = positions[3 * v + 2]
      const c = slices.at(y).centre
      const dx = x - c[0], dz = z - c[1], len = Math.hypot(dx, dz) || 1
      const t = h("thick")
      rings.forEach(([outPad, up, inThick], r) => {
        const out = pad ? outPad * pad - (inThick < 0 ? -inThick * t * 1.2 : 0) : inThick * t
        ringRows[r].push(put(x + (dx / len) * out, y + up * s, z + (dz / len) * out))
      })
    }
    const collarList = pad ? indexCollar : indexUpper
    const from = pad ? 0 : -1
    for (let r = from; r + 1 < rings.length; r++) {
      const lower = r < 0 ? grid[height - 1] : ringRows[r], upper = ringRows[r + 1]
      for (let j = 0; j < columns; j++) {
        const jn = (j + 1) % columns
        quad(r < 0 ? indexUpper : collarList, lower[j], lower[jn], upper[jn], upper[j])
      }
    }
    if (pad) {
      // The shaft up into the bottom of the roll.
      for (let j = 0; j < columns; j++) {
        const jn = (j + 1) % columns
        quad(indexUpper, grid[height - 1][j], grid[height - 1][jn], ringRows[0][jn], ringRows[0][j])
      }
    }
  }
  // Laces up the front of a sneaker or a boot: bars across the instep, from above the toes to the collar.
  const indexLaces = []
  if (["sneaker", "hightop", "boot"].includes(styleName)) {
    const path = []
    for (let row = soleRows.length; row < height; row++) {
      const v = grid[row][0]
      if (positions[3 * v + 1] > floor + h("box") * 1.15) path.push([positions[3 * v], positions[3 * v + 1], positions[3 * v + 2]])
    }
    const bars = styleName === "boot" ? 8 : styleName === "hightop" ? 8 : 5
    if (path.length >= 3) {
      const lengths = [0]
      for (let k = 1; k < path.length; k++) lengths.push(lengths[k - 1] + Math.hypot(...[0, 1, 2].map(c => path[k][c] - path[k - 1][c])))
      const total = lengths[lengths.length - 1]
      for (let b = 0; b < bars; b++) {
        const at = total * (0.08 + (0.84 * b) / Math.max(1, bars - 1))
        let k = 1
        while (k < path.length - 1 && lengths[k] < at) k++
        const t = (at - lengths[k - 1]) / Math.max(1e-6, lengths[k] - lengths[k - 1])
        const p = [0, 1, 2].map(c => path[k - 1][c] + t * (path[k][c] - path[k - 1][c]))
        const along = normalize3([0, 1, 2].map(c => path[k][c] - path[k - 1][c]))
        const across = [1, 0, 0]
        const outward = normalize3(cross3(across, along))
        const flip = outward[2] < 0 && outward[1] < 0.7 ? -1 : 1
        const n = outward.map(v => v * flip)
        const half = [0.0135 * s * (1 - 0.25 * b / bars), 0.0019 * s, 0.0016 * s]
        const corner = (i, j2, k2) => put(...[0, 1, 2].map(c => p[c] + n[c] * 0.0016 * s + across[c] * half[0] * i + along[c] * half[1] * j2 + n[c] * half[2] * k2))
        const v = [corner(-1, -1, -1), corner(1, -1, -1), corner(1, 1, -1), corner(-1, 1, -1), corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1)]
        for (const [a2, b2, c2, d2] of [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]]) quad(indexLaces, v[a2], v[b2], v[c2], v[d2])
        // A boot's metal eyelets (or hooks, higher up) at each end of the lace.
        if (styleName === "boot") {
          for (const end of [-1, 1]) {
            const e = (i, j2, k2) => put(...[0, 1, 2].map(c => p[c] + n[c] * 0.0012 * s + across[c] * (half[0] * end * 1.08 + 0.0028 * s * i) + along[c] * 0.0028 * s * j2 + n[c] * 0.0014 * s * k2))
            const w = [e(-1, -1, -1), e(1, -1, -1), e(1, 1, -1), e(-1, 1, -1), e(-1, -1, 1), e(1, -1, 1), e(1, 1, 1), e(-1, 1, 1)]
            for (const [a2, b2, c2, d2] of [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]]) quad(indexEyelets, w[a2], w[b2], w[c2], w[d2])
          }
        }
      }
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
  // Groups: 0 sole, 1 upper, 2 laces, 3 a boot's padded collar, 4 its eyelets.
  geometry.setIndex([...indexSole, ...indexUpper, ...indexLaces, ...indexCollar, ...indexEyelets])
  let at = 0
  ;[indexSole, indexUpper, indexLaces, indexCollar, indexEyelets].forEach((list, group) => {
    if (list.length) geometry.addGroup(at, list.length, group)
    at += list.length
  })
  geometry.computeVertexNormals()
  void colors
  return geometry
}

function normalize3(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l] }
function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }

// A sandal's strap: a band over the instep, between two heights, round the front half of the foot.
export function strapGeometry(body, frame, side) {
  const style = SHOES.sandal
  const s = (frame.top - frame.floor) / BODY_HEIGHT
  const [lo, hi] = style.strap.map(v => frame.floor + v * s)
  const slices = legSlices(body, frame, side, hi + 0.01)
  const positions = [], index = []
  const span = Math.round(AROUND * 0.32)
  for (let k = -span; k <= span; k++) {
    const j = (k + AROUND) % AROUND, a = angleOf(j)
    for (const y of [lo, hi]) {
      const { centre, reach } = slices.at(y)
      const r = reach[j] + 0.004 * s
      positions.push(centre[0] + r * Math.sin(a), y, centre[1] + r * Math.cos(a))
    }
  }
  for (let k = 0; k < 2 * span; k++) index.push(2 * k, 2 * k + 2, 2 * k + 1, 2 * k + 1, 2 * k + 2, 2 * k + 3)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(index)
  geometry.computeVertexNormals()
  return geometry
}

// One sock (side "L" or "R"): close round the foot and up the leg to its height.
export function sockGeometry(body, frame, side, styleName) {
  const k = side.toUpperCase()
  const ankle = frame.joints[`ankle_${k}`], knee = frame.joints[`knee_${k}`]
  const s = (frame.top - frame.floor) / BODY_HEIGHT
  const add = (SOCKS[styleName] ?? SOCKS.crew) * s
  const top = styleName === "knee" && knee ? knee[1] + add : ankle[1] + add
  const slices = legSlices(body, frame, side, top + STEP)
  const rows = Math.max(3, Math.ceil((top - frame.floor) / STEP))
  const positions = [], index = []
  for (let row = 0; row <= rows; row++) {
    const y = frame.floor + 0.0006 + (row / rows) * (top - frame.floor - 0.0006)
    const { centre, reach } = slices.at(y)
    for (let j = 0; j < AROUND; j++) {
      const a = angleOf(j), r = reach[j] + SOCK_THICK * s
      positions.push(centre[0] + r * Math.sin(a), y, centre[1] + r * Math.cos(a))
    }
  }
  for (let row = 0; row < rows; row++) {
    for (let j = 0; j < AROUND; j++) {
      const a = row * AROUND + j, b = row * AROUND + ((j + 1) % AROUND), c = b + AROUND, d = a + AROUND
      index.push(a, b, d, b, c, d)
    }
  }
  const base = slices.at(frame.floor)
  const under = positions.length / 3
  positions.push(base.centre[0], frame.floor + 0.0006, base.centre[1])
  for (let j = 0; j < AROUND; j++) index.push(under, (j + 1) % AROUND, j)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(index)
  geometry.computeVertexNormals()
  return geometry
}

// What pants' hems must stay off where shoes are worn (as body.js's footHull is for bare feet): each
// shoe's outline in 1 cm slices from the floor to its collar. points: [[x, y, z], ...] of one shoe.
export function outlineOf(points, floor) {
  const step = 0.01
  let topY = floor
  for (const p of points) topY = Math.max(topY, p[1])
  const rows = Math.max(1, Math.ceil((topY - floor) / step))
  const slices = Array.from({ length: rows }, () => [])
  for (const [x, y, z] of points) {
    const r = Math.floor((y - floor) / step)
    if (r >= 0 && r < rows) slices[r].push([x, z])
  }
  const hulls = slices.map(pts => (pts.length >= 3 ? convexHull(pts) : null))
  const rounds = hulls.map(h => (h ? h.reduce((sum, [x, z], k) => sum + Math.hypot(h[(k + 1) % h.length][0] - x, h[(k + 1) % h.length][1] - z), 0) : 0))
  return {
    top: topY, floor, step, hulls,
    at(y) {
      const r = Math.floor((y - floor) / step)
      return r >= 0 && r < rows ? hulls[r] : null
    },
    lowest(round) {
      for (let r = rows - 1; r >= 0; r--) if (rounds[r] > round) return floor + (r + 1) * step
      return floor
    }
  }
}

// A belt laid round pants' waistband. rim and seam: the band's top edge and its lower seam, as world points
// [[x, y, z], ...] in any order. Returns the band's geometry (one group) and where the buckle goes
// ({ position, normal, up }), or null when the band can't be read.
export function beltGeometry(rim, seam, { width = 0.034, out = 0.004, thick = 0.004 } = {}) {
  if (rim.length < 8 || seam.length < 8) return null
  const centreOf = pts => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[2], 0) / pts.length]
  const c = centreOf([...rim, ...seam])
  const around = 96
  const ringAt = pts => {
    // Each angle's nearest points, by angle about the middle: their height and reach, blended.
    const polar = pts.map(([x, y, z]) => ({ a: Math.atan2(x - c[0], z - c[1]), r: Math.hypot(x - c[0], z - c[1]), y }))
    return Array.from({ length: around }, (_, j) => {
      const a = (j / around) * 2 * Math.PI - Math.PI
      let wr = 0, wy = 0, w = 0
      for (const p of polar) {
        const d = Math.abs(Math.atan2(Math.sin(p.a - a), Math.cos(p.a - a)))
        if (d > 0.25) continue
        const k = 1 / (d + 0.02)
        wr += p.r * k; wy += p.y * k; w += k
      }
      return w ? { a, r: wr / w, y: wy / w } : null
    })
  }
  const top = ringAt(rim), bottom = ringAt(seam)
  for (let j = 0; j < around; j++) if (!top[j] || !bottom[j]) return null
  const positions = [], index = []
  const put = (a, r, y) => { positions.push(c[0] + r * Math.sin(a), y, c[1] + r * Math.cos(a)); return positions.length / 3 - 1 }
  // Its middle sits at the band's middle; its outer face out by `out`, its inner face `thick` inside that.
  const cols = []
  for (let j = 0; j < around; j++) {
    const t = top[j], b = bottom[j]
    const mid = (t.y + b.y) / 2, r = Math.max(t.r, b.r) + out
    const hiY = mid + width / 2, loY = mid - width / 2
    cols.push([put(t.a, r, hiY), put(t.a, r, loY), put(t.a, r - thick, loY), put(t.a, r - thick, hiY)])
  }
  for (let j = 0; j < around; j++) {
    const a = cols[j], b = cols[(j + 1) % around]
    for (let f = 0; f < 4; f++) {
      const g = (f + 1) % 4
      index.push(a[f], a[g], b[f], a[g], b[g], b[f])
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(index)
  geometry.computeVertexNormals()
  // The buckle: at the front (angle 0), on the outer face.
  const front = around / 2   // a = 0 at j = around / 2
  const t = top[front], b = bottom[front]
  const mid = (t.y + b.y) / 2, r = Math.max(t.r, b.r) + out + 0.002
  return { geometry, buckle: { position: [c[0], mid, c[1] + r], normal: [0, 0, 1], height: width } }
}

// A buckle: a rounded metal frame, `height` tall, facing `normal`.
export function buckleGeometry(height) {
  const w = height * 1.1, hgt = height * 1.25, bar = height * 0.18
  const outer = roundedRect(w, hgt, bar * 0.9)
  const hole = roundedRect(w - 2 * bar, hgt - 2 * bar, bar * 0.4)
  outer.holes.push(hole)
  const geometry = new THREE.ExtrudeGeometry(outer, { depth: 0.003, bevelEnabled: true, bevelThickness: 0.0012, bevelSize: 0.0008, bevelSegments: 2, curveSegments: 6 })
  geometry.translate(0, 0, -0.0015)
  // The prong across the middle.
  return geometry
}

function roundedRect(w, h, r) {
  const shape = new THREE.Shape()
  const x = -w / 2, y = -h / 2
  shape.moveTo(x + r, y)
  shape.lineTo(x + w - r, y); shape.quadraticCurveTo(x + w, y, x + w, y + r)
  shape.lineTo(x + w, y + h - r); shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  shape.lineTo(x + r, y + h); shape.quadraticCurveTo(x, y + h, x, y + h - r)
  shape.lineTo(x, y + r); shape.quadraticCurveTo(x, y, x + r, y)
  return shape
}

// Materials: leather (smooth, a little gloss), suede (soft, matte), canvas or knit (matte, a fine sheen), a
// rubber sole, and a metal buckle.
export function accessoryMaterial(fabric, color) {
  const finishes = {
    leather: { roughness: 0.42, clearcoat: 0.25, clearcoatRoughness: 0.4, sheen: 0 },
    suede: { roughness: 0.95, clearcoat: 0, sheen: 0.6, sheenRoughness: 0.8 },
    canvas: { roughness: 0.88, clearcoat: 0, sheen: 0.3, sheenRoughness: 0.7 },
    knit: { roughness: 0.96, clearcoat: 0, sheen: 0.45, sheenRoughness: 0.7 },
    rubber: { roughness: 0.7, clearcoat: 0.05, sheen: 0 },
    metal: { roughness: 0.28, metalness: 1, clearcoat: 0 }
  }
  const finish = finishes[fabric] ?? finishes.canvas
  const material = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(color), side: THREE.DoubleSide, ...finish })
  if (finish.sheen) material.sheenColor = new THREE.Color(color).offsetHSL(0, 0, 0.15)
  return material
}
