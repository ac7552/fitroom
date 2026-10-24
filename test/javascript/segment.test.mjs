// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { paintOut, promptPoints } from "../../app/javascript/lib/garments/print.js"

// A navy tee on a light backdrop with a skin-coloured hand held against its side.
function photo() {
  const w = 200, h = 200, data = new Uint8ClampedArray(4 * w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let c = [236, 236, 236]
    if ((x > 50 && x < 150 && y > 30 && y < 160) || (y > 30 && y < 70 && x > 20 && x < 180)) c = [31, 44, 77]
    if (x >= 150 && x < 170 && y > 110 && y < 150) c = [214, 170, 140]   // the hand, joined to the tee
    data.set([...c, 255], 4 * (y * w + x))
  }
  return { data, w, h }
}

test("points a segmentation model down the middle of a top, inside the garment", () => {
  const { data, w, h } = photo()
  const prompt = promptPoints(data, w, h, "top")
  assert.ok(prompt.points.length >= 2)
  for (const [x, y] of prompt.points) assert.ok(prompt.mask[Math.round(y) * w + Math.round(x)], `${x},${y} is on the tee`)
  assert.deepEqual(prompt.bg, [236, 236, 236])
})

test("paints out what the model left out of the garment, unless that's too much to trust", () => {
  const { data, w, h } = photo()
  const prompt = promptPoints(data, w, h, "top")
  // The model's mask: the tee without the hand.
  const keep = Uint8Array.from({ length: w * h }, (_, i) => { const x = i % w, y = Math.floor(i / w); return x >= 150 && x < 170 && y > 110 && y < 150 ? 0 : 1 })
  const share = paintOut(data, w, h, prompt.mask, keep, prompt.bg)
  assert.ok(share > 0 && share < 0.1)
  assert.deepEqual([...data.slice(4 * (130 * w + 160), 4 * (130 * w + 160) + 3)], [236, 236, 236])
  // A mask that drops most of the garment isn't used.
  const copy = photo().data
  assert.ok(paintOut(copy, w, h, prompt.mask, new Uint8Array(w * h), prompt.bg) > 0.35)
  assert.deepEqual([...copy.slice(4 * (100 * w + 100), 4 * (100 * w + 100) + 3)], [31, 44, 77])
})
