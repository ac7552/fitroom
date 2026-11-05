// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import "./support/lib.mjs"

const { cleanPixels, dilate, findLegPrints } = await import("lib/garments/leg_prints")

// A flat-laid pair of black pants, 200 by 240, on a pale grey backdrop: a waistband from row 20, the legs
// parting at row 110, the outer edges at x 40 and 160 all the way down. With, when asked, cream lettering
// down the photo's left edge (the wearer's right leg) from row 60 to 200, running a little past the
// outline as lettering pale against a pale backdrop does, and a drawcord hanging from the waist's middle.
function pants({ lettering = true, cord = true } = {}) {
  const w = 200, h = 240, data = new Uint8ClampedArray(4 * w * h)
  const top = 20, bottom = 220, crotch = 110
  const rows = new Int32Array(4 * (bottom - top + 1))
  for (let y = top; y <= bottom; y++) {
    const k = 4 * (y - top)
    rows[k] = 40; rows[k + 1] = 160
    rows[k + 2] = y >= crotch ? 96 : -1; rows[k + 3] = y >= crotch ? 104 : -1
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = 4 * (y * w + x)
    const on = y >= top && y <= bottom && x >= 40 && x <= 160 && !(y >= crotch && x > 96 && x < 104)
    data.set(on ? [16, 16, 16, 255] : [235, 235, 235, 255], i)
  }
  if (lettering) for (let y = 60; y <= 200; y++) for (let x = 36; x <= 52; x++) {
    // Letters 10 rows tall with 4-row gaps, the strokes 3 across.
    const letter = (y - 60) % 14 < 10 && ((x - 36) % 6 < 3)
    if (letter) data.set([232, 220, 192, 255], 4 * (y * w + x))
  }
  if (cord) for (let y = 30; y <= 70; y++) for (let x = 98; x <= 101; x++) data.set([200, 180, 140, 255], 4 * (y * w + x))
  return { data, w, h, layout: { w, h, top, bottom, crotch, rows } }
}

test("lettering down a leg's edge is one graphic, on the wearer's right leg, its edge where the lettering reaches", () => {
  const { data, w, h, layout } = pants()
  const found = findLegPrints(data, w, h, layout)
  assert.equal(found.prints.length, 1, JSON.stringify(found.prints.map(p => p.box)))
  const [p] = found.prints
  assert.equal(p.side, "R")
  // The whole word, its letters 4 rows apart joined, and the part past the outline (x 36 to 39) too.
  assert.ok(p.box[1] <= 61 && p.box[3] >= 199, `rows ${p.box[1]}..${p.box[3]}`)
  assert.ok(p.box[0] <= 37, `from x ${p.box[0]}`)
  // The leg's outer edge, taken out to the lettering past the outline: x 36, straight down.
  assert.ok(Math.abs(p.edge[0] + p.edge[1] * 130 - 36) < 1.5, `edge ${p.edge}`)
})

test("the drawcord at the waist's middle isn't a graphic, nor are plain pants", () => {
  const plain = pants({ lettering: false })
  assert.equal(findLegPrints(plain.data, plain.w, plain.h, plain.layout).prints.length, 0)
})

test("the graphic is painted out of the photo in the cloth's colour, past the outline too", () => {
  const { data, w, h, layout } = pants()
  const found = findLegPrints(data, w, h, layout)
  cleanPixels(data, w, h, found.mask, w, h, layout, found.cloth)
  let left = 0
  // (No cream left: warm, as the backdrop's grey between the letters isn't.)
  for (let y = 60; y <= 200; y++) for (let x = 36; x <= 52; x++) { const i = 4 * (y * w + x); if (data[i] - data[i + 2] > 20) left++ }
  assert.equal(left, 0)
  // The backdrop beyond the lettering stays the backdrop.
  assert.equal(data[4 * (130 * w + 20)], 235)
})

test("dilate grows a mask by r pixels each way", () => {
  const mask = new Uint8Array(25)
  mask[12] = 1
  const out = dilate(mask, 5, 5, 1)
  assert.deepEqual(Array.from(out), [0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0])
})
