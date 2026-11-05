// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import "./support/lib.mjs"

const { trimByParse } = await import("lib/garments/vision")

test("a clothes parse takes skin and backdrop off a photo's cloth mask, and never adds to it", () => {
  // Ten pixels: the mask says 0..7 are cloth; the parse reads 0..5 as the shirt, 6 as an arm, 7 as hair,
  // 8 as the shirt (outside the mask), 9 as nothing.
  const mask = Uint8Array.from([1, 1, 1, 1, 1, 1, 1, 1, 0, 0])
  const parse = { labels: ["Upper-clothes", "Left-arm", "Hair"], map: Uint8Array.from([0, 0, 0, 0, 0, 0, 1, 2, 0, 255]) }
  const share = trimByParse(mask, parse)
  assert.deepEqual(Array.from(mask), [1, 1, 1, 1, 1, 1, 0, 0, 0, 0])
  assert.equal(share, 0.25)
})

test("a parse that would take off most of the cloth is ignored (a garment laid flat, misread)", () => {
  const mask = Uint8Array.from([1, 1, 1, 1])
  const parse = { labels: ["Background"], map: Uint8Array.from([0, 0, 0, 255]) }
  assert.equal(trimByParse(mask, parse), 0)
  assert.deepEqual(Array.from(mask), [1, 1, 1, 1])
})
