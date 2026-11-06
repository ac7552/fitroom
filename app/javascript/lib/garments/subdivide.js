// Butterfly subdivision of a triangle mesh, one level at a time (see fine.js, which builds the render mesh
// from it). No DOM or three.js here, so it can be tested in Node.

// One level of butterfly subdivision of a triangle mesh with `count` points and triangles `tris` (flat
// indices, groupOf[t] their material): { count, index, groupOf, first (the first new point's index), ends
// (Int32Array, each new point's edge's two ends), stencilStart/stencilIndex/stencilWeight (each new point's
// position stencil) }.
export function subdivide(count, tris, groupOf) {
  const edgeId = new Map()
  const ends = [], faces = []   // per edge: [a, b], [triangle indices]
  const key = (a, b) => (a < b ? a * count + b : b * count + a)
  const edgeOf = (a, b, t) => {
    const k = key(a, b)
    let e = edgeId.get(k)
    if (e === undefined) { e = ends.length / 2; edgeId.set(k, e); ends.push(Math.min(a, b), Math.max(a, b)); faces.push([]) }
    faces[e].push(t)
    return e
  }
  const triEdges = new Int32Array(tris.length)
  for (let t = 0; t < tris.length; t += 3) {
    triEdges[t] = edgeOf(tris[t], tris[t + 1], t / 3)
    triEdges[t + 1] = edgeOf(tris[t + 1], tris[t + 2], t / 3)
    triEdges[t + 2] = edgeOf(tris[t + 2], tris[t], t / 3)
  }
  // The point of a triangle not on an edge.
  const opposite = (t, a, b) => { for (let k = 0; k < 3; k++) { const v = tris[3 * t + k]; if (v !== a && v !== b) return v } return -1 }
  // The point across edge (a, b) from triangle t, through the triangle on its other side, or -1 at the outline.
  const across = (a, b, t) => {
    const e = edgeId.get(key(a, b))
    const other = faces[e].find(f => f !== t)
    return other === undefined ? -1 : opposite(other, a, b)
  }
  const stencilStart = [0], stencilIndex = [], stencilWeight = []
  const m = ends.length / 2
  for (let e = 0; e < m; e++) {
    const a = ends[2 * e], b = ends[2 * e + 1]
    const entries = []
    if (faces[e].length === 2) {
      const [t0, t1] = faces[e]
      const c = opposite(t0, a, b), d = opposite(t1, a, b)
      const outer = [[a, c, t0], [b, c, t0], [a, d, t1], [b, d, t1]].map(([p, q, t]) => across(p, q, t))
      // All eight there: the butterfly. Any cut off by the outline: the plain midpoint (the butterfly with
      // points missing isn't flat on flat cloth).
      if (outer.every(o => o >= 0)) entries.push([a, 0.5], [b, 0.5], [c, 0.125], [d, 0.125], ...outer.map(o => [o, -0.0625]))
      else entries.push([a, 0.5], [b, 0.5])
    } else entries.push([a, 0.5], [b, 0.5])
    for (const [i, w] of entries) { stencilIndex.push(i); stencilWeight.push(w) }
    stencilStart.push(stencilIndex.length)
  }
  const index = [], nextGroup = []
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2]
    const ab = count + triEdges[t], bc = count + triEdges[t + 1], ca = count + triEdges[t + 2]
    index.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca)
    for (let k = 0; k < 4; k++) nextGroup.push(groupOf[t / 3])
  }
  return {
    count: count + m, index, groupOf: Uint8Array.from(nextGroup), first: count, ends: Int32Array.from(ends),
    stencilStart: Int32Array.from(stencilStart), stencilIndex: Int32Array.from(stencilIndex), stencilWeight: Float32Array.from(stencilWeight)
  }
}
