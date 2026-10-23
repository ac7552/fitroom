// Small 2D geometry helpers for drafting patterns: points are [x, y] arrays in centimetres.

export function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

export function distance(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1])
}

// A cubic Bézier from p0 to p3, as `count` points (ends included).
export function bezier(p0, p1, p2, p3, count = 24) {
  const out = []
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1), u = 1 - t
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
    ])
  }
  return out
}

export function line(a, b) {
  return [a.slice(), b.slice()]
}

export function length(points) {
  let total = 0
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i])
  return total
}

// `count` points spaced evenly along a polyline, ends included.
export function resample(points, count) {
  if (count < 2) count = 2
  const along = [0]
  for (let i = 1; i < points.length; i++) along.push(along[i - 1] + distance(points[i - 1], points[i]))
  const total = along[along.length - 1]
  const out = []
  let j = 1
  for (let k = 0; k < count; k++) {
    const target = (total * k) / (count - 1)
    while (j < points.length - 1 && along[j] < target) j++
    const span = along[j] - along[j - 1] || 1
    out.push(lerp(points[j - 1], points[j], Math.min(Math.max((target - along[j - 1]) / span, 0), 1)))
  }
  return out
}

export function reversed(points) {
  return points.slice().reverse()
}

// The points mirrored across x = 0 (a pattern piece cut on the fold).
export function mirrored(points) {
  return points.map(([x, y]) => [-x, y])
}

// Signed area: positive when the outline runs anticlockwise.
export function area(points) {
  let total = 0
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length]
    total += x1 * y2 - x2 * y1
  }
  return total / 2
}

// Whether a point is inside a closed outline (even-odd rule).
export function inside(point, outline) {
  const [x, y] = point
  let result = false
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [xi, yi] = outline[i], [xj, yj] = outline[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) result = !result
  }
  return result
}

// Shortest distance from a point to a closed outline.
export function distanceToOutline(point, outline) {
  let best = Infinity
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    best = Math.min(best, distanceToSegment(point, outline[j], outline[i]))
  }
  return best
}

export function distanceToSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const span = dx * dx + dy * dy
  const t = span === 0 ? 0 : Math.min(Math.max(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / span, 0), 1)
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}
