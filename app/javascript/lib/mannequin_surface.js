// The display mannequin's surface, refined as it loads (FittingStage#load): its normals smooth and in full
// precision, and its face softened. Plain arrays in and out (no three.js), so Node can test it.
//
// The model's normals come quantized to 8 bits a component (the build's meshopt compression), and split
// where its texture's seams cut the mesh: on a white satin form under soft light the first shows as banding
// down a thigh, the second as lines (one ran down the neck). They're worked out again here from the mesh,
// the same at every copy of a point, in floats. And MakeHuman's face, in white, read as a plaster cast of a
// person, lips and eyelids sharp: a little smoothing (Taubin's, which keeps the head's size) softens them
// toward a display form's, as the shop's own mannequins are sculpted.

// Each vertex's first copy: vertices at the same place (a seam's two sides) share one.
export function weldMap(positions) {
  const n = positions.length / 3, rep = new Int32Array(n), seen = new Map()
  for (let i = 0; i < n; i++) {
    const key = `${positions[3 * i].toFixed(5)},${positions[3 * i + 1].toFixed(5)},${positions[3 * i + 2].toFixed(5)}`
    if (!seen.has(key)) seen.set(key, i)
    rep[i] = seen.get(key)
  }
  return rep
}

// Smooth normals: each point's faces' normals summed (area-weighted), the same at every copy of the point,
// each turned to agree with its old normal (reference: the model's own, which face outward). Float32Array.
export function weldedNormals(positions, index, reference, rep = weldMap(positions)) {
  const n = positions.length / 3, sum = new Float64Array(3 * n)
  for (let t = 0; t < index.length; t += 3) {
    const a = rep[index[t]], b = rep[index[t + 1]], c = rep[index[t + 2]]
    const ux = positions[3 * b] - positions[3 * a], uy = positions[3 * b + 1] - positions[3 * a + 1], uz = positions[3 * b + 2] - positions[3 * a + 2]
    const vx = positions[3 * c] - positions[3 * a], vy = positions[3 * c + 1] - positions[3 * a + 1], vz = positions[3 * c + 2] - positions[3 * a + 2]
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    for (const i of [a, b, c]) { sum[3 * i] += nx; sum[3 * i + 1] += ny; sum[3 * i + 2] += nz }
  }
  const out = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) {
    const r = rep[i], x = sum[3 * r], y = sum[3 * r + 1], z = sum[3 * r + 2], length = Math.hypot(x, y, z)
    if (!length) { out[3 * i] = reference[3 * i]; out[3 * i + 1] = reference[3 * i + 1]; out[3 * i + 2] = reference[3 * i + 2]; continue }
    const sign = x * reference[3 * i] + y * reference[3 * i + 1] + z * reference[3 * i + 2] < 0 ? -1 : 1
    out[3 * i] = sign * x / length; out[3 * i + 1] = sign * y / length; out[3 * i + 2] = sign * z / length
  }
  return out
}

// The head's points (head: 1 per vertex of it, the build's _head) smoothed in place, Taubin's way (a step
// in toward the neighbours' mean, then one back out a little further, so the head keeps its size): fields,
// arrays of 3 per vertex moved alike (the positions, and a shape key's offsets that reach the head). Fully
// from `from` up (m, in the model's height), fading out to nothing at `below`, so the neck it meets stays.
export function softenHead(fields, positions, index, head, { iterations = SOFTEN, lambda = 0.5, mu = -0.53, below = 1.53, from = 1.58 } = {}) {
  const n = positions.length / 3, rep = weldMap(positions)
  const neighbours = new Map()
  const link = (a, b) => {
    a = rep[a]; b = rep[b]
    if (a === b) return
    if (!neighbours.has(a)) neighbours.set(a, new Set())
    if (!neighbours.has(b)) neighbours.set(b, new Set())
    neighbours.get(a).add(b); neighbours.get(b).add(a)
  }
  for (let t = 0; t < index.length; t += 3) { link(index[t], index[t + 1]); link(index[t + 1], index[t + 2]); link(index[t + 2], index[t]) }
  const points = [], weights = [], lists = []
  for (const [i, set] of neighbours) {
    if (!(head[i] > 0.5)) continue
    const t = Math.min(1, Math.max(0, (positions[3 * i + 1] - below) / (from - below)))
    if (!t) continue
    points.push(i); weights.push(t * t * (3 - 2 * t)); lists.push(Int32Array.from(set))
  }
  const next = new Float64Array(3 * points.length)
  for (const f of fields) {
    for (let k = 0; k < iterations; k++) for (const step of [lambda, mu]) {
      for (let q = 0; q < points.length; q++) {
        const i = points[q], list = lists[q], s = step * weights[q]
        let x = 0, y = 0, z = 0
        for (const j of list) { x += f[3 * j]; y += f[3 * j + 1]; z += f[3 * j + 2] }
        const m = list.length
        next[3 * q] = f[3 * i] + s * (x / m - f[3 * i])
        next[3 * q + 1] = f[3 * i + 1] + s * (y / m - f[3 * i + 1])
        next[3 * q + 2] = f[3 * i + 2] + s * (z / m - f[3 * i + 2])
      }
      for (let q = 0; q < points.length; q++) { const i = points[q]; f[3 * i] = next[3 * q]; f[3 * i + 1] = next[3 * q + 1]; f[3 * i + 2] = next[3 * q + 2] }
    }
    // Every copy of a point where its first copy went.
    for (let i = 0; i < n; i++) { const r = rep[i]; if (r !== i) { f[3 * i] = f[3 * r]; f[3 * i + 1] = f[3 * r + 1]; f[3 * i + 2] = f[3 * r + 2] } }
  }
  return points.length
}
// Rounds of smoothing on the head: lips and eyelids softened, the face still the model's (many more change
// little more: Taubin's smoothing keeps shapes as broad as the eyes' folds).
const SOFTEN = 30
