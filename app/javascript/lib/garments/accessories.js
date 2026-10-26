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
  boot: { back: 0.195, front: 0.18, dip: 0.004, sole: 0.036, toe: 0.016, thick: 0.009, flare: 0.007, box: 0.066, square: 2.2, lugs: 16, lug: 0.0036, pad: 0.011, full: 0.45 },
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
    if (style.lugs && y < floor + h("sole") * 0.62) out += h("lug") * (0.5 + 0.5 * Math.sin(style.lugs * a)) ** 2
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
    const bars = styleName === "boot" ? 9 : styleName === "hightop" ? 8 : 5
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
        // A boot's bars are longer and thicker: its laces cross a wide throat, in a thick round lace.
        const half = styleName === "boot" ? [0.019 * s * (1 - 0.2 * b / bars), 0.0026 * s, 0.0022 * s] : [0.0135 * s * (1 - 0.25 * b / bars), 0.0019 * s, 0.0016 * s]
        const corner = (i, j2, k2) => put(...[0, 1, 2].map(c => p[c] + n[c] * 0.0016 * s + across[c] * half[0] * i + along[c] * half[1] * j2 + n[c] * half[2] * k2))
        const v = [corner(-1, -1, -1), corner(1, -1, -1), corner(1, 1, -1), corner(-1, 1, -1), corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1)]
        for (const [a2, b2, c2, d2] of [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]]) quad(indexLaces, v[a2], v[b2], v[c2], v[d2])
        // A boot's metal eyelets (or hooks, higher up) at each end of the lace.
        if (styleName === "boot") {
          for (const end of [-1, 1]) {
            const e = (i, j2, k2) => put(...[0, 1, 2].map(c => p[c] + n[c] * 0.0012 * s + across[c] * (half[0] * end * 1.1 + 0.0036 * s * i) + along[c] * 0.0036 * s * j2 + n[c] * 0.0016 * s * k2))
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

// A shoe built from its side photo (see print.js's shoeSide): its outline from heel to toe, as tall at each
// point as photographed and as wide as the foot (and, up the shaft, the leg) inside it, plus the upper's
// thickness, rounded in at the toe and heel. Its cross-sections are rounded boxes (a boot's squarer, a
// sneaker's rounder), open on top where the leg comes out. Groups: 0 the sole (the photo's sole's height)
// and its underside, 1 the upper. The photo is then wrapped on (wrapShoePhoto), which it fits exactly.
const PHOTO_SHOE = { columns: 56, around: 28, round: { boot: 3.2, hightop: 3, sneaker: 2.6, loafer: 2.4, sandal: 2.4 } }
export function photoShoeGeometry(body, frame, side, outline, styleName, { laces = true } = {}) {
  const style = SHOES[styleName] ?? SHOES.sneaker
  const s = (frame.top - frame.floor) / BODY_HEIGHT
  const floor = frame.floor, thick = style.thick * s
  const reachTop = floor + 0.32 * s
  const slices = legSlices(body, frame, side, reachTop)
  const rows = slices.rows
  const ring = k => Array.from({ length: AROUND }, (_, j) => {
    const a = angleOf(j), r = slices.reach[k][j]
    return [slices.centres[k][0] + r * Math.sin(a), slices.centres[k][1] + r * Math.cos(a)]
  })
  const rings = Array.from({ length: rows }, (_, k) => ring(k))
  // The foot's length: its outline's ends low down, with room for the toes and the heel counter.
  let zmin = Infinity, zmax = -Infinity
  for (let k = 0; k < rows && k * STEP < 0.05 * s; k++) for (const [, z] of rings[k]) { zmin = Math.min(zmin, z); zmax = Math.max(zmax, z) }
  const back = zmin - thick - 0.003 * s, front = zmax + thick + style.toe * s
  const length = front - back
  const metres = length * outline.aspect / (outline.right - outline.left)
  const bins = outline.top.length
  const photoTall = u => lerpAt(outline.bottom, u) - lerpAt(outline.top, u)
  // Where the body crosses a level line across the foot at z, at slice k: its x from and to, or null.
  const across = (k, z) => {
    let lo = Infinity, hi = -Infinity
    const pts = rings[k]
    for (let j = 0; j < AROUND; j++) {
      const [x0, z0] = pts[j], [x1, z1] = pts[(j + 1) % AROUND]
      if ((z0 - z) * (z1 - z) > 0 || z0 === z1) continue
      const x = x0 + ((z - z0) / (z1 - z0)) * (x1 - x0)
      lo = Math.min(lo, x); hi = Math.max(hi, x)
    }
    return lo <= hi ? [lo, hi] : null
  }
  // A boot's (or a high-top's) shaft goes up round the leg; a low shoe's collar sits under the ankle.
  const tallShaft = styleName === "boot" || styleName === "hightop"
  let shaft = 0
  for (let b = 0; b < bins; b++) shaft = Math.max(shaft, (outline.bottom[b] - outline.top[b]) * metres)
  const columns = PHOTO_SHOE.columns
  const us = Array.from({ length: columns }, (_, c) => (1 - Math.cos((Math.PI * c) / (columns - 1))) / 2)
  const tall = [], wide = [], middle = [], open = [], legAt = []
  for (const u of us) {
    const z = back + u * length
    let height = photoTall(Math.min(1, Math.max(0, u))) * metres
    let lo = Infinity, hi = -Infinity, footTop = -Infinity, low = [Infinity, -Infinity]
    for (let k = 0; k < rows; k++) {
      const y = floor + k * STEP
      const x = across(k, z)
      if (!x) continue
      if (y <= height + 0.01 * s) { lo = Math.min(lo, x[0]); hi = Math.max(hi, x[1]) }
      if (y < floor + 0.04 * s) { low[0] = Math.min(low[0], x[0]); low[1] = Math.max(low[1], x[1]) }
      footTop = y - floor
    }
    // The leg comes out of the top here (the body carries on above the shoe): open on top.
    // There, the shaft stands its full height (the shin can come out in front of where the photo's shaft
    // ends, the mannequin's leg not standing just where the shop's did).
    const through = footTop >= height + 0.03 * s
    if (through) { if (tallShaft) height = Math.max(height, shaft) }
    else if (Number.isFinite(footTop)) height = Math.max(height, footTop + thick)
    tall.push(height)
    wide.push(Number.isFinite(lo) ? (hi - lo) / 2 + thick : 0)
    middle.push(Number.isFinite(low[0]) ? (low[0] + low[1]) / 2 : Number.isFinite(lo) ? (lo + hi) / 2 : null)
    open.push(through)
    const k = Math.min(rows - 1, Math.round((height - 0.01 * s) / STEP))
    legAt.push(through ? across(k, z) : null)
  }
  // Middles where the foot isn't (the toe's room, behind the heel): the nearest one's.
  for (let c = 1; c < columns; c++) if (middle[c] === null) middle[c] = middle[c - 1]
  for (let c = columns - 2; c >= 0; c--) if (middle[c] === null) middle[c] = middle[c + 1]
  const mid = soften(soften(middle))
  // Rounded in at the toe and the heel: as wide as the ball, then an oval round to the tip.
  const widest = (from, to) => Math.max(...us.map((u, c) => (u >= from && u <= to ? wide[c] : 0)))
  const ball = widest(0.55, 0.85), heel = widest(0.08, 0.3), e = 2.4
  const width = soften(us.map((u, c) => {
    let w = wide[c]
    if (u > 0.7) w = Math.max(w, ball * Math.max(0, 1 - ((u - 0.7) / 0.3) ** e) ** (1 / e))
    if (u < 0.2) w = Math.max(w, heel * Math.max(0, 1 - ((0.2 - u) / 0.2) ** e) ** (1 / e))
    return w
  }))
  const height = soften(tall)
  const soleTall = us.map(u => Math.max(0.004 * s, (lerpAt(outline.bottom, u) - lerpAt(outline.sole ?? outline.bottom, u)) * metres))
  // Each column's cross-section: a rounded box from one side's foot of the sole, over the top, to the other's.
  const round = PHOTO_SHOE.round[styleName] ?? 2.6, around = PHOTO_SHOE.around
  const positions = [], grid = []
  const flare = style.flare * s
  for (let c = 0; c < columns; c++) {
    const z = back + us[c] * length, w = width[c], hgt = height[c], row = []
    for (let r = 0; r <= around; r++) {
      const phi = (Math.PI * r) / around, cos = Math.cos(phi), sin = Math.sin(phi)
      // Up the shaft, where the leg comes out of the top, its walls stand straight to the top.
      const e = open[c] && tallShaft ? 10 : round
      const y = floor + 0.0008 + (hgt - 0.0008) * Math.abs(sin) ** (2 / e)
      const out = y - floor < soleTall[c] ? flare : 0
      const x = mid[c] + Math.sign(cos) * (w + out) * Math.abs(cos) ** (2 / e)
      positions.push(x, y, z)
      row.push(positions.length / 3 - 1)
    }
    grid.push(row)
  }
  const sole = [], upper = []
  const quad = (list, a, b, c2, d) => list.push(a, b, d, b, c2, d)
  const yOf = v => positions[3 * v + 1], xOf = v => positions[3 * v]
  for (let c = 0; c + 1 < columns; c++) {
    for (let r = 0; r < around; r++) {
      const a = grid[c][r], b = grid[c + 1][r], c2 = grid[c + 1][r + 1], d = grid[c][r + 1]
      // Open over the leg where it comes out of the top.
      const leg = open[c] && open[c + 1] ? (legAt[c] ?? legAt[c + 1]) : null
      if (leg && r > around * 0.25 && r < around * 0.75 && [a, b, c2, d].every(v => xOf(v) > leg[0] - 0.004 * s && xOf(v) < leg[1] + 0.004 * s)) continue
      const lowest = Math.min(yOf(a), yOf(b), yOf(c2), yOf(d)) - floor
      quad(lowest < Math.min(soleTall[c], soleTall[c + 1]) - 1e-4 ? sole : upper, a, b, c2, d)
    }
    // The underside: across from one side's foot to the other's.
    quad(sole, grid[c][around], grid[c + 1][around], grid[c + 1][0], grid[c][0])
  }
  // The ends: closed with a fan from their middles.
  for (const [c, flip] of [[0, true], [columns - 1, false]]) {
    const x = mid[c], y = floor + height[c] / 2, z = back + us[c] * length
    positions.push(x, y, z)
    const centre = positions.length / 3 - 1
    for (let r = 0; r <= around; r++) {
      // Round the cross-section, and across its bottom (from the last point back to the first).
      const a = grid[c][r], b = grid[c][(r + 1) % (around + 1)]
      if (flip) upper.push(centre, a, b); else upper.push(centre, b, a)
    }
  }
  // Laces up the throat of a lace-up shoe, in relief (the side photo shows them only side on; a photo from
  // above, when there is one, shows them itself): bars across the top of the instep, following its curve,
  // with an eyelet at each end of a boot's.
  const strings = [], eyelets = []
  if (laces && ["sneaker", "hightop", "boot"].includes(styleName)) {
    const toeTop = Math.min(...height.slice(Math.round(columns * 0.8), Math.round(columns * 0.92)))
    const throat = []
    for (let c = 0; c < columns; c++) {
      const u = us[c]
      if (open[c] || u < 0.2 || u > 0.82) continue
      if (height[c] > toeTop * 1.12 && height[c] < shaft * (tallShaft ? 0.97 : 1.01)) throat.push(c)
    }
    if (throat.length >= 3) {
      const first = throat[0], last = throat[throat.length - 1]
      // The rows of eyelets are spaced evenly along the throat as it runs (up the steep front of a boot's
      // shaft as well as along the instep), one every couple of centimetres, so a boot laces up its shaft.
      const zOf = c => back + us[c] * length
      const run = [0]
      for (let c = first + 1; c <= last; c++) run.push(run[run.length - 1] + Math.hypot(zOf(c) - zOf(c - 1), height[c] - height[c - 1]))
      const total = run[run.length - 1]
      const pitch = (styleName === "boot" ? 0.021 : 0.02) * s
      const rows = Math.min(styleName === "sneaker" ? 6 : 9, Math.max(3, Math.round(total / pitch)))
      // Each row: the cross-section's top, across part of the shoe's width either side of its middle,
      // between two columns when it falls between them.
      const lines = []
      for (let b = 0; b < rows; b++) {
        const goal = total * ((b + 0.5) / rows)
        let c = first
        while (c < last - 1 && run[c - first + 1] < goal) c++
        const f = Math.min(1, Math.max(0, (goal - run[c - first]) / Math.max(1e-9, run[c - first + 1] - run[c - first])))
        const reach = (width[c] * (1 - f) + width[c + 1] * f) * 0.4, middle = mid[c] * (1 - f) + mid[c + 1] * f
        const tall = (height[c] * (1 - f) + height[c + 1] * f)
        const path = []
        for (let r = 0; r <= around; r++) {
          const a = grid[c][r], b2 = grid[c + 1][r]
          const p = [0, 1, 2].map(d => positions[3 * a + d] * (1 - f) + positions[3 * b2 + d] * f)
          if (Math.abs(p[0] - middle) <= reach && p[1] > floor + tall * 0.7) path.push(p)
        }
        if (path.length < 2) continue
        path.sort((a, b2) => a[0] - b2[0])
        // Along the throat here, and out from the shoe (up, leaning with the slope).
        const along = [0, height[Math.min(columns - 1, c + 1)] - height[Math.max(0, c - 1)], (us[Math.min(columns - 1, c + 1)] - us[Math.max(0, c - 1)]) * length]
        const al = Math.hypot(...along) || 1
        const dir = along.map(v => v / al)
        lines.push({ path, dir, out: [0, dir[2], -dir[1]] })
      }
      // A point on a line, a share of the way across it.
      const across = (line, t) => {
        const lengths = [0]
        for (let k = 1; k < line.path.length; k++) lengths.push(lengths[k - 1] + Math.hypot(...[0, 1, 2].map(d => line.path[k][d] - line.path[k - 1][d])))
        const goal = t * lengths[lengths.length - 1]
        let k = 1
        while (k < line.path.length - 1 && lengths[k] < goal) k++
        const f = (goal - lengths[k - 1]) / Math.max(1e-9, lengths[k] - lengths[k - 1])
        return [0, 1, 2].map(d => line.path[k - 1][d] + f * (line.path[k][d] - line.path[k - 1][d]))
      }
      const halfWide = 0.0035 * s, lift = 0.002 * s
      // A lace: a flat strip from one point to another over the shoe, lifted off it (more in the middle).
      const strip = (from, to, steps = 10) => {
        const base = positions.length / 3
        for (let k = 0; k <= steps; k++) {
          const t = k / steps
          const a = from.at(t), dir = from.dir, out = from.out
          const raise = lift * (1 + 0.8 * Math.sin(Math.PI * t))
          const side = to.side(t)
          for (const w of [-1, 1]) for (const up of [0, 1]) positions.push(...[0, 1, 2].map(d => a[d] + out[d] * raise * (1 + 0.6 * up) + side[d] * halfWide * w))
        }
        for (let k = 0; k < steps; k++) {
          const a = base + 4 * k, b2 = base + 4 * (k + 1)
          quad(strings, a + 1, b2 + 1, b2 + 3, a + 3)
          quad(strings, a, b2, b2 + 1, a + 1)
          quad(strings, a + 2, a + 3, b2 + 3, b2 + 2)
        }
      }
      // Crossed between each row and the next (left to right, right to left), straight across the top row.
      const cross = (p, q, flip) => {
        const at = t => { const a = across(p, flip ? 1 - t : t), b2 = across(q, flip ? t : 1 - t); return [0, 1, 2].map(d => a[d] * (1 - t) + b2[d] * t) }
        const dir = p.dir.map((v, d) => (v + q.dir[d]) / 2), out = p.out.map((v, d) => (v + q.out[d]) / 2)
        strip({ at, dir, out }, { side: () => dir })
      }
      for (let b = 0; b + 1 < lines.length; b++) { cross(lines[b], lines[b + 1], false); cross(lines[b], lines[b + 1], true) }
      const top = lines.at(-1)
      if (top) strip({ at: t => across(top, t), dir: top.dir, out: top.out }, { side: () => top.dir })
      // A boot's metal eyelets at each end of each row.
      if (styleName === "boot") {
        for (const line of lines) {
          for (const end of [line.path[0], line.path[line.path.length - 1]]) {
            const e = 0.0048 * s, at = positions.length / 3
            for (const dx of [-1, 1]) for (const dy of [-1, 1]) for (const dz of [0, 1]) positions.push(end[0] + dx * e * 0.6, end[1] + dy * e * 0.6 * line.dir[1] + dz * lift * 1.8 * line.out[1], end[2] + dy * e * 0.6 * line.dir[2] + dz * lift * 1.8 * line.out[2])
            const v = k => at + k
            for (const [a, b2, c2, d] of [[0, 2, 6, 4], [1, 5, 7, 3], [0, 4, 5, 1], [2, 3, 7, 6], [4, 6, 7, 5]]) quad(eyelets, v(a), v(b2), v(c2), v(d))
          }
        }
      }
    }
  }
  // A boot's padded collar: a roll round the top of the shaft where the leg comes out (the side photo shows
  // it only edge on, and the shaft's top would otherwise be a bare ledge round the leg).
  const collar = []
  const openColumns = us.map((_, c) => c).filter(c => open[c])
  if (tallShaft && style.pad && openColumns.length >= 2) {
    const r = Math.max(0.006 * s, thick * 0.8)
    const zOf = c => back + us[c] * length
    const first = openColumns[0], last = openColumns[openColumns.length - 1]
    // The roll's path: along each wall's top, in from its edge, and round the front and the back.
    const loop = []
    const wallAt = (c, sign) => [mid[c] + sign * (width[c] - r * 0.6), floor + height[c] - r * 0.35, zOf(c)]
    const bend = (c, from, to) => {
      const rad = width[c] - r * 0.6, y = floor + height[c] - r * 0.35
      for (let k = 1; k < 8; k++) { const a = from + ((to - from) * k) / 8; loop.push([mid[c] + rad * Math.cos(a), y, zOf(c) + rad * Math.sin(a) * 0.7]) }
    }
    for (const c of openColumns) loop.push(wallAt(c, 1))
    bend(last, 0, Math.PI)
    for (const c of [...openColumns].reverse()) loop.push(wallAt(c, -1))
    bend(first, Math.PI, 2 * Math.PI)
    // Swept as a tube, a little flatter than it is wide.
    const segments = 10, base = positions.length / 3, n = loop.length
    const centre = loop.reduce((acc, p) => [acc[0] + p[0] / n, 0, acc[2] + p[2] / n], [0, 0, 0])
    for (let k = 0; k < n; k++) {
      const p = loop[k], q = loop[(k + 1) % n], o = loop[(k - 1 + n) % n]
      const t = normalize3([q[0] - o[0], 0, q[2] - o[2]])
      let b = [t[2], 0, -t[0]]
      if ((p[0] - centre[0]) * b[0] + (p[2] - centre[2]) * b[2] < 0) b = b.map(v => -v)
      for (let j = 0; j < segments; j++) {
        const a = (2 * Math.PI * j) / segments
        positions.push(p[0] + b[0] * r * Math.cos(a), p[1] + 0.75 * r * Math.sin(a), p[2] + b[2] * r * Math.cos(a))
      }
    }
    for (let k = 0; k < n; k++) {
      const kn = (k + 1) % n
      for (let j = 0; j < segments; j++) {
        const jn = (j + 1) % segments
        quad(collar, base + k * segments + j, base + kn * segments + j, base + kn * segments + jn, base + k * segments + jn)
      }
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex([...sole, ...upper, ...strings, ...collar, ...eyelets])
  geometry.addGroup(0, sole.length, 0)
  geometry.addGroup(sole.length, upper.length, 1)
  let at = sole.length + upper.length
  if (strings.length) geometry.addGroup(at, strings.length, 2)
  at += strings.length
  if (collar.length) geometry.addGroup(at, collar.length, 3)
  at += collar.length
  if (eyelets.length) geometry.addGroup(at, eyelets.length, 4)
  geometry.computeVertexNormals()
  // Built to the photo's own scale: wrapShoePhoto lays it on exactly.
  geometry.userData.photo = { floor, back, length, metres }
  return geometry
}

// A shoe's points by column, heel to toe: its floor, back and front, and its top in each of bins columns.
function shoeColumns(p, bins) {
  const n = p.length / 3
  let floor = Infinity, back = Infinity, front = -Infinity
  for (let i = 0; i < n; i++) { floor = Math.min(floor, p[3 * i + 1]); back = Math.min(back, p[3 * i + 2]); front = Math.max(front, p[3 * i + 2]) }
  const along = z => Math.min(1, Math.max(0, (z - back) / (front - back || 1)))
  const tops = new Float64Array(bins)
  for (let i = 0; i < n; i++) {
    const b = Math.min(bins - 1, Math.floor(along(p[3 * i + 2]) * bins))
    tops[b] = Math.max(tops[b], p[3 * i + 1] - floor)
  }
  for (let b = 1; b < bins; b++) if (!tops[b]) tops[b] = tops[b - 1]
  for (let b = bins - 2; b >= 0; b--) if (!tops[b]) tops[b] = tops[b + 1]
  // Smoothed, so a lace or a lug standing up doesn't crumple the shoe or the photo on it.
  return { floor, back, front, tops: soften(soften(tops)), bins, along }
}

// A list blurred over its neighbours, two either side.
function soften(list) {
  const k = [1, 4, 6, 4, 1], n = list.length
  return Array.from(list, (_, b) => k.reduce((sum, w, d) => sum + w * list[Math.min(n - 1, Math.max(0, b + d - 2))], 0) / 16)
}

function lerpAt(list, u) {
  const f = u * (list.length - 1), b = Math.min(list.length - 2, Math.floor(f)), t = f - b
  return list[b] * (1 - t) + list[b + 1] * t
}

// Wraps a shoe's side photo round its 3D shoe (see print.js's shoeTexture): each point takes the photo's
// pixel as far from heel to toe, and as far up from the floor to the shoe's top there, as it is on the 3D
// shoe. Fitting the photo's outline to the shoe's column by column keeps the logo, stitching and sole where
// they are on the real one, whatever the two shapes' differences. Seen from the inside of the foot, the
// photo shows mirrored. Sets the geometry's uv.
//
// What the side photo shows edge on (the top of the toe, the laces, the toe's and the heel's ends) would all
// take the outline's last pixels and smear. Those parts are rolled in from the outline instead: a point takes
// the photo's pixel as far in from the outline (against the way it faces) as the point is in from the shoe's
// side, so the top of the toe shows the leather near the photo's top edge and the laces the laces.
//
// Even rolled in, the photo is only true for what faces the side, so each point also gets aPhoto (1 facing the
// side, down to 0 facing the front, the back or up) and uvPlain: where in the photo its plain colour is, in
// from the outline and its details (stage.js#wearShoePhoto blends the photo into that colour by aPhoto).
const EDGE_IN = 0.025
const ROLL = 0.75
export function wrapShoePhoto(geometry, side, { views = [], foot = "L" } = {}) {
  if (!geometry.attributes.normal) geometry.computeVertexNormals()
  const p = geometry.attributes.position.array, n = p.length / 3
  // Facing out, whichever way round the triangles were wound.
  const normals = Float32Array.from(geometry.attributes.normal.array)
  {
    const c = [0, 0, 0]
    for (let i = 0; i < n; i++) for (let d = 0; d < 3; d++) c[d] += p[3 * i + d] / n
    let out = 0
    for (let i = 0; i < n; i++) for (let d = 0; d < 3; d++) out += normals[3 * i + d] * (p[3 * i + d] - c[d])
    if (out < 0) for (let k = 0; k < normals.length; k++) normals[k] = -normals[k]
  }
  const exact = geometry.userData.photo ?? null
  const { floor, back, front, tops, bins, along: alongMesh } = shoeColumns(p, side.top.length)
  const along = exact ? z => Math.min(1, Math.max(0, (z - exact.back) / exact.length)) : alongMesh
  const at = lerpAt
  // Each column's middle and half width across the foot.
  const low = new Float64Array(bins).fill(Infinity), high = new Float64Array(bins).fill(-Infinity)
  for (let i = 0; i < n; i++) {
    const b = Math.min(bins - 1, Math.floor(along(p[3 * i + 2]) * bins))
    low[b] = Math.min(low[b], p[3 * i]); high[b] = Math.max(high[b], p[3 * i])
  }
  for (let b = 1; b < bins; b++) if (!Number.isFinite(low[b])) { low[b] = low[b - 1]; high[b] = high[b - 1] }
  for (let b = bins - 2; b >= 0; b--) if (!Number.isFinite(low[b])) { low[b] = low[b + 1]; high[b] = high[b + 1] }
  const middle = soften(Array.from(low, (l, b) => (l + high[b]) / 2)), half = soften(Array.from(low, (l, b) => (high[b] - l) / 2))
  // The photo's scale: its width (as a share of the photo's) and height (of its height) per metre.
  const length = front - back || 1
  const perX = (side.right - side.left) / length, perY = perX / side.aspect
  const uv = new Float32Array(2 * n), plain = new Float32Array(2 * n), photo = new Float32Array(n)
  const sole = soleVertices(geometry)
  // The 3D sole on the photo's sole, the upper on its upper.
  let soleTop = 0
  for (let i = 0; i < n; i++) if (sole[i]) soleTop = Math.max(soleTop, p[3 * i + 1] - floor)
  const rowAt = (k, y, top3d) => {
    const bottom = at(side.bottom, k), top = at(side.top, k), line = side.sole ? at(side.sole, k) : bottom - (bottom - top) / 7
    if (y <= soleTop) return bottom - (y / (soleTop || 1)) * (bottom - line)
    return line - Math.min(1, (y - soleTop) / Math.max(1e-4, top3d - soleTop)) * (line - top)
  }
  for (let i = 0; i < n; i++) {
    const u = along(p[3 * i + 2])
    {
      const k = EDGE_IN * 4 + u * (1 - 8 * EDGE_IN)
      const y = p[3 * i + 1] - floor, top3d = at(tops, u)
      const into = sole[i] ? y : Math.min(y, soleTop + (top3d - soleTop) * 0.8)
      plain[2 * i] = side.toeRight ? side.left + k * (side.right - side.left) : side.right - k * (side.right - side.left)
      // At its own height, so the bands round the shoe (a collar, a stripe of stitching, the sole) carry on
      // round its heel and toe.
      // (Up off the sole's bottom edge: the photo's floor shadow can lie along it.)
      plain[2 * i + 1] = 1 - (exact ? Math.max(at(side.top, k), at(side.bottom, k) - Math.max(y, soleTop * 0.35) / exact.metres) : rowAt(k, into, top3d))
    }
    // The heel's and the toe's last columns are mostly the photo's soft edge: kept a little in from them.
    let k = EDGE_IN + u * (1 - 2 * EDGE_IN)
    let row = exact ? Math.max(at(side.top, k), at(side.bottom, k) - (p[3 * i + 1] - exact.floor) / exact.metres) : rowAt(k, p[3 * i + 1] - floor, at(tops, u))
    // Rolled in from the outline: against the way the point faces, as far as it is in from the shoe's side.
    const nx = normals[3 * i], nz = normals[3 * i + 2], ny = normals[3 * i + 1], flat = Math.hypot(nz, ny)
    // Only what faces away from the side: the photo shows a side wall as it is.
    const facing = Math.max(0, 1 - Math.abs(nx) / 0.8) ** 2
    photo[i] = Math.min(1, Math.max(0, (Math.abs(nx) - 0.3) / 0.4))
    const inward = Math.max(0, at(half, u) - Math.abs(p[3 * i] - at(middle, u))) * ROLL * facing
    if (inward > 0 && flat > 0.05) {
      k = Math.min(1 - EDGE_IN, Math.max(EDGE_IN, k - (nz / flat) * inward * perX / (side.right - side.left)))
      row += (ny / flat) * inward * perY
      row = Math.min(at(side.bottom, k), Math.max(at(side.top, k), row))
    }
    uv[2 * i] = side.toeRight ? side.left + k * (side.right - side.left) : side.right - k * (side.right - side.left)
    uv[2 * i + 1] = 1 - row
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2))
  geometry.setAttribute("uvPlain", new THREE.BufferAttribute(plain, 2))
  geometry.setAttribute("aPhoto", new THREE.BufferAttribute(photo, 1))
  // The shop's other photos, square on (see print.js's shoeView): from above on what faces up, from behind
  // on the heel, in front on the toe. aViews: how much each shows at each point (side, top, back, front),
  // the rest the plain colour.
  const top = views.find(v => v.kind === "top"), behind = views.find(v => v.kind === "back"), ahead = views.find(v => v.kind === "front")
  // Which shoe of a pair is this foot: the left foot (+x) is on the photo's left from above and behind, on
  // its right in front.
  const pick = (view, leftOnLeft) => view && (view.shoes.length < 2 ? view.shoes[0] : view.shoes[(foot === "L") === leftOnLeft ? 0 : 1])
  const shoes = { top: pick(top, true), back: pick(behind, true), front: pick(ahead, false) }
  let tallest = 0
  for (let i = 0; i < n; i++) tallest = Math.max(tallest, p[3 * i + 1] - floor)
  const rowsAt = (shoe, r) => {
    const f = Math.min(1, Math.max(0, r)) * (shoe.rows.length - 1), k = Math.min(shoe.rows.length - 2, Math.floor(f)), t = f - k
    const a = shoe.rows[k], b = shoe.rows[k + 1]
    return [a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t]
  }
  const uvs = { top: new Float32Array(2 * n), back: new Float32Array(2 * n), front: new Float32Array(2 * n) }, weights = new Float32Array(4 * n)
  for (let i = 0; i < n; i++) {
    const u = along(p[3 * i + 2]), y = p[3 * i + 1] - floor
    const across = Math.max(-1, Math.min(1, (p[3 * i] - at(middle, u)) / (at(half, u) || 1)))
    const nx = normals[3 * i], ny = normals[3 * i + 1], nz = normals[3 * i + 2]
    const put = (name, row, sign) => {
      const shoe = shoes[name], [l, r] = rowsAt(shoe, row)
      // Across the photo the other way from x when looking down or from behind (its right is -x).
      uvs[name][2 * i] = (l + r) / 2 + sign * across * (r - l) / 2 * 0.86
      uvs[name][2 * i + 1] = 1 - (shoe.top + Math.min(0.98, Math.max(0.02, row)) * (shoe.bottom - shoe.top))
    }
    // Kept in from the photo's outline (a welt standing out round the sole, seen from above).
    if (shoes.top) put("top", 0.05 + 0.9 * (shoes.top.toeUp ? 1 - u : u), -1)
    if (shoes.back) put("back", 1 - y / (tallest || 1), -1)
    if (shoes.front) put("front", 1 - y / (tallest || 1), 1)
    // The side photo where the shoe faces the side; where it turns to the heel or the toe, the photo from
    // that end when there is one (else the side photo, rolled in, and the plain colour).
    const ends = (shoes.back && nz < 0) || (shoes.front && nz > 0)
    const w = [
      ends ? Math.max(0, (Math.abs(nx) - 0.6) / 0.3) : Math.max(0, (Math.abs(nx) - 0.45) / 0.35),
      // Not the sole's top edge (the welt): seen from above it's the photo's outline, mostly backdrop.
      // Nor the top of a shaft: from above, that's the lining and the insole inside it.
      shoes.top && !sole[i] ? Math.max(0, (ny - 0.3) / 0.4) * (1 - Math.min(1, Math.max(0, (y / (tallest || 1) - 0.8) / 0.12))) : 0,
      shoes.back ? Math.max(0, (-nz - 0.2) / 0.4) : 0,
      shoes.front ? Math.max(0, (nz - 0.2) / 0.4) : 0
    ].map(v => Math.min(1, v) ** 2)
    // Round the very heel and toe the side photo only smears (its outline seen edge on): the plain colour.
    w[0] *= Math.min(1, Math.max(0, (u - 0.02) / 0.08)) * Math.min(1, Math.max(0, (0.98 - u) / 0.06))
    const sum = w.reduce((a, b) => a + b, 0)
    // Never more than all of it; what's left is the plain colour.
    for (let c = 0; c < 4; c++) weights[4 * i + c] = sum > 1 ? w[c] / sum : w[c]
  }
  geometry.setAttribute("uvTop", new THREE.BufferAttribute(uvs.top, 2))
  geometry.setAttribute("uvBack", new THREE.BufferAttribute(uvs.back, 2))
  geometry.setAttribute("uvFront", new THREE.BufferAttribute(uvs.front, 2))
  geometry.setAttribute("aViews", new THREE.BufferAttribute(weights, 4))
  return geometry
}

// Which points are on the sole (group 0).
function soleVertices(geometry) {
  const on = new Uint8Array(geometry.attributes.position.count), index = geometry.index.array
  for (const group of geometry.groups) if (group.materialIndex === 0) for (let k = group.start; k < group.start + group.count; k++) on[index[k]] = 1
  return on
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
