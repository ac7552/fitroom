// A garment's texture atlas: each pattern panel laid in its own place on a square, no two overlapping, so
// what the cloth's shader makes of every point (its colour, its surface) can be written out as maps
// (DrapedTop#bake) and read back by the path tracer (trace.js) from plain uv.
//
// The panels' outlines are rectangles in pattern space (cm); they're packed on shelves, tallest first,
// into the smallest square that takes them, with a gutter between (so a map's texel filtering can't reach
// from one panel into the next).

// The gutter between panels (cm): wide enough for a mip level or two of a 2048 texel atlas.
const GUTTER = 3

// cloth: cloth.js's (points in cm, panel per point, panels' names). Returns { uv: Float32Array (2 per point,
// 0 to 1), side (cm: the square's side, so texels per cm is the map's size over it), places: per panel
// { x, y, w, h } (cm, in the square) }.
export function packPanels(cloth) {
  const n = cloth.points.length, count = cloth.panels.length
  const boxes = Array.from({ length: count }, () => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }))
  for (let i = 0; i < n; i++) {
    const b = boxes[cloth.panel[i]], [x, y] = cloth.points[i]
    b.x0 = Math.min(b.x0, x); b.x1 = Math.max(b.x1, x); b.y0 = Math.min(b.y0, y); b.y1 = Math.max(b.y1, y)
  }
  const rects = boxes.map((b, p) => ({ p, w: (Number.isFinite(b.x0) ? b.x1 - b.x0 : 0) + GUTTER, h: (Number.isFinite(b.y0) ? b.y1 - b.y0 : 0) + GUTTER }))
  const order = rects.filter(r => r.w > GUTTER && r.h > GUTTER).sort((a, b) => b.h - a.h || b.w - a.w)
  // Shelves: the smallest square side that takes them all, found by trying sides up from the area's root.
  const area = order.reduce((sum, r) => sum + r.w * r.h, 0)
  const widest = Math.max(...order.map(r => r.w), ...order.map(r => r.h), 1)
  let side = Math.max(widest, Math.sqrt(area))
  let placed = null
  for (let tries = 0; tries < 60 && !placed; tries++, side *= 1.04) placed = shelves(order, side)
  if (!placed) { side = widest * Math.ceil(Math.sqrt(order.length)); placed = shelves(order, side) }
  const places = boxes.map(() => null)
  for (const { r, x, y } of placed) places[r.p] = { x: x + GUTTER / 2, y: y + GUTTER / 2, w: r.w - GUTTER, h: r.h - GUTTER }
  const uv = new Float32Array(2 * n)
  for (let i = 0; i < n; i++) {
    const p = cloth.panel[i], place = places[p], b = boxes[p]
    if (!place) continue
    uv[2 * i] = (place.x + (cloth.points[i][0] - b.x0)) / side
    uv[2 * i + 1] = (place.y + (cloth.points[i][1] - b.y0)) / side
  }
  return { uv, side, places }
}

// Shelf packing into a square of `side`: null when they don't fit.
function shelves(rects, side) {
  const out = []
  let x = 0, y = 0, shelf = 0
  for (const r of rects) {
    if (x + r.w > side) { y += shelf; x = 0; shelf = 0 }
    if (y + r.h > side || r.w > side) return null
    out.push({ r, x, y })
    x += r.w
    shelf = Math.max(shelf, r.h)
  }
  return out
}
