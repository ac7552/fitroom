import "./support/lib.mjs"
import test from "node:test"
import assert from "node:assert/strict"

const { softenHead, weldMap, weldedNormals } = await import("lib/mannequin_surface")

// A cube's six faces, each with its own four corners (as a texture's seams split a mesh): 24 vertices at 8
// places, outward faces.
function splitCube() {
  const faces = [[[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]], [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]],
    [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]], [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]],
    [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]]
  const positions = [], normals = [], index = []
  faces.forEach((corners, f) => {
    const n = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]][f]
    for (const c of corners) { positions.push(...c); normals.push(...n) }
    index.push(4 * f, 4 * f + 1, 4 * f + 2, 4 * f, 4 * f + 2, 4 * f + 3)
  })
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), index: Uint32Array.from(index) }
}

test("a seam's copies of a point get one normal, smooth, of unit length, facing out as before", () => {
  const { positions, normals, index } = splitCube()
  assert.equal(new Set(weldMap(positions)).size, 8)
  const out = weldedNormals(positions, index, normals)
  for (let i = 0; i < 24; i++) {
    const n = [out[3 * i], out[3 * i + 1], out[3 * i + 2]], p = [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]]
    assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-6)
    // At a corner, the normal leans out along the corner's diagonal, the same at all three of its copies.
    assert.ok(n[0] * p[0] + n[1] * p[1] + n[2] * p[2] > 1.2, `vertex ${i}: ${n}`)
  }
})

test("the head is softened and keeps its size; the body below it isn't touched", () => {
  // A bumpy sphere for a head (radius about 0.1 m, at 1.65 m) on top of a ring of body points (below 1.5 m).
  const rows = 24, cols = 32, positions = [], head = [], index = []
  for (let r = 0; r <= rows; r++) for (let c = 0; c < cols; c++) {
    const theta = Math.PI * r / rows, phi = 2 * Math.PI * c / cols
    const bump = 1 + 0.08 * ((r + c) % 2 ? 1 : -1)
    const radius = 0.1 * bump
    positions.push(radius * Math.sin(theta) * Math.cos(phi), 1.65 + radius * Math.cos(theta), radius * Math.sin(theta) * Math.sin(phi))
    head.push(1)
  }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const a = r * cols + c, b = r * cols + (c + 1) % cols, d = (r + 1) * cols + c, e = (r + 1) * cols + (c + 1) % cols
    index.push(a, d, b, b, d, e)
  }
  const body = positions.length / 3
  positions.push(0, 1.4, 0.1)
  head.push(0)
  const p = Float32Array.from(positions), before = Float32Array.from(p)
  softenHead([p], p, Uint32Array.from(index), Float32Array.from(head))
  const radii = (arr, from, to) => { const out = []; for (let i = from; i < to; i++) out.push(Math.hypot(arr[3 * i], arr[3 * i + 1] - 1.65, arr[3 * i + 2])); return out }
  const spread = v => { const m = v.reduce((s, x) => s + x, 0) / v.length; return [m, Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length)] }
  const [meanBefore, bumpsBefore] = spread(radii(before, cols, body - cols)), [meanAfter, bumpsAfter] = spread(radii(p, cols, body - cols))
  assert.ok(bumpsAfter < bumpsBefore * 0.5, `bumps ${bumpsBefore} to ${bumpsAfter}`)
  assert.ok(Math.abs(meanAfter - meanBefore) < 0.004, `size ${meanBefore} to ${meanAfter}`)
  assert.deepEqual(Array.from(p.slice(3 * body)), Array.from(before.slice(3 * body)))
})
