// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import "./support/lib.mjs"

const { subdivide } = await import("lib/garments/subdivide")
const { foldField, wavelengthFor } = await import("lib/garments/wrinkles")

// A flat grid of w by h points (1 cm apart), triangulated.
function grid(w, h) {
  const points = [], tris = []
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) points.push([x, y])
  for (let y = 0; y + 1 < h; y++) for (let x = 0; x + 1 < w; x++) {
    const a = y * w + x, b = a + 1, c = a + w, d = c + 1
    tris.push(a, b, d, a, d, c)
  }
  return { points, tris }
}

test("one level of subdivision: a point per edge, four triangles per triangle, stencils that sum to one", () => {
  const { points, tris } = grid(5, 4)
  const groupOf = new Uint8Array(tris.length / 3)
  const level = subdivide(points.length, tris, groupOf)
  // Edges of a 5 by 4 grid: 4*4 across + 5*3 down + 4*3 diagonals.
  assert.equal(level.count, points.length + 16 + 15 + 12)
  assert.equal(level.index.length, tris.length * 4)
  for (let k = 0; k + 1 < level.stencilStart.length; k++) {
    let sum = 0
    for (let s = level.stencilStart[k]; s < level.stencilStart[k + 1]; s++) sum += level.stencilWeight[s]
    assert.ok(Math.abs(sum - 1) < 1e-6)
  }
  // An edge on the outline takes its plain midpoint (so two panels' seams meet); an inside one eight points.
  const ends = level.ends
  for (let k = 0; k < ends.length / 2; k++) {
    const a = points[ends[2 * k]], b = points[ends[2 * k + 1]]
    const onOutline = [a, b].every(([x, y]) => x === 0 || x === 4 || y === 0 || y === 3) && (a[0] === b[0] || a[1] === b[1])
    const size = level.stencilStart[k + 1] - level.stencilStart[k]
    if (onOutline) assert.equal(size, 2, `edge ${a}-${b}`)
  }
  assert.ok(Array.from({ length: ends.length / 2 }, (_, k) => level.stencilStart[k + 1] - level.stencilStart[k]).some(size => size === 8))
})

test("a flat sheet stays flat and in place under subdivision", () => {
  const { points, tris } = grid(6, 6)
  const level = subdivide(points.length, tris, new Uint8Array(tris.length / 3))
  const pos = new Float32Array(3 * level.count)
  points.forEach(([x, y], i) => { pos[3 * i] = x; pos[3 * i + 1] = y; pos[3 * i + 2] = 0 })
  for (let k = 0; k < level.ends.length / 2; k++) {
    const o = 3 * (level.first + k)
    for (let s = level.stencilStart[k]; s < level.stencilStart[k + 1]; s++) {
      const j = 3 * level.stencilIndex[s], w = level.stencilWeight[s]
      pos[o] += w * pos[j]; pos[o + 1] += w * pos[j + 1]; pos[o + 2] += w * pos[j + 2]
    }
    const a = points[level.ends[2 * k]], b = points[level.ends[2 * k + 1]]
    assert.ok(Math.abs(pos[o] - (a[0] + b[0]) / 2) < 1e-5 && Math.abs(pos[o + 1] - (a[1] + b[1]) / 2) < 1e-5 && Math.abs(pos[o + 2]) < 1e-6)
  }
})

test("folds: squeezed across x, the phase advances along x at a wavelength, amplitude by the buckling law, none at the edges", () => {
  const { points, tris } = grid(21, 15)
  const n = points.length
  const tensor = new Float32Array(3 * n), squeeze = new Float32Array(n), toEdge = new Float32Array(n)
  points.forEach(([x, y], i) => {
    tensor[3 * i] = 0.1   // squeezed along x only
    squeeze[i] = 0.1
    toEdge[i] = Math.min(x, 20 - x, y, 14 - y)
  })
  const wavelength = 4
  const { phase, amp } = foldField(points, Uint32Array.from(tris), tensor, squeeze, toEdge, wavelength)
  // Along a middle row, phase steps 2 pi / 4 a cm.
  const row = 7
  const steps = []
  for (let x = 5; x < 15; x++) steps.push(phase[row * 21 + x + 1] - phase[row * 21 + x])
  for (const step of steps) assert.ok(Math.abs(Math.abs(step) - Math.PI / 2) < 0.05, `${step}`)
  // Across rows, none.
  assert.ok(Math.abs(phase[8 * 21 + 10] - phase[7 * 21 + 10]) < 0.05)
  // A = (L / pi) sqrt(e - 0.03) at full squeeze, in metres; nothing at the outline, fading in over 2.5 cm.
  const inside = amp[7 * 21 + 10]
  const t = 0.07 / 0.09, ramp = t * t * (3 - 2 * t)   // 0.1 squeezed: most of the way to full folds (0.12)
  assert.ok(Math.abs(inside - ((wavelength / Math.PI) * Math.sqrt(0.07) * ramp) / 100) < 0.00005, `${inside}`)
  assert.equal(amp[0], 0)
  assert.equal(amp[7 * 21], 0)
  assert.ok(amp[7 * 21 + 2] < inside / 2)
})

test("fold wavelength: thicker and stiffer cloth folds wider", () => {
  const jersey = wavelengthFor({ bend: 2e-4, thickness: 0.0035 })
  assert.ok(Math.abs(jersey - 3.5) < 1e-9)
  assert.ok(wavelengthFor({ bend: 1.6e-5, thickness: 0.005 }) > 8)   // denim
  assert.ok(wavelengthFor({ bend: 5e-4, thickness: 0.0025 }) < 2.5)   // silk
})
