// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { findPrint } from "../../app/javascript/lib/garments/print.js"

// A made-up product photo: a navy tee on a light grey background, with a white square printed on its chest.
function photo({ print = true } = {}) {
  const w = 200, h = 200, data = new Uint8ClampedArray(4 * w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = [236, 236, 236]
      const body = x > 50 && x < 150 && y > 30 && y < 160, sleeves = y > 30 && y < 70 && x > 20 && x < 180
      if (body || sleeves) c = [31, 44, 77]
      if (print && x > 80 && x < 120 && y > 60 && y < 100) c = [250, 250, 250]
      data.set([...c, 255], 4 * (y * w + x))
    }
  }
  return { data, w, h }
}

test("finds the garment's colour and the print on its front", () => {
  const { data, w, h } = photo()
  const found = findPrint(data, w, h)
  assert.equal(found.color, "#1f2c4d")
  assert.deepEqual(found.rect.slice(0, 1), [51])
  assert.ok(found.print.coverage > 0.08 && found.print.coverage < 0.16, `coverage ${found.print.coverage}`)
  // The print keeps its colour; plain cloth around it is see-through.
  const at = (x, y) => 4 * (y * found.print.width + x)
  assert.equal(found.print.data[at(49, 50) + 3], 255)
  assert.equal(found.print.data[at(10, 100) + 3], 0)
})

test("a plain garment has no print", () => {
  const { data, w, h } = photo({ print: false })
  assert.equal(findPrint(data, w, h).print, null)
})
