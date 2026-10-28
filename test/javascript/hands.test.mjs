// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import "./support/lib.mjs"

const { handShape, keepOffHands } = await import("lib/garments/body")

// A hand hanging beside the hip, as a box of vertices: palm toward the body. side 1 the left (+x), -1 the
// right. Its middle line is 21.5 cm out from the body's middle, 3 cm thick across, 8 cm front to back, from
// the wrist at 90 cm down to its end at 72 cm.
function hangingHand(side = 1) {
  const x = 0.215 * side
  const chain = [[0.19 * side, 1.45, 0], [0.21 * side, 1.15, 0], [x, 0.9, 0], [x, 0.72, 0]]
  const points = []
  for (let y = 0.9; y >= 0.72 - 1e-9; y -= 0.01) {
    for (const dx of [-0.015, 0, 0.015]) for (const z of [-0.04, -0.02, 0, 0.02, 0.04]) points.push(x + dx * side, y, z)
  }
  // And the forearm above the wrist (not part of the hand).
  for (let y = 0.92; y <= 1.1; y += 0.02) points.push(x, y, 0.02)
  const positions = Float32Array.from(points)
  const part = new Uint8Array(positions.length / 3).fill(side > 0 ? 1 : 2)
  return { positions, part, arm: { chain } }
}

test("a hand's slab: from the wrist to its end, its inner face toward the body's middle", () => {
  const { positions, part, arm } = hangingHand(1)
  const hand = handShape(positions, part, 1, arm, () => 0)
  assert.ok(Math.abs(hand.length - 0.18) < 1e-6)
  assert.deepEqual(hand.inward.map(v => Math.round(v * 1000) / 1000), [-1, 0, 0])
  assert.deepEqual(hand.along.map(v => Math.round(v * 1000) / 1000), [0, -1, 0])
  for (let s = 0; s < hand.inner.length; s++) {
    assert.ok(Math.abs(hand.inner[s] - 0.015) < 1e-4 && Math.abs(hand.outer[s] + 0.015) < 1e-4, `step ${s}: ${hand.inner[s]}, ${hand.outer[s]}`)
    assert.ok(Math.abs(hand.hi[s] - hand.lo[s] - 0.08) < 1e-4, `step ${s} across`)
  }
  // No hand vertices, no hand.
  assert.equal(handShape(positions, part, 2, arm, () => 0), null)
})

test("pants' cloth over or through a hand goes to the body's side of it; cloth elsewhere stays put", () => {
  const left = hangingHand(1), right = hangingHand(-1)
  const hands = {
    L: handShape(left.positions, left.part, 1, left.arm, () => 0),
    R: handShape(right.positions, right.part, 2, right.arm, () => 0)
  }
  const thick = 0.003
  const points = [
    [0.215, 0.8, 0],      // 0: right through the left hand
    [0.236, 0.8, 0.03],   // 1: lying over its outside, a few mm off it
    [-0.22, 0.75, -0.02], // 2: through the right hand
    [0.3, 0.8, 0],        // 3: well out past the hand
    [0.17, 0.8, 0],       // 4: between the hand and the leg already
    [0.215, 0.95, 0],     // 5: above the wrist (the forearm's)
    [0.215, 0.8, 0.09],   // 6: in front of the hand
    [0.215, 0.69, 0]      // 7: below the fingertips
  ]
  const p = Float32Array.from(points.flat())
  const moved = keepOffHands(p, hands, thick)
  assert.equal(moved, 3)
  const at = i => [p[3 * i], p[3 * i + 1], p[3 * i + 2]].map(v => Math.round(v * 10000) / 10000)
  assert.deepEqual(at(0), [0.2 - thick, 0.8, 0])
  assert.deepEqual(at(1), [0.2 - thick, 0.8, 0.03])
  assert.deepEqual(at(2), [-(0.2 - thick), 0.75, -0.02])
  for (const i of [3, 4, 5, 6, 7]) assert.deepEqual(at(i), points[i].map(v => Math.round(v * 10000) / 10000), `point ${i}`)
  // Already clear: nothing moves again.
  assert.equal(keepOffHands(p, hands, thick), 0)
  assert.equal(keepOffHands(p, null, thick), 0)
})

test("cloth pushed in behind a hand that's against the leg goes no further in than the skin", () => {
  const left = hangingHand(1)
  const hands = { L: handShape(left.positions, left.part, 1, left.arm, () => 0), R: null }
  const thick = 0.003
  // The leg's side is at x = 0.199: just inside the hand's inner face (0.2), so there's no room between.
  const field = { hit: [0, 0, 0], at(x) { this.hit = [1, 0, 0]; return x - 0.199 } }
  const p = Float32Array.from([0.215, 0.8, 0])
  assert.equal(keepOffHands(p, hands, thick, 0.02, field), 1)
  assert.ok(p[0] >= 0.199 + thick - 1e-6, `on the skin, not in the leg: ${p[0]}`)
  // A leg well in from the hand leaves the cloth by the hand's inner face, as before.
  const far = { hit: [0, 0, 0], at(x) { this.hit = [1, 0, 0]; return x - 0.15 } }
  const q = Float32Array.from([0.215, 0.8, 0])
  keepOffHands(q, hands, thick, 0.02, far)
  assert.ok(Math.abs(q[0] - (0.2 - thick)) < 1e-4, `${q[0]}`)
})
