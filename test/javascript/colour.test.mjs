// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import "./support/lib.mjs"

const { deltaE, linearOf } = await import("lib/colour")

test("sRGB to linear light", () => {
  assert.deepEqual(linearOf("#000000"), [0, 0, 0])
  assert.deepEqual(linearOf([255, 255, 255]), [1, 1, 1])
  // Middle grey: sRGB 118 is about 18% in linear light.
  assert.ok(Math.abs(linearOf("#767676")[0] - 0.18) < 0.005)
})

test("deltaE: none for the same colour, small for a shade apart, large across a hue", () => {
  assert.equal(deltaE([212, 203, 185], [212, 203, 185]), 0)
  // Kith's Armani crewneck: its photo's cloth against the stage's rendering of it before metering.
  const before = deltaE([212, 203, 185], [162, 150, 134])
  assert.ok(before > 15, `${before}`)
  assert.ok(deltaE([200, 200, 200], [204, 204, 204]) < 2.5)
  assert.ok(deltaE([200, 50, 50], [50, 200, 50]) > 80)
})
