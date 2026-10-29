// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import "./support/lib.mjs"

const { Drape } = await import("lib/garments/drape")
const { SkinField } = await import("lib/garments/body")
const { buildCloth } = await import("lib/garments/cloth")

// A square of skin far off (the cloth never meets it), as a SkinField.
function farSkin() {
  const positions = [], normals = [], index = []
  for (let j = 0; j <= 2; j++) for (let i = 0; i <= 2; i++) { positions.push(i * 0.1, j * 0.1, -5); normals.push(0, 0, 1) }
  for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) { const a = j * 3 + i; index.push(a, a + 1, a + 4, a, a + 4, a + 3) }
  return new SkinField(Float32Array.from(positions), Float32Array.from(normals), Uint32Array.from(index))
}

test("cloth left a little short in places folds there, rather than shaking itself apart", () => {
  // A 40 × 60 cm sheet laid over a ball 50 cm round: no flat sheet fits a ball, so its rows start squeezed
  // towards its top and bottom (a skirt laid round a body is the same, a little, here and there).
  const line = (a, b) => Array.from({ length: 11 }, (_, k) => [a[0] + ((b[0] - a[0]) * k) / 10, a[1] + ((b[1] - a[1]) * k) / 10])
  const pattern = { panels: { sheet: { edges: [
    { name: "bottom", points: line([-20, -60], [20, -60]) }, { name: "right", points: line([20, -60], [20, 0]) },
    { name: "top", points: line([20, 0], [-20, 0]) }, { name: "left", points: line([-20, 0], [-20, -60]) }
  ], place: { at: "body" } } }, seams: [] }
  const cloth = buildCloth(pattern, 2)
  const R = 0.25
  const start = cloth.points.flatMap(([x, y]) => {
    const theta = x / 100 / R, phi = (y + 30) / 100 / R
    return [R * Math.sin(theta) * Math.cos(phi), R * Math.sin(phi), R * Math.cos(theta) * Math.cos(phi)]
  })
  const drape = new Drape(cloth, start, { field: farSkin() }, { fabric: "twill" })
  for (let k = 0; k < 12; k++) drape.step({ gravity: 0, sew: false, still: true })
  // Let go, it eases into its folds; pushed back as hard as it's pulled, its squeezed rows would buckle faster
  // every small step instead, to metres a second, and keep shaking.
  const fastest = []
  for (let k = 0; k < 90; k++) {
    drape.step({ gravity: 0, sew: false })
    const v = drape.v
    let most = 0
    for (let i = 0; i < v.length; i += 3) most = Math.max(most, Math.hypot(v[i], v[i + 1], v[i + 2]))
    fastest.push(most)
  }
  const early = Math.max(...fastest.slice(0, 30)), late = Math.max(...fastest.slice(60))
  assert.ok(early < 3, `fastest at first ${early.toFixed(2)} m/s`)
  assert.ok(late < 0.5, `fastest at the end ${late.toFixed(2)} m/s`)
})
