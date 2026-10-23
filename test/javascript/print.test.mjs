// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { findPrint, measureTop } from "../../app/javascript/lib/garments/print.js"

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

// A tee laid flat: its body, and sleeves from its shoulders down to armpit (how far down its arms are sewn in).
function tee({ armpit, sleeveOut = 30 }) {
  const w = 240, h = 240, data = new Uint8ClampedArray(4 * w * h)
  const top = 30, bottom = 190, x0 = 70, x1 = 170
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const body = x > x0 && x < x1 && y > top && y < bottom
      const sleeves = y > top && y < top + armpit && x > x0 - sleeveOut && x < x1 + sleeveOut
      data.set([...(body || sleeves ? [200, 60, 60] : [236, 236, 236]), 255], 4 * (y * w + x))
    }
  }
  return { data, w, h }
}

test("reads how high a tee's arms are sewn in, against its width", () => {
  const baby = tee({ armpit: 50 }), boxy = tee({ armpit: 80 })
  const close = measureTop(baby.data, baby.w, baby.h), roomy = measureTop(boxy.data, boxy.w, boxy.h)
  assert.ok(Math.abs(close.length - 160 / 100) < 0.08, `length ${close.length}`)
  assert.ok(close.armpit * close.length < 0.62, `close depth ${close.armpit * close.length}`)
  assert.ok(roomy.armpit * roomy.length >= 0.72, `roomy depth ${roomy.armpit * roomy.length}`)
  assert.ok(close.waist > 0.95 && close.waist < 1.05, `waist ${close.waist}`)
})
