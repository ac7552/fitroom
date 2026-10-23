// Turns a sewing pattern (see pattern.js) into one piece of cloth to drape: each panel filled with evenly
// spaced triangles, edges that are sewn together cut into the same number of points, and the pairs of points
// that the sewing joins. Pure functions; lengths in cm.
import { area, distanceToOutline, inside, length, resample } from "lib/garments/curves"

// spacing: the cloth's resolution, cm between neighbouring points.
// Returns {
//   points: [[x, y]] pattern coordinates (cm), panel: panel index per point, panels: names,
//   triangles: [[a, b, c]] anticlockwise seen from outside, sewing: [[a, b]] points sewn together,
//   edges: { "panel/edge": [point indices in the edge's order] }, boundary: Uint8Array (1 on a panel's outline),
//   free: [[point indices]] edges not sewn to anything, toFree: Float32Array (each point's distance from the
//   nearest free edge of its panel, cm: hems are turned up and stitched, so the cloth there is stiffer),
//   toEdge: Float32Array (each point's distance from its panel's outline, cm, for drawing the seams)
// }
export function buildCloth(pattern, spacing = 1.6) {
  const counts = edgeCounts(pattern, spacing)
  const points = [], panel = [], triangles = [], edges = {}, boundary = [], toEdge = []
  const names = Object.keys(pattern.panels)

  names.forEach((name, panelIndex) => {
    const edgeList = pattern.panels[name].edges
    // The outline: each edge resampled, corners once.
    const ring = []
    const edgeRing = []   // for each edge, the ring positions of its points
    for (const e of edgeList) {
      const pts = resample(e.points, counts[`${name}/${e.name}`])
      const start = ring.length
      ring.push(...pts.slice(0, -1))
      edgeRing.push(pts.map((_, i) => start + i))
    }
    // The last point of each edge is the first of the next.
    for (const r of edgeRing) r[r.length - 1] = r[r.length - 1] % ring.length
    if (area(ring) < 0) throw new Error(`panel ${name} runs clockwise`)

    const base = points.length
    const interior = lattice(ring, spacing)
    const all = [...ring, ...interior]
    for (const p of all) {
      points.push(p)
      panel.push(panelIndex)
      boundary.push(0)
      toEdge.push(distanceToOutline(p, ring))
    }
    for (let i = 0; i < ring.length; i++) boundary[base + i] = 1
    for (const [a, b, c] of triangulate(all, ring.length, spacing)) triangles.push([base + a, base + b, base + c])
    edgeList.forEach((e, i) => { edges[`${name}/${e.name}`] = edgeRing[i].map(j => base + j) })
  })

  const sewing = []
  for (const [pa, ea, pb, eb] of pattern.seams) {
    const a = edges[`${pa}/${ea}`], b = edges[`${pb}/${eb}`]
    if (!a || !b) throw new Error(`unknown seam ${pa}/${ea} + ${pb}/${eb}`)
    if (a.length !== b.length) throw new Error(`seam ${pa}/${ea} + ${pb}/${eb} has ${a.length} and ${b.length} points`)
    for (let i = 0; i < a.length; i++) {
      const j = b[b.length - 1 - i]
      if (a[i] !== j) sewing.push([a[i], j])
    }
  }
  const panelFabric = names.map(name => pattern.panels[name].fabric)
  // Edges that aren't sewn to anything: hems, cuffs' rims, the collar's top edge, the hood's face opening.
  const sewnEdges = new Set(pattern.seams.flatMap(([pa, ea, pb, eb]) => [`${pa}/${ea}`, `${pb}/${eb}`]))
  const freeEntries = Object.entries(edges).filter(([key]) => !sewnEdges.has(key))
  const free = freeEntries.map(([, idx]) => idx)
  // The turned-up hems among them (weighted and stiffened in the drape): not a dress's armholes, neckline or
  // top edge, which are faced and stay soft (a strap that's all stiff hem can't bend over the shoulder).
  const soft = /\/(?:armhole|neck|top)/
  const hemRuns = freeEntries.filter(([key]) => !soft.test(key)).map(([, idx]) => idx)
  const toHem = new Float32Array(points.length).fill(Infinity)
  for (const run of hemRuns) {
    const owner = panel[run[0]]
    for (let i = 0; i < points.length; i++) {
      if (panel[i] !== owner) continue
      for (let k = 1; k < run.length; k++) toHem[i] = Math.min(toHem[i], toSegment(points[i], points[run[k - 1]], points[run[k]]))
    }
  }
  const toFree = new Float32Array(points.length).fill(Infinity)
  for (const run of free) {
    const owner = panel[run[0]]
    for (let i = 0; i < points.length; i++) {
      if (panel[i] !== owner) continue
      for (let k = 1; k < run.length; k++) toFree[i] = Math.min(toFree[i], toSegment(points[i], points[run[k - 1]], points[run[k]]))
    }
  }
  return {
    points, panel, panels: names, panelFabric, triangles, sewing, edges, free, toFree, toHem,
    toEdge: Float32Array.from(toEdge), boundary: Uint8Array.from(boundary)
  }
}

// How many points each edge is cut into: enough for the spacing, and the same for two edges sewn together.
function edgeCounts(pattern, spacing) {
  const counts = {}
  for (const [name, p] of Object.entries(pattern.panels)) {
    for (const e of p.edges) counts[`${name}/${e.name}`] = Math.max(2, Math.ceil(length(e.points) / spacing) + 1)
  }
  // Seams can chain (a band's ends meet each other), so repeat until every pair agrees.
  for (let pass = 0; pass < 4; pass++) {
    for (const [pa, ea, pb, eb] of pattern.seams) {
      const a = `${pa}/${ea}`, b = `${pb}/${eb}`
      const n = Math.max(counts[a], counts[b])
      counts[a] = counts[b] = n
    }
  }
  return counts
}

// Points on a triangular lattice inside the outline, kept clear of it. Each row of the lattice is cut where it
// crosses the outline, and kept between the crossings.
function lattice(ring, spacing) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of ring) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
  }
  const rowHeight = spacing * Math.sqrt(3) / 2
  const tooNear = nearOutline(ring, spacing * 0.55)
  const out = []
  let row = 0
  for (let y = minY + rowHeight / 2; y < maxY; y += rowHeight, row++) {
    const crossings = []
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j]
      if ((yi > y) !== (yj > y)) crossings.push(xi + ((y - yi) * (xj - xi)) / (yj - yi))
    }
    crossings.sort((a, b) => a - b)
    const start = minX + (row % 2 ? spacing / 2 : 0) + spacing / 4
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const from = Math.ceil((crossings[k] - start) / spacing), to = Math.floor((crossings[k + 1] - start) / spacing)
      for (let q = from; q <= to; q++) {
        const x = start + q * spacing
        if (x > crossings[k] && x < crossings[k + 1] && !tooNear(x, y)) out.push([x, y])
      }
    }
  }
  return out
}

// A quick test of whether a point is within `radius` of an outline: its segments filed in a grid.
function nearOutline(ring, radius) {
  const cell = 2 * radius
  const grid = new Map()
  const key = (ix, iy) => ix * 100003 + iy
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j], [bx, by] = ring[i]
    const x0 = Math.floor((Math.min(ax, bx) - radius) / cell), x1 = Math.floor((Math.max(ax, bx) + radius) / cell)
    const y0 = Math.floor((Math.min(ay, by) - radius) / cell), y1 = Math.floor((Math.max(ay, by) + radius) / cell)
    for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) {
      const k = key(ix, iy)
      if (!grid.has(k)) grid.set(k, [])
      grid.get(k).push(j, i)
    }
  }
  return (x, y) => {
    const list = grid.get(key(Math.floor(x / cell), Math.floor(y / cell)))
    if (!list) return false
    for (let k = 0; k < list.length; k += 2) {
      if (toSegment([x, y], ring[list[k]], ring[list[k + 1]]) < radius) return true
    }
    return false
  }
}

// Delaunay triangulation (Bowyer–Watson) of the points, keeping the triangles inside the outline (its first
// `ringCount` points, in order). Each triangle is filed in a grid by its circumcircle, so finding the ones a
// new point breaks only looks near it. Returns anticlockwise triangles.
export function triangulate(points, ringCount, spacing) {
  const ring = points.slice(0, ringCount)
  const n = points.length
  // A tiny, repeatable jitter keeps the lattice from having four points on one circle.
  const X = new Float64Array(n + 3), Y = new Float64Array(n + 3)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < n; i++) {
    X[i] = points[i][0] + 1e-5 * Math.sin(i * 12.9898)
    Y[i] = points[i][1] + 1e-5 * Math.cos(i * 78.233)
    minX = Math.min(minX, X[i]); maxX = Math.max(maxX, X[i]); minY = Math.min(minY, Y[i]); maxY = Math.max(maxY, Y[i])
  }
  const d = Math.max(maxX - minX, maxY - minY) * 10
  const mx = (minX + maxX) / 2, my = (minY + maxY) / 2
  X[n] = mx - d; Y[n] = my - d; X[n + 1] = mx + d; Y[n + 1] = my - d; X[n + 2] = mx; Y[n + 2] = my + d

  const cell = 2 * spacing
  const cols = Math.ceil((maxX - minX) / cell) + 1, rows = Math.ceil((maxY - minY) / cell) + 1
  const buckets = Array.from({ length: cols * rows }, () => [])
  let big = []
  const ta = [], tb = [], tc = [], tx = [], ty = [], tr = [], alive = []
  const add = (a, b, c) => {
    const ax = X[a], ay = Y[a], bx = X[b], by = Y[b], cx = X[c], cy = Y[c]
    const den = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy
    const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / den
    const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / den
    const r2 = (ax - ux) ** 2 + (ay - uy) ** 2
    const t = ta.length
    ta.push(a); tb.push(b); tc.push(c); tx.push(ux); ty.push(uy); tr.push(r2); alive.push(1)
    const r = Math.sqrt(r2)
    if (!(r < 4 * cell)) { big.push(t); return }
    const x0 = Math.max(0, Math.floor((ux - r - minX) / cell)), x1 = Math.min(cols - 1, Math.floor((ux + r - minX) / cell))
    const y0 = Math.max(0, Math.floor((uy - r - minY) / cell)), y1 = Math.min(rows - 1, Math.floor((uy + r - minY) / cell))
    for (let iy = y0; iy <= y1; iy++) for (let ix = x0; ix <= x1; ix++) buckets[iy * cols + ix].push(t)
  }
  add(n, n + 1, n + 2)

  const bad = [], hole = new Map()
  for (let i = 0; i < n; i++) {
    const px = X[i], py = Y[i]
    bad.length = 0
    const check = t => {
      if (alive[t] && (px - tx[t]) ** 2 + (py - ty[t]) ** 2 < tr[t]) { alive[t] = 0; bad.push(t) }
    }
    const k = Math.min(rows - 1, Math.floor((py - minY) / cell)) * cols + Math.min(cols - 1, Math.floor((px - minX) / cell))
    for (const t of buckets[k]) check(t)
    for (const t of big) check(t)
    if (big.length > 64 && i % 16 === 0) big = big.filter(t => alive[t])
    // The hole's boundary: edges of the broken triangles not shared by two of them.
    hole.clear()
    for (const t of bad) {
      for (const [a, b] of [[ta[t], tb[t]], [tb[t], tc[t]], [tc[t], ta[t]]]) {
        const key = a < b ? a * (n + 3) + b : b * (n + 3) + a
        const seen = hole.get(key)
        if (seen) seen[2]++
        else hole.set(key, [a, b, 1])
      }
    }
    for (const [a, b, count] of hole.values()) if (count === 1) add(a, b, i)
  }

  const out = []
  for (let t = 0; t < ta.length; t++) {
    if (!alive[t]) continue
    const ia = ta[t], ib = tb[t], ic = tc[t]
    if (ia >= n || ib >= n || ic >= n) continue
    const a = points[ia], b = points[ib], c = points[ic]
    // Slivers along the outline.
    if (Math.max(dist(a, b), dist(b, c), dist(c, a)) > spacing * 3.2) continue
    // A triangle touching the outline can lie outside it, joining outline points round a concave stretch.
    if (ia < ringCount || ib < ringCount || ic < ringCount) {
      if (!inside([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3], ring)) continue
      const mids = [[(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2], [(c[0] + a[0]) / 2, (c[1] + a[1]) / 2]]
      if (mids.some(m => !inside(m, ring) && distanceToOutline(m, ring) > spacing * 0.05)) continue
    }
    const ccw = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0
    out.push(ccw ? [ia, ib, ic] : [ia, ic, ib])
  }
  return out
}

function toSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const l = dx * dx + dy * dy
  const t = l ? Math.min(Math.max(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l, 0), 1) : 0
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t)
}

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}
