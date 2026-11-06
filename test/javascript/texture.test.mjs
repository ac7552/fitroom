// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import "./support/lib.mjs"

const { yarnPitch } = await import("lib/garments/yarn")

// A square photo with vertical stripes `pitch` pixels apart (and speckle), as RGBA.
function striped(size, pitch, noise = 0) {
  const data = new Uint8ClampedArray(4 * size * size)
  let seed = 7
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5 }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const v = 160 + 40 * Math.cos((2 * Math.PI * x) / pitch) + noise * rand()
    data.set([v, v, v, 255], 4 * (y * size + x))
  }
  return data
}

test("the yarn pitch is the stripes' period, noise or not, and null for plain cloth", () => {
  assert.equal(yarnPitch(striped(256, 8), 256), 8)
  assert.equal(yarnPitch(striped(256, 13, 60), 256), 13)
  const plain = new Uint8ClampedArray(4 * 128 * 128).fill(180)
  assert.equal(yarnPitch(plain, 128), null)
})
