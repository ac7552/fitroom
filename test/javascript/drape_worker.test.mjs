// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import "./support/lib.mjs"

const { SkinField } = await import("lib/garments/body")
const { fieldData, fieldFrom } = await import("lib/garments/remote_drape")
const { coloured } = await import("lib/garments/gpu_drape")

// A square of skin 20 cm across facing +z, as a SkinField.
function square() {
  const positions = [], normals = [], index = []
  for (let j = 0; j <= 10; j++) for (let i = 0; i <= 10; i++) { positions.push(i * 0.02 - 0.1, j * 0.02 - 0.1, 0); normals.push(0, 0, 1) }
  for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++) { const a = j * 11 + i; index.push(a, a + 1, a + 12, a, a + 12, a + 11) }
  return new SkinField(Float32Array.from(positions), Float32Array.from(normals), Uint32Array.from(index))
}

test("a collision field sent from the drape worker reads the same on the page", () => {
  const field = square()
  field.layers = square()
  const copy = fieldFrom(structuredClone(fieldData(field)))
  for (const [x, y, z] of [[0, 0, 0.01], [0.03, -0.02, -0.005], [0.09, 0.09, 0.02], [0.5, 0.5, 0.5]]) {
    assert.equal(copy.at(x, y, z), field.at(x, y, z))
    assert.deepEqual(Array.from(copy.hit), Array.from(field.hit))
    assert.equal(copy.layers.at(x, y, z), field.layers.at(x, y, z))
  }
})

test("the GPU's constraints are coloured so no two of one colour share a point, and none is lost", () => {
  // A strip of cloth: points in a row, each joined to the next two.
  const n = 40, pairs = [], rest = []
  for (let i = 0; i < n - 1; i++) { pairs.push(i, i + 1); rest.push(0.01) }
  for (let i = 0; i < n - 2; i++) { pairs.push(i, i + 2); rest.push(0.02) }
  const { threads, colours } = coloured([{ pairs: Int32Array.from(pairs), rest: Float32Array.from(rest), alphaOf: () => 0 }])
  const u = new Uint32Array(threads.buffer)
  assert.equal(colours.reduce((sum, [, count]) => sum + count, 0), rest.length)
  for (const [offset, count] of colours) {
    const seen = new Set()
    for (let k = offset; k < offset + count; k++) {
      for (const point of [u[4 * k], u[4 * k + 1]]) { assert.ok(!seen.has(point), `point ${point} twice in a colour`); seen.add(point) }
    }
  }
  assert.ok(colours.length <= 5, `${colours.length} colours`)
})
