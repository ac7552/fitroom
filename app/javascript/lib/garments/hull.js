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
export function hullGeometry(body, frame, side, outline, views, style) {
  const s = (frame.top - frame.floor) / 1.76
  const floor = frame.floor, thick = (style.thick ?? 0.007) * s
  // The foot's reach: heel to toes, low down, from the leg's slices (as the photo loft).
  const slices = legSlices(body, frame, side, floor + 0.06 * s)
  let zmin = Infinity, zmax = -Infinity, xmin = Infinity, xmax = -Infinity
  for (let k = 0; k < slices.rows && k * 0.005 < 0.05 * s; k++) {
    for (let j = 0; j < slices.reach[k].length; j++) {
      const a = (j / slices.reach[k].length) * 2 * Math.PI, r = slices.reach[k][j]
      const x = slices.centres[k][0] + r * Math.sin(a), z = slices.centres[k][1] + r * Math.cos(a)
      zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); xmin = Math.min(xmin, x); xmax = Math.max(xmax, x)
    }
  }
  if (!Number.isFinite(zmin)) return null
  const back = zmin - thick - 0.003 * s, front = zmax + thick + (style.toe ?? 0.014) * s
  const length = front - back, centreX = (xmin + xmax) / 2
  // The side photo's scale: its sole (the columns on the floor) is the foot's length.
  const bins = outline.top.length
  const floorLine = Math.max(...outline.bottom), minTop = Math.min(...outline.top)
  let firstSole = -1, lastSole = -1
  for (let b = 0; b < bins; b++) if (outline.bottom[b] >= floorLine - 0.06 * (floorLine - minTop)) { if (firstSole < 0) firstSole = b; lastSole = b }
  const uL = firstSole >= 0 ? firstSole / bins : 0, uR = lastSole >= 0 ? (lastSole + 1) / bins : 1
  const span = length / Math.max(0.4, uR - uL)
  const origin = back - uL * span
  const metres = span * outline.aspect / (outline.right - outline.left)   // m per share of the photo's height
  const height = (floorLine - minTop) * metres
  // Each view's silhouette as a function: in the shoe's frame, is (x, y) or (x, z) inside it.
  const top = views.find(v => v.kind === "top"), behind = views.find(v => v.kind === "back"), ahead = views.find(v => v.kind === "front")
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
  // The block: cells along z over the side outline's span, y over its height, x over the width.
  const cell = span / HULL_CELLS
  const nz = HULL_CELLS + 2, ny = Math.ceil(height / cell) + 2, nx = Math.ceil((2 * widest) / cell) + 2
  const x0 = centreX - widest - cell, y0 = floor - cell, z0 = origin - cell
  const inside = new Uint8Array(nx * ny * nz)
  const topAt = u => lerp(outline.top, u), bottomAt = u => lerp(outline.bottom, u)
  const ends = outline.front && outline.back ? { front: soften1(outline.front), back: soften1(outline.back) } : null
  for (let k = 0; k < nz; k++) {
    const z = z0 + (k + 0.5) * cell, u = (z - origin) / span
    if (u < 0 || u > 1) continue
    const yTop = floor + (floorLine - topAt(u)) * metres, yBottom = floor + (floorLine - bottomAt(u)) * metres
    // Where along the top view this is: toe up means the toe (u = 1) is at the box's top.
    const rowTop = topShoe ? (topShoe.toeUp ? 1 - u : u) : 0
    for (let j = 0; j < ny; j++) {
      const y = y0 + (j + 0.5) * cell
      if (y < yBottom || y > yTop) continue
      // And row by row (the side outline's back and front edge at this height): where the edge is steep
      // (the toe's front, a heel's back) the columns alone would make terraces.
      const rowUp = 1 - (y - floor) / height
      if (ends) {
        const zb = origin + lerp(ends.back, 1 - rowUp) * span, zf = origin + lerp(ends.front, 1 - rowUp) * span
        if (z < zb || z > zf) continue
      }
      for (let i = 0; i < nx; i++) {
        const x = x0 + (i + 0.5) * cell - centreX
        if (inTop && !inTop(x, rowTop)) continue
        if (inBack && !inBack(x, rowUp)) continue
        if (inFront && !inFront(x, rowUp)) continue
        inside[(k * ny + j) * nx + i] = 1
      }
    }
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
  geometry.userData.photo = { floor, back: origin, length: span, metres, hull: { views: views.map(v => v.kind), cells: [nx, ny, nz] } }
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
