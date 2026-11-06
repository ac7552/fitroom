// Folds from the drape's squeeze. The drape (drape.js) lets squeezed cloth shorten rather than buckle: as
// stiff squeezed as stretched, cloth laid round a body has nowhere to go but out of its surface, and the
// solver flings it. So the drape knows where the cloth is short and which way (dress.js's markStrain: a
// squeeze and a direction tensor per point), and the folds are drawn from that, by the law a thin sheet
// buckles by: squeezed by a share e across a width, it folds into waves of a wavelength set by its bending
// stiffness and thickness, and of the amplitude that takes up the slack, A = (L / pi) * sqrt(e) (a sine of
// wavelength L and amplitude A is longer than its span by about pi^2 A^2 / L^2).
//
// The waves need a phase that runs continuously across the cloth, advancing along the squeeze's direction
// at 2 pi a wavelength: the direction field (a tensor's axis, so with no sign of its own) is given a sign
// that agrees from point to neighbouring point, and the phase is the least-squares integral of it over the
// cloth's edges (a few dozen Gauss-Seidel sweeps, in pattern space, where the cloth is flat). Where nothing
// is squeezed the phase is free and the amplitude nil. Near any edge of a panel (a seam, a hem: two layers
// and stitching, stiffer, and the far side of a seam has its own phase) the amplitude fades to nothing.
//
// The fine mesh (fine.js) lays the folds on: each point out along its normal by A sin(phase), mostly outward.

// A fabric's fold wavelength (cm): jersey's 3.5, longer as the cloth is thicker (as thickness to the 3/4:
// bending stiffness goes as its cube, the wavelength as the fourth root of that) and stiffer to bend.
export function wavelengthFor({ bend = 2e-4, thickness = 0.0035 } = {}) {
  return 3.5 * (thickness / 0.0035) ** 0.75 * (2e-4 / bend) ** 0.25
}

// Squeeze below this is the drape's own slack, not a fold; by this much, the folds are at full amplitude.
const SQUEEZE_FROM = 0.03, SQUEEZE_FULL = 0.12
// Within this of a panel's edge (cm) the folds fade out.
const EDGE_FADE = 4
const SWEEPS = 40

// 0 at a panel's edge, 1 from EDGE_FADE in, smooth between.
function edgeFade(distance) {
  const t = Math.min(1, Math.max(0, distance / EDGE_FADE))
  return t * t * (3 - 2 * t)
}

// points: the cloth's pattern points (cm, [x, y]); triangles: flat indices; tensor: per point [xx, xy, yy]
// of the squeeze directions (markStrain's); squeeze: per point, the most its edges are short (a share);
// toEdge: per point, cm to its panel's outline; wavelength (cm). Returns { phase (radians), amp (m) } per
// point, or null when nothing is squeezed enough to fold.
export function foldField(points, triangles, tensor, squeeze, toEdge, wavelength) {
  const n = points.length
  const amp = new Float32Array(n)
  let any = false
  for (let i = 0; i < n; i++) {
    const e = squeeze[i] - SQUEEZE_FROM
    if (e <= 0) continue
    const fade = edgeFade(toEdge[i])
    const full = Math.min(1, e / (SQUEEZE_FULL - SQUEEZE_FROM))
    // The buckling amplitude, capped at a quarter wavelength (a deeper fold would fold over itself).
    const a = Math.min(wavelength / 4, (wavelength / Math.PI) * Math.sqrt(e)) * fade * (full * full * (3 - 2 * full))
    if (a > 0) { amp[i] = a / 100; any = true }
  }
  if (!any) return null
  // The squeeze direction per point: the tensor's main axis.
  const dir = new Float32Array(2 * n)
  const weight = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const xx = tensor[3 * i], xy = tensor[3 * i + 1], yy = tensor[3 * i + 2]
    const trace = xx + yy
    if (trace < 1e-6) continue
    const angle = 0.5 * Math.atan2(2 * xy, xx - yy)
    dir[2 * i] = Math.cos(angle); dir[2 * i + 1] = Math.sin(angle)
    // How much the direction means: anisotropy of the tensor, times the squeeze.
    weight[i] = Math.min(1, Math.hypot(xx - yy, 2 * xy) / trace) * Math.max(0, squeeze[i] - SQUEEZE_FROM)
  }
  // Neighbours, packed: each point's run in `adjacent` starts at offset[i].
  const degree = new Int32Array(n + 1)
  for (let t = 0; t < triangles.length; t += 3) { degree[triangles[t] + 1] += 2; degree[triangles[t + 1] + 1] += 2; degree[triangles[t + 2] + 1] += 2 }
  const offset = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) offset[i + 1] = offset[i] + degree[i + 1]
  const adjacent = new Int32Array(offset[n]), fill = Int32Array.from(offset.subarray(0, n))
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t], b = triangles[t + 1], c = triangles[t + 2]
    adjacent[fill[a]++] = b; adjacent[fill[a]++] = c; adjacent[fill[b]++] = a; adjacent[fill[b]++] = c; adjacent[fill[c]++] = a; adjacent[fill[c]++] = b
  }
  // The amplitude smoothed over the neighbours, twice: a fold is wider than the drape's points are apart,
  // and one squeezed point among slack ones is a spike, not a fold.
  for (let pass = 0; pass < 2; pass++) {
    const smoothed = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      let sum = amp[i], count = 1
      for (let e = offset[i]; e < offset[i + 1]; e++) { sum += amp[adjacent[e]]; count++ }
      smoothed[i] = sum / count
    }
    // (Faded again at the edges: the smoothing spread a little over them, and a seam's two sides must agree.)
    for (let i = 0; i < n; i++) amp[i] = smoothed[i] * edgeFade(toEdge[i])
  }
  // Signs that agree: from the most squeezed point outward, each neighbour flipped to agree with the point
  // it was reached from.
  const seen = new Uint8Array(n)
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => weight[j] - weight[i])
  const queue = new Int32Array(n)
  for (const start of order) {
    if (seen[start]) continue
    seen[start] = 1
    let head = 0, tail = 0
    queue[tail++] = start
    while (head < tail) {
      const i = queue[head++]
      for (let k = offset[i]; k < offset[i + 1]; k++) {
        const j = adjacent[k]
        if (seen[j]) continue
        seen[j] = 1
        if (dir[2 * i] * dir[2 * j] + dir[2 * i + 1] * dir[2 * j + 1] < 0) { dir[2 * j] = -dir[2 * j]; dir[2 * j + 1] = -dir[2 * j + 1] }
        queue[tail++] = j
      }
    }
  }
  // The phase: least squares over the edges, phase_j - phase_i = k * (mean direction . (r_j - r_i)), by
  // Gauss-Seidel sweeps with over-relaxation, the most squeezed points first. Started from each connected
  // piece's (panel's) mean direction as a plane wave: the sweeps are quick to fix local bends in the field
  // and slow to build a ramp across a whole panel from nothing.
  const k = (2 * Math.PI) / wavelength
  const phase = new Float32Array(n)
  const piece = new Int32Array(n).fill(-1)
  const pieces = []
  for (let start = 0; start < n; start++) {
    if (piece[start] >= 0) continue
    const id = pieces.length
    const mean = { x: 0, y: 0, members: [] }
    pieces.push(mean)
    let head = 0, tail = 0
    queue[tail++] = start; piece[start] = id
    while (head < tail) {
      const i = queue[head++]
      mean.members.push(i)
      mean.x += weight[i] * dir[2 * i]; mean.y += weight[i] * dir[2 * i + 1]
      for (let e = offset[i]; e < offset[i + 1]; e++) { const j = adjacent[e]; if (piece[j] < 0) { piece[j] = id; queue[tail++] = j } }
    }
    const l = Math.hypot(mean.x, mean.y) || 1
    for (const i of mean.members) phase[i] = k * ((mean.x / l) * points[i][0] + (mean.y / l) * points[i][1])
  }
  const target = new Float32Array(offset[n]), w = new Float32Array(offset[n])
  for (let i = 0; i < n; i++) for (let e = offset[i]; e < offset[i + 1]; e++) {
    const j = adjacent[e]
    const dx = 0.5 * (dir[2 * i] + dir[2 * j]), dy = 0.5 * (dir[2 * i + 1] + dir[2 * j + 1])
    const l = Math.hypot(dx, dy) || 1
    target[e] = (k * (dx * (points[j][0] - points[i][0]) + dy * (points[j][1] - points[i][1]))) / l
    w[e] = Math.max(weight[i], weight[j]) + 1e-3
  }
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    for (let o = 0; o < n; o++) {
      const i = order[o]
      let sum = 0, ws = 0
      for (let e = offset[i]; e < offset[i + 1]; e++) { sum += w[e] * (phase[adjacent[e]] - target[e]); ws += w[e] }
      if (ws > 0) phase[i] += 1.6 * (sum / ws - phase[i])
    }
  }
  return { phase, amp }
}
