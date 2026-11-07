// A shoe's shape from all its photos: its visual hull. The shop photographs a shoe from the side, the
// front, the back and above (print.js's shoeSide and shoeView read each one's outline); seen from each
// direction the shoe fills its outline and no more, so the shape that fits every outline at once (a block
// carved by each silhouette in turn) is the shoe's, with the slouch of a cuff, a platform, a heel's stem and
// a pointed toe as photographed, rather than the foot plus a thickness. A side photo alone gives only a
// lofted shell (accessories.js's photoShoeGeometry); this takes over when there's at least one more view.
//
// The carve is a voxel block, HULL_CELLS cells along the shoe, meshed by surface nets (a vertex per cell the
// surface crosses, a quad across every crossing edge) and smoothed. Metres, in the scene: the side photo's
// sole is the foot's length (with the toe room), the floor is the body's, the shoe stands where the foot
// is. wrapShoePhoto lays the photos on afterwards: it takes any mesh with userData.photo.
import * as THREE from "three"
import { legSlices } from "lib/garments/accessories"

export const HULL_CELLS = 112

// body, frame, side ("L"/"R"): the foot to stand on; outline: shoeSide's reading of the side photo; views:
// shoeView readings (kind top/back/front, with shoes[].silhouette) for the other photos; style: the last
// (accessories.js's), for the toe room and the upper's thickness.
// depth: the side photo's depth map (depth.js's readDepth), or null: with it the visible side takes the
// photo's relief; without, the cross-sections are rounded from the silhouette alone.
export function hullGeometry(body, frame, side, outline, views, style, { depth = null } = {}) {
  const s = (frame.top - frame.floor) / 1.76
  const floor = frame.floor, thick = (style.thick ?? 0.007) * s
  // The foot's reach: heel to toes, from the leg's slices up to the ankle (the heel's back is the furthest
  // back below it, the toes the furthest forward, whether the foot stands flat or is pitched on a heel, when
  // only its toes are near the floor); the leg's, up to the knee, for a shaft.
  const slices = legSlices(body, frame, side, floor + 0.5 * s)
  let zmin = Infinity, zmax = -Infinity, xmin = Infinity, xmax = -Infinity
  // (From the skin's points, which reach below the floor when a heeled foot's toes dip into the toe box.)
  const sign = side === "L" ? 1 : -1
  for (let i = 0; i < body.positions.length / 3; i++) {
    const x = body.positions[3 * i], y = body.positions[3 * i + 1], z = body.positions[3 * i + 2]
    if (frame.part[i] !== 4 || x * sign <= 0 || y >= floor + 0.1 * s) continue
    zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); xmin = Math.min(xmin, x); xmax = Math.max(xmax, x)
  }
  if (!Number.isFinite(zmin)) return null
  const back = zmin - thick - 0.003 * s, front = zmax + thick + (style.toe ?? 0.014) * s
  const length = front - back, centreX = (xmin + xmax) / 2
  // The side photo's scale: the shoe's whole width in it, heel's back to toe's tip, is the foot's length
  // with the toe room. (Not just the columns on the floor: a stiletto's tip is a column wide and can sit a
  // hair above the toe, and a sprung toe lifts off it.)
  const floorLine = Math.max(...outline.bottom), minTop = Math.min(...outline.top)
  const uL = 0, uR = 1
  const span = length
  const origin = back
  const metres = span * outline.aspect / (outline.right - outline.left)   // m per share of the photo's height
  const height = (floorLine - minTop) * metres
  // Each view's silhouette as a function: in the shoe's frame, is (x, y) or (x, z) inside it.
  const top = (views ?? []).find(v => v.kind === "top"), behind = (views ?? []).find(v => v.kind === "back"), ahead = (views ?? []).find(v => v.kind === "front")
  // (A pair: the left-most shoe in the photo. Either foot's shape is the other's mirrored.)
  const shoeIn = view => view?.shoes?.[0] ?? null
  // Rows of a silhouette, top to bottom: [left, right] in shares of the photo's width; the box's height in
  // shares of its height. Scale k: metres per share of height; width shares are height shares / aspect.
  const silhouette = (view, shoe, k, flipX) => {
    // (The rows smoothed a little: a knit's or a fur's edge is ragged, and every jag would be a ridge.)
    const rows = soften(shoe.silhouette), n = rows.length
    const cx = (shoe.left + shoe.right) / 2
    return (across, row) => {   // across: metres from the middle; row: 0 at the box's top to 1 at its bottom
      const r = Math.min(n - 1, Math.max(0, Math.floor(row * n)))
      const span2 = rows[r]
      if (!span2) return false
      const shareX = cx + (flipX ? -across : across) * view.aspect / k
      return shareX >= span2[0] && shareX <= span2[1]
    }
  }
  const topShoe = shoeIn(top), backShoe = shoeIn(behind), frontShoe = shoeIn(ahead)
  // Vertical views: the box's height is the shoe's; a share of height is height / (bottom - top) metres.
  const kBack = backShoe ? height / (backShoe.bottom - backShoe.top) : 0, kFront = frontShoe ? height / (frontShoe.bottom - frontShoe.top) : 0
  const inBack = backShoe ? silhouette(behind, backShoe, kBack, true) : null
  const inFront = frontShoe ? silhouette(ahead, frontShoe, kFront, false) : null
  // From above: the box's height is the shoe's length along the photo (its whole outline, shaft and all).
  const kTop = topShoe ? span / (topShoe.bottom - topShoe.top) : 0
  const inTop = topShoe ? silhouette(top, topShoe, kTop, !topShoe.toeUp) : null
  // The width the carve starts from: the widest the front, back or top view shows, else the foot's and a
  // margin.
  let widest = (xmax - xmin) / 2 + thick + 0.012 * s
  for (const [shoe, k, view] of [[backShoe, kBack, behind], [frontShoe, kFront, ahead], [topShoe, kTop, top]]) {
    if (!shoe) continue
    let w = 0
    for (const r of shoe.silhouette) if (r) w = Math.max(w, (r[1] - r[0]) * k / view.aspect)
    widest = Math.max(widest, w / 2 + 0.002)
  }
  // How wide the shoe may be at each point, across the foot: the leg's own half-width plus the upper's
  // thickness up a shaft, the foot's at the ball tapering to the toe below the ankle (a pointed toe, a
  // small `square`, tapers further), or wider where the front, back or top photo shows it so.
  const legHalfAt = y => {
    const k = Math.min(slices.rows - 1, Math.max(0, Math.round((y - floor) / 0.005)))
    let lo = Infinity, hi = -Infinity
    for (let j = 0; j < slices.reach[k].length; j++) { const x = slices.centres[k][0] + slices.reach[k][j] * Math.sin((j / slices.reach[k].length) * 2 * Math.PI); lo = Math.min(lo, x); hi = Math.max(hi, x) }
    return hi > lo ? (hi - lo) / 2 : (xmax - xmin) / 2
  }
  const footHalf = (xmax - xmin) / 2 + thick
  const tip = Math.min(0.95, Math.max(0.25, ((style.square ?? 2) - 1.3) * 0.9))
  const ankleY = floor + 0.1 * s
  const capAt = (u, y) => {
    const along = (u - uL) / Math.max(1e-6, uR - uL)   // 0 at the heel's end of the sole, 1 at the toe's
    let foot = footHalf * (along < 0.15 ? 0.78 + 0.22 * (along / 0.15) : along < 0.7 ? 0.9 + 0.1 * ((along - 0.15) / 0.55) : 1 - (1 - tip) * ((along - 0.7) / 0.3))
    if (along < 0 || along > 1) foot = footHalf * 0.75
    const shaft = legHalfAt(y) + thick
    const blend = Math.min(1, Math.max(0, (y - ankleY) / (0.03 * s)))
    return foot * (1 - blend) + Math.max(shaft, foot * 0.6) * blend
  }
  for (let k = 0; k < slices.rows; k++) widest = Math.max(widest, legHalfAt(floor + k * 0.005) + thick + 0.01)
  widest = Math.max(widest, footHalf + 0.01)
  // The foot itself at a height and a place along it: how far it reaches across, either side of the shoe's
  // middle. The shoe always holds the foot a thickness clear (a pointed toe narrows round the toes rather
  // than through them; a photo from above can't shrink the shoe into the foot).
  const footAcross = (y, z) => {
    const k = Math.round((y - floor) / 0.005)
    if (k < 0 || k >= slices.rows) return 0
    const c = slices.centres[k], reach = slices.reach[k], n = reach.length
    let lo = Infinity, hi = -Infinity
    for (let j = 0; j < n; j++) {
      const a0 = (j / n) * 2 * Math.PI, a1 = ((j + 1) % n / n) * 2 * Math.PI
      const x0 = c[0] + reach[j] * Math.sin(a0), z0 = c[1] + reach[j] * Math.cos(a0)
      const x1 = c[0] + reach[(j + 1) % n] * Math.sin(a1), z1 = c[1] + reach[(j + 1) % n] * Math.cos(a1)
      if ((z0 - z) * (z1 - z) > 0 || z0 === z1) continue
      const x = x0 + ((z - z0) / (z1 - z0)) * (x1 - x0)
      lo = Math.min(lo, x); hi = Math.max(hi, x)
    }
    return lo <= hi ? Math.max(Math.abs(lo - centreX), Math.abs(hi - centreX)) : 0
  }
  // The block: cells along z over the side outline's span, y over its height, x over the width.
  const cell = span / HULL_CELLS
  const nz = HULL_CELLS + 2, ny = Math.ceil(height / cell) + 2, nx = Math.ceil((2 * widest) / cell) + 2
  const x0 = centreX - widest - cell, y0 = floor - cell, z0 = origin - cell
  const inside = new Uint8Array(nx * ny * nz)
  const topAt = u => lerp(outline.top, u), bottomAt = u => lerp(outline.bottom, u)
  const ends = outline.front && outline.back ? { front: soften1(outline.front), back: soften1(outline.back) } : null
  // The side silhouette on the block's (z, y) grid, and how far each cell is from its edge: the shoe is
  // rounded from it (a circle's chord at that distance in, capped by the width above), so a stem a
  // centimetre deep is a centimetre wide and a cuff is as full as it is tall.
  const sideIn = new Uint8Array(nz * ny)
  for (let k = 0; k < nz; k++) {
    const z = z0 + (k + 0.5) * cell, u = (z - origin) / span
    if (u < 0 || u > 1) continue
    const yTop = floor + (floorLine - topAt(u)) * metres, yBottom = floor + (floorLine - bottomAt(u)) * metres
    for (let j = 0; j < ny; j++) {
      const y = y0 + (j + 0.5) * cell
      if (y < yBottom || y > yTop) continue
      if (ends) {
        const rowUp = 1 - (y - floor) / height
        const zb = origin + lerp(ends.back, 1 - rowUp) * span, zf = origin + lerp(ends.front, 1 - rowUp) * span
        if (z < zb || z > zf) continue
      }
      sideIn[k * ny + j] = 1
    }
  }
  const dist = distanceIn(sideIn, nz, ny)   // cells, to the nearest cell outside the silhouette
  // The photo's relief, where there is a depth map: what stands nearer or further than its surroundings on
  // the visible side (the fine depth less a blur of it), as a share of the depth's range, over the grid.
  const relief = depth ? reliefGrid(depth, outline, nz, ny, (k, j) => [(z0 + (k + 0.5) * cell - origin) / span, (y0 + (j + 0.5) * cell - floor) / height], sideIn) : null
  const RELIEF = 0.045 * s   // m of half-width per unit of relief (the depth's range is the shoe's own)
  for (let k = 0; k < nz; k++) {
    const z = z0 + (k + 0.5) * cell, u = (z - origin) / span
    if (u < 0 || u > 1) continue
    // Where along the top view this is: toe up means the toe (u = 1) is at the box's top.
    const rowTop = topShoe ? (topShoe.toeUp ? 1 - u : u) : 0
    for (let j = 0; j < ny; j++) {
      if (!sideIn[k * ny + j]) continue
      const y = y0 + (j + 0.5) * cell
      // The shoe holds the foot a thickness clear sideways behind the toe box (its counter and quarters
      // round the heel and the ankle; an open sandal all along), so its walls rise round the foot to the
      // topline. The toe box keeps the photo's shape, a pointed toe and all: the mannequin's rigid foot
      // and thick toes would stand out of a pump's, and its skin inside the shoe isn't drawn instead (see
      // stage.js's coverFeet).
      const walls = style.family === "sandal" ? 1 : Math.min(1, Math.max(0, (0.62 - u) / 0.2))   // fading out before the vamp
      const foot = walls > 0 ? footAcross(y, z) : 0
      const holds = foot > 0 ? (foot + thick * 0.8) * walls : 0
      const rowUp = 1 - (y - floor) / height
      const R = capAt(u, y), t = Math.min(R, dist[k * ny + j] * cell)
      let half = Math.sqrt(Math.max(0, 2 * R * t - t * t))
      if (relief) half = Math.min(R * 1.15, Math.max(half * 0.5, half + relief[k * ny + j] * RELIEF))
      for (let i = 0; i < nx; i++) {
        const x = x0 + (i + 0.5) * cell - centreX
        const inFoot = Math.abs(x) <= holds
        if (!inFoot) {
          if (Math.abs(x) > half) continue
          if (inTop && !inTop(x, rowTop)) continue
          if (inBack && !inBack(x, rowUp)) continue
          if (inFront && !inFront(x, rowUp)) continue
        }
        inside[(k * ny + j) * nx + i] = 1
      }
    }
  }
  // (For the harness: the carved half-width, and the foot's, at tenths along the shoe, low down.)
  const widths = []
  for (let tenth = 0; tenth <= 10; tenth++) {
    const k = Math.min(nz - 1, Math.max(0, Math.round((tenth / 10 * span + origin - z0) / cell - 0.5)))
    let w = 0
    for (let j = 0; j < ny && y0 + (j + 0.5) * cell < floor + 0.05 * s; j++) for (let i = 0; i < nx; i++) if (inside[(k * ny + j) * nx + i]) w = Math.max(w, Math.abs(x0 + (i + 0.5) * cell - centreX))
    widths.push(Math.round(w * 1000))
  }
  // Is a point (metres, the body's frame) within the carved shoe (for stage.js's coverFeet).
  const within = (x, y, z) => {
    const i = Math.floor((x - x0) / cell), j = Math.floor((y - y0) / cell), k = Math.floor((z - z0) / cell)
    return i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz && inside[(k * ny + j) * nx + i] === 1
  }
  const mesh = surfaceNets(inside, nx, ny, nz, (i, j, k) => [x0 + i * cell, y0 + j * cell, z0 + k * cell])
  if (!mesh) return null
  smooth(mesh.positions, mesh.index, 6)
  // Wound outward: a closed mesh wound the other way has a negative volume.
  if (signedVolume(mesh.positions, mesh.index) < 0) for (let t = 0; t < mesh.index.length; t += 3) { const b = mesh.index[t + 1]; mesh.index[t + 1] = mesh.index[t + 2]; mesh.index[t + 2] = b }
  // The sole's rows (group 0) up to the side photo's sole line, the upper above.
  const soleTop = u => floor + (floorLine - (outline.sole ? lerp(outline.sole, u) : bottomAt(u) - (bottomAt(u) - topAt(u)) / 7)) * metres
  const sole = [], upper = []
  const p = mesh.positions
  for (let t = 0; t < mesh.index.length; t += 3) {
    let y = 0, z = 0
    for (let c = 0; c < 3; c++) { y += p[3 * mesh.index[t + c] + 1] / 3; z += p[3 * mesh.index[t + c] + 2] / 3 }
    const u = Math.min(1, Math.max(0, (z - origin) / span))
    ;(y < soleTop(u) ? sole : upper).push(mesh.index[t], mesh.index[t + 1], mesh.index[t + 2])
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(p, 3))
  geometry.setIndex([...sole, ...upper])
  geometry.addGroup(0, sole.length, 0)
  geometry.addGroup(sole.length, upper.length, 1)
  geometry.computeVertexNormals()
  geometry.userData.photo = { floor, back: origin, length: span, metres, top: u => floor + (floorLine - topAt(u)) * metres, within, centreX, widest, hull: { views: (views ?? []).map(v => v.kind), relief: Boolean(depth), cells: [nx, ny, nz], widths, sole: [+uL.toFixed(3), +uR.toFixed(3)], span: +span.toFixed(3), length: +length.toFixed(3), height: +height.toFixed(3), topRows: topShoe ? soften(topShoe.silhouette).filter((_, i, a) => i % Math.ceil(a.length / 12) === 0).map(r => r && r.map(v => +v.toFixed(3))) : null } }
  return geometry
}

// Rows of [left, right] with a 5-row running mean over their neighbours (nulls skipped).
function soften(rows) {
  return rows.map((row, r) => {
    if (!row) return null
    let l = 0, rr = 0, n = 0
    for (let d = -2; d <= 2; d++) { const q = rows[r + d]; if (q) { l += q[0]; rr += q[1]; n++ } }
    return [l / n, rr / n]
  })
}

function soften1(list) {
  return list.map((v, r) => { let sum = 0, n = 0; for (let d = -1; d <= 1; d++) { const q = list[r + d]; if (q !== null && q !== undefined) { sum += q; n++ } } return n ? sum / n : v })
}

// A chamfer distance over a 2D mask (nz columns by ny rows, index k * ny + j): each inside cell's distance
// in cells to the nearest outside cell, two passes.
function distanceIn(mask, nz, ny) {
  const INF = 1e9, d = new Float32Array(nz * ny)
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? INF : 0
  const at = (k, j) => (k < 0 || j < 0 || k >= nz || j >= ny ? 0 : d[k * ny + j])
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
    const i = k * ny + j
    if (!d[i]) continue
    d[i] = Math.min(d[i], at(k - 1, j) + 1, at(k, j - 1) + 1, at(k - 1, j - 1) + 1.414, at(k - 1, j + 1) + 1.414)
  }
  for (let k = nz - 1; k >= 0; k--) for (let j = ny - 1; j >= 0; j--) {
    const i = k * ny + j
    if (!d[i]) continue
    d[i] = Math.min(d[i], at(k + 1, j) + 1, at(k, j + 1) + 1, at(k + 1, j + 1) + 1.414, at(k + 1, j - 1) + 1.414)
  }
  return d
}

// The depth map's relief on the block's grid: the depth at each cell (sampled where that cell falls in the
// photo) less a wide blur of it over the silhouette, so a fold or a stem stands out from the shoe's overall
// slope toward the camera. at(k, j) gives [u along the shoe, v up it in shares].
function reliefGrid(depth, outline, nz, ny, at, mask) {
  const floorLine = Math.max(...outline.bottom), minTop = Math.min(...outline.top), tall = floorLine - minTop
  const raw = new Float32Array(nz * ny)
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
    const i = k * ny + j
    if (!mask[i]) continue
    const [u, v] = at(k, j)
    const px = outline.toeRight ? outline.left + u * (outline.right - outline.left) : outline.right - u * (outline.right - outline.left)
    const py = floorLine - v * tall
    raw[i] = sampleDepth(depth, px, py)
  }
  // A box blur over the silhouette, radius a tenth of the height.
  const r = Math.max(2, Math.round(ny * 0.1)), blur = new Float32Array(nz * ny)
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
    const i = k * ny + j
    if (!mask[i]) continue
    let sum = 0, n = 0
    for (let dk = -r; dk <= r; dk += 2) for (let dj = -r; dj <= r; dj += 2) {
      const kk = k + dk, jj = j + dj
      if (kk < 0 || jj < 0 || kk >= nz || jj >= ny || !mask[kk * ny + jj]) continue
      sum += raw[kk * ny + jj]; n++
    }
    blur[i] = n ? sum / n : raw[i]
  }
  const out = new Float32Array(nz * ny)
  for (let i = 0; i < out.length; i++) if (mask[i]) out[i] = raw[i] - blur[i]
  return out
}

function sampleDepth(depth, u, v) {
  const x = Math.min(depth.w - 1, Math.max(0, u * (depth.w - 1))), y = Math.min(depth.h - 1, Math.max(0, v * (depth.h - 1)))
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(depth.w - 1, x0 + 1), y1 = Math.min(depth.h - 1, y0 + 1)
  const fx = x - x0, fy = y - y0, d = depth.data
  return (d[y0 * depth.w + x0] * (1 - fx) + d[y0 * depth.w + x1] * fx) * (1 - fy) + (d[y1 * depth.w + x0] * (1 - fx) + d[y1 * depth.w + x1] * fx) * fy
}

function signedVolume(p, index) {
  let v = 0
  for (let t = 0; t < index.length; t += 3) {
    const a = 3 * index[t], b = 3 * index[t + 1], c = 3 * index[t + 2]
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])
  }
  return v / 6
}

function lerp(list, u) {
  const f = Math.min(list.length - 1, Math.max(0, u * (list.length - 1))), k = Math.floor(f), t = f - k
  return k + 1 < list.length ? list[k] * (1 - t) + list[k + 1] * t : list[k]
}

// Surface nets over a binary grid: one vertex in every cell the surface crosses (the mean of the midpoints
// of its crossing edges), a quad for every grid edge whose ends differ, between the four cells round it.
// at(i, j, k): the world position of grid point (i, j, k). Triangles wound outward (from inside to outside).
function surfaceNets(inside, nx, ny, nz, at) {
  const index3 = (i, j, k) => (k * ny + j) * nx + i
  const cellIndex = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1)
  const cellOf = (i, j, k) => (k * (ny - 1) + j) * (nx - 1) + i
  const positions = []
  const corner = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]]
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const v = corner.map(([a, b, c]) => inside[index3(i + a, j + b, k + c)])
    let sum = 0
    for (const x of v) sum += x
    if (sum === 0 || sum === 8) continue
    let px = 0, py = 0, pz = 0, n = 0
    for (const [a, b] of edges) {
      if (v[a] === v[b]) continue
      const pa = at(i + corner[a][0], j + corner[a][1], k + corner[a][2]), pb = at(i + corner[b][0], j + corner[b][1], k + corner[b][2])
      px += (pa[0] + pb[0]) / 2; py += (pa[1] + pb[1]) / 2; pz += (pa[2] + pb[2]) / 2; n++
    }
    cellIndex[cellOf(i, j, k)] = positions.length / 3
    positions.push(px / n, py / n, pz / n)
  }
  if (!positions.length) return null
  const index = []
  const quad = (a, b, c, d, flip) => { if (flip) index.push(a, c, b, a, d, c); else index.push(a, b, c, a, c, d) }
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const here = inside[index3(i, j, k)]
    // The edge along x from (i, j, k) to (i + 1, j, k): the cells round it differ in j and k.
    if (i + 1 < nx && inside[index3(i + 1, j, k)] !== here) {
      const c = [cellOf(i, j - 1, k - 1), cellOf(i, j, k - 1), cellOf(i, j, k), cellOf(i, j - 1, k)].map(c => cellIndex[c])
      if (c.every(v => v >= 0)) quad(c[0], c[1], c[2], c[3], here === 1)
    }
    if (j + 1 < ny && inside[index3(i, j + 1, k)] !== here) {
      const c = [cellOf(i - 1, j, k - 1), cellOf(i, j, k - 1), cellOf(i, j, k), cellOf(i - 1, j, k)].map(c => cellIndex[c])
      if (c.every(v => v >= 0)) quad(c[0], c[1], c[2], c[3], here === 0)
    }
    if (k + 1 < nz && inside[index3(i, j, k + 1)] !== here) {
      const c = [cellOf(i - 1, j - 1, k), cellOf(i, j - 1, k), cellOf(i, j, k), cellOf(i - 1, j, k)].map(c => cellIndex[c])
      if (c.every(v => v >= 0)) quad(c[0], c[1], c[2], c[3], here === 1)
    }
  }
  return { positions: Float32Array.from(positions), index }
}

// Laplacian smoothing: each vertex moved halfway to the mean of its neighbours, `times` over.
function smooth(positions, index, times) {
  const n = positions.length / 3
  const neighbours = Array.from({ length: n }, () => new Set())
  for (let t = 0; t < index.length; t += 3) {
    const [a, b, c] = [index[t], index[t + 1], index[t + 2]]
    neighbours[a].add(b).add(c); neighbours[b].add(a).add(c); neighbours[c].add(a).add(b)
  }
  const next = new Float32Array(positions.length)
  for (let pass = 0; pass < times; pass++) {
    for (let i = 0; i < n; i++) {
      const near = neighbours[i]
      if (!near.size) { for (let d = 0; d < 3; d++) next[3 * i + d] = positions[3 * i + d]; continue }
      let x = 0, y = 0, z = 0
      for (const j of near) { x += positions[3 * j]; y += positions[3 * j + 1]; z += positions[3 * j + 2] }
      next[3 * i] = (positions[3 * i] + x / near.size) / 2
      next[3 * i + 1] = (positions[3 * i + 1] + y / near.size) / 2
      next[3 * i + 2] = (positions[3 * i + 2] + z / near.size) / 2
    }
    positions.set(next)
  }
}
