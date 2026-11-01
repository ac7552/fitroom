// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import "./support/lib.mjs"

const { clothMask, layoutPhoto } = await import("lib/garments/redrape")

// A store photo, 240 across by 300 down, on a light grey backdrop: a dark garment hanging with its body in
// the middle, a sleeve either side (apart from the body below the shoulder, merged with it above), and, when
// asked, a black hanger: a thin hook above and its shoulders over the garment's.
function photo({ hanger = false, flat = false } = {}) {
  const w = 240, h = 300, data = new Uint8ClampedArray(4 * w * h)
  const bg = [236, 236, 236], cloth = [60, 40, 30], hook = [12, 12, 12]
  const put = (x, y, c) => data.set([...c, 255], 4 * (y * w + x))
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let c = bg
    // The shoulders and body: from row 60 to the hem at 260, 70 to 170 across.
    if (y >= 60 && y <= 260 && x >= 70 && x <= 170) c = cloth
    // The sleeves: from the shoulder down to row 230, 40 to 60 and 180 to 200 across (a gap of 9 pixels from
    // the body below row 90; joined to it above, at the shoulder).
    if (y >= 60 && y <= 230 && ((x >= 40 && x <= 60) || (x >= 180 && x <= 200))) c = cloth
    if (!flat && y >= 60 && y < 90 && x >= 40 && x <= 200) c = cloth
    // The backdrop's soft shadow just under the hem: a little darker than the backdrop, not the cloth.
    if (y > 260 && y <= 266 && x >= 70 && x <= 170) c = [214, 214, 214]
    put(x, y, c)
  }
  if (hanger) {
    for (let y = 30; y < 60; y++) for (let x = 117; x <= 123; x++) put(x, y, hook)   // the hook
    for (let y = 60; y < 68; y++) for (let x = 50; x <= 190; x++) put(x, y, hook)   // the hanger's shoulders
  }
  return { data, w, h }
}

test("the cloth mask leaves out the backdrop's shadow under the hem", () => {
  const { data, w, h } = photo()
  const found = clothMask(data, w, h)
  assert.ok(found)
  assert.equal(found.box.top, 60)
  assert.equal(found.box.bottom, 260, "the shadow rows below the hem aren't cloth")
  assert.equal(found.box.left, 40)
  assert.equal(found.box.right, 200)
  assert.deepEqual(found.bg, [236, 236, 236])
})

test("a hanger's hook and shoulders are cut off the top of the photo", () => {
  const { data, w, h } = photo({ hanger: true })
  const found = clothMask(data, w, h)
  assert.ok(found)
  assert.equal(found.box.top, 68, "the garment starts under the hanger")
  for (let y = 30; y < 68; y++) for (let x = 0; x < w; x++) assert.equal(found.mask[y * w + x], 0)
})

test("the layout tells the body's run from each sleeve's, and carries the body's edges up into the shoulders", () => {
  const { data, w, h } = photo()
  const found = clothMask(data, w, h)
  const layout = layoutPhoto({ mask: found.mask, box: found.box }, false)
  // Below the shoulder: three runs, the wearer's right sleeve on the photo's left.
  const y = 150 - found.box.top
  assert.ok(Math.abs(layout.body[0][y] - 70) <= 1 && Math.abs(layout.body[1][y] - 170) <= 1)
  assert.ok(Math.abs(layout.sides[0][0][y] - 40) <= 1 && Math.abs(layout.sides[0][1][y] - 60) <= 1)
  assert.ok(Math.abs(layout.sides[2][0][y] - 180) <= 1 && Math.abs(layout.sides[2][1][y] - 200) <= 1)
  // At the shoulder: one run, the sides merged; the body's edges extended from below split it.
  const top = 70 - found.box.top
  assert.ok(Number.isNaN(layout.sides[0][0][top]))
  assert.ok(Math.abs(layout.extended[0][top] - 70) <= 2, `right edge extended: ${layout.extended[0][top]}`)
  assert.ok(Math.abs(layout.extended[2][top] - 170) <= 2, `left edge extended: ${layout.extended[2][top]}`)
})

test("a photo of the back swaps the sides", () => {
  const { data, w, h } = photo()
  const found = clothMask(data, w, h)
  const layout = layoutPhoto({ mask: found.mask, box: found.box }, true)
  const y = 150 - found.box.top
  assert.ok(Math.abs(layout.sides[0][0][y] - 180) <= 1, "the wearer's right sleeve is on the photo's right")
  assert.ok(Math.abs(layout.sides[2][1][y] - 60) <= 1)
})

test("a sleeve laid along the body with no gap stays part of one run, with no body edge invented", () => {
  const { data, w, h } = photo({ flat: true })
  // Fill the gaps so the sleeves touch the body all the way down.
  for (let y = 60; y <= 230; y++) for (let x = 61; x <= 69; x++) for (const xx of [x, 240 - x]) data.set([60, 40, 30, 255], 4 * (y * w + xx))
  const found = clothMask(data, w, h)
  const layout = layoutPhoto({ mask: found.mask, box: found.box }, false)
  const y = 150 - found.box.top
  assert.ok(Number.isNaN(layout.sides[0][0][y]))
  assert.equal(layout.extended[0], null)
  assert.equal(layout.extended[2], null)
})
