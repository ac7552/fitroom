// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import "./support/lib.mjs"

const { Drape } = await import("lib/garments/drape")
const { SkinField } = await import("lib/garments/body")
const { buildCloth } = await import("lib/garments/cloth")
const { KERNEL_ON } = await import("lib/garments/cloth_kernel")

// A ball of skin 30 cm across at the origin, as a SkinField.
function ball(r = 0.15, rows = 24, cols = 48) {
  const positions = [], normals = [], index = []
  for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) {
    const phi = (j / rows) * Math.PI, theta = (i / cols) * 2 * Math.PI
    const n = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)]
    positions.push(n[0] * r, n[1] * r, n[2] * r); normals.push(...n)
  }
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const a = j * (cols + 1) + i, b = a + 1, c = a + cols + 1, d = c + 1
    index.push(a, c, b, b, c, d)
  }
  return new SkinField(Float32Array.from(positions), Float32Array.from(normals), Uint32Array.from(index))
}

// A 50 × 50 cm square of cloth, held 2 cm above the ball, let fall onto it.
function sheet() {
  const line = (a, b) => Array.from({ length: 11 }, (_, k) => [a[0] + ((b[0] - a[0]) * k) / 10, a[1] + ((b[1] - a[1]) * k) / 10])
  const pattern = { panels: { sheet: { edges: [
    { name: "bottom", points: line([-25, -25], [25, -25]) }, { name: "right", points: line([25, -25], [25, 25]) },
    { name: "top", points: line([25, 25], [-25, 25]) }, { name: "left", points: line([-25, 25], [-25, -25]) }
  ], place: { at: "body" } } }, seams: [] }
  const cloth = buildCloth(pattern, 2)
  const start = Float32Array.from(cloth.points.flatMap(([x, y]) => [x / 100, 0.17, y / 100]))
  return { cloth, start }
}

test("the cloth solver comes out the same in WebAssembly as in JavaScript", { skip: !KERNEL_ON && "no WebAssembly" }, () => {
  const field = ball()
  const { cloth, start } = sheet()
  const js = new Drape(cloth, start, { field }, { fabric: "jersey", kernel: false })
  const wasm = new Drape(cloth, start, { field }, { fabric: "jersey" })
  assert.equal(js.kernel, null)
  assert.ok(wasm.kernel, "the WebAssembly kernel is used")
  js.closeSeams(); wasm.closeSeams()   // (no seams: sets sewn, so the cloth also keeps off itself)
  const apart = () => { let most = 0; for (let i = 0; i < js.x.length; i++) most = Math.max(most, Math.abs(js.x[i] - wasm.x[i])); return most }
  for (let k = 0; k < 90; k++) { js.step({ gravity: true, sew: false }); wasm.step({ gravity: true, sew: false }) }
  let most = apart(), fell = 0
  for (let i = 1; i < js.x.length; i += 3) fell = Math.max(fell, 0.17 - js.x[i])
  assert.ok(fell > 0.05, `the cloth fell ${fell.toFixed(3)} m over the ball`)
  // The same arithmetic in the same order: not near, the same, to the bit.
  assert.equal(most, 0, `the two are ${most} m apart at most`)
  // Nothing inside the ball.
  for (let i = 0; i < wasm.x.length; i += 3) assert.ok(Math.hypot(wasm.x[i], wasm.x[i + 1], wasm.x[i + 2]) > 0.15, "a point inside the ball")
})

test("a drape in WebAssembly takes a new skin field (a new pose) and keeps its arrays", { skip: !KERNEL_ON && "no WebAssembly" }, () => {
  const { cloth, start } = sheet()
  const drape = new Drape(cloth, start, { field: ball(0.1, 8, 16) }, { fabric: "twill" })
  drape.step()
  const before = Float32Array.from(drape.x)
  drape.repose(before, ball(0.15))      // a bigger field: the module's memory grows, the arrays move
  drape.step()
  assert.equal(drape.x.length, before.length)
  assert.ok(drape.x.buffer === drape.kernel.memory.buffer, "the drape's points are in the module's memory")
  assert.ok(drape.x.some((v, i) => v !== before[i]), "it moved")
})
