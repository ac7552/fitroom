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

test("the flat field takes the photographer's gradient out and keeps the weave as relief", async () => {
  const { flatFieldImage } = await import("lib/garments/redrape")
  // A 200 by 200 grey cloth filling the frame, lit from the top (brighter above), with a fine dark stripe
  // every 10 pixels (its weave).
  const w = 200, h = 200, data = new Uint8ClampedArray(4 * w * h), mask = new Uint8Array(w * h).fill(1)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const light = 1.3 - 0.6 * (y / h)
    const weave = x % 10 === 0 ? 0.7 : 1
    const v = Math.round(Math.min(255, 140 * light * weave))
    data.set([v, v, v, 255], 4 * (y * w + x))
  }
  const image = flatFieldImage({ data, width: w, height: h }, mask, { left: 0, right: w - 1, top: 0, bottom: h - 1, w, h })
  assert.ok(image)
  const at = (x, y) => data[4 * (y * w + x)]
  // The top and bottom of the cloth come out at about the same brightness, where they differed by a half.
  assert.ok(Math.abs(at(5, 20) - at(5, 180)) < 12, `${at(5, 20)} vs ${at(5, 180)}`)
  // The weave's stripe is still darker than the cloth beside it, in colour and in the relief.
  assert.ok(at(10, 100) < at(5, 100) - 15)
  assert.ok(data[4 * (100 * w + 10) + 3] < data[4 * (100 * w + 5) + 3] - 10)
})

test("a similarity fitted by least squares recovers a move, turn and scale", async () => {
  const { similarity } = await import("lib/garments/redrape")
  const angle = 0.3, scale = 2.5, src = [[0, 0], [10, 0], [10, 5], [0, 5], [5, 2]]
  const dst = src.map(([x, y]) => [100 + scale * (Math.cos(angle) * x - Math.sin(angle) * y), 40 + scale * (Math.sin(angle) * x + Math.cos(angle) * y)])
  const t = similarity(src, dst)
  for (let k = 0; k < src.length; k++) { const [x, y] = t(src[k]); assert.ok(Math.hypot(x - dst[k][0], y - dst[k][1]) < 1e-6) }
})

// A photo as the re-drape reads it, from raw pixels, with no browser: its canvas only gives its pixels back.
function photoOf({ data, w, h }, extra = {}) {
  const found = clothMask(data, w, h)
  const canvas = { width: w, height: h, getContext: () => ({ getImageData: () => ({ data }) }) }
  return { canvas, mask: found.mask, box: { ...found.box, w, h }, cloth: [60, 40, 30], worn: false, ...extra }
}

test("the plainest patch of cloth is found where the cloth is one colour", async () => {
  const { plainPatch } = await import("lib/garments/redrape")
  const shot = photo()
  // A navy letter across the middle of the body.
  for (let y = 120; y < 170; y++) for (let x = 90; x < 150; x++) shot.data.set([20, 30, 90, 255], 4 * (y * shot.w + x))
  const patch = plainPatch(photoOf(shot), [60, 40, 30])
  assert.ok(patch)
  const inLetter = patch.x + patch.w > 90 && patch.x < 150 && patch.y + patch.h > 120 && patch.y < 170
  assert.ok(!inLetter, "not on the lettering")
  assert.equal(plainPatch(photoOf(shot), [250, 250, 0]), null, "no patch in a colour the photo hasn't got")
})

test("a hood and a sleeve that took the body's lettering are laid on plain cloth; the front keeps its photo", async () => {
  const { trustPieces } = await import("lib/garments/redrape")
  const shot = photo()
  // Lettering across the chest, running onto the sleeves where they lie along the body.
  for (let y = 110; y < 140; y++) for (let x = 40; x <= 200; x++) if (shot.data[4 * (y * shot.w + x)] === 60) shot.data.set([20, 30, 90, 255], 4 * (y * shot.w + x))
  const front = photoOf(shot)
  // Four pieces of a few points each: the front on the lettering and the cloth, a sleeve all on the lettering,
  // a hood on the cloth, a back (no photo of its own).
  const cloth = { panels: ["front", "sleeve_L", "hood_L", "back"], points: [], panel: [] }
  const uv = []
  const at = (p, x, y, px, py) => { cloth.points.push([px, py]); cloth.panel.push(p); uv.push(x / shot.w, 1 - y / shot.h, 1) }
  for (let k = 0; k < 10; k++) { at(0, 100 + k, k < 2 ? 120 : 80, k, 0); at(1, 50, 120 + k, 0, k); at(2, 120, 70 + k, k, k); at(3, 100 + k, 80, k, 0) }
  const out = trustPieces({ cloth }, Float32Array.from(uv), { front, back: null })
  assert.deepEqual(out.plain.sort(), ["back", "hood_L", "sleeve_L"])
  assert.equal(out.far.front, 0.2)
  assert.equal(out.allOver, false)
})

test("a print all over keeps the photo on the sleeves and the back", async () => {
  const { trustPieces } = await import("lib/garments/redrape")
  const shot = photo()
  // A stripe all over: two of every three 10-pixel bands of the cloth light.
  for (let y = 60; y <= 260; y++) for (let x = 40; x <= 200; x++) if (shot.data[4 * (y * shot.w + x)] === 60 && Math.floor(x / 10) % 3) shot.data.set([200, 200, 210, 255], 4 * (y * shot.w + x))
  const front = photoOf(shot, { cloth: [60, 40, 30] })
  const cloth = { panels: ["front", "sleeve_L", "back"], points: [], panel: [] }
  const uv = []
  const at = (p, x, y) => { cloth.points.push([x, y]); cloth.panel.push(p); uv.push(x / shot.w, 1 - y / shot.h, 1) }
  for (let k = 0; k < 20; k++) { at(0, 90 + 3 * k, 150); at(1, 41 + k, 150); at(2, 90 + 3 * k, 160) }
  const out = trustPieces({ cloth }, Float32Array.from(uv), { front, back: null })
  assert.equal(out.allOver, true)
  assert.deepEqual(out.plain, [])
})

test("a hood standing up above the shoulders is kept, not cut off as a hanger's hook", () => {
  const { data, w, h } = photo()
  // A hood 50 wide from row 20 to the shoulders at row 60, in the cloth's colour.
  for (let y = 20; y < 60; y++) for (let x = 95; x <= 145; x++) data.set([60, 40, 30, 255], 4 * (y * w + x))
  const found = clothMask(data, w, h)
  assert.equal(found.box.top, 20)
})

// A grey cloth square on a light backdrop with a light rim inside its outline (rim: how many pixels; the
// backdrop blended in, from half of it at the outline down to a tenth), as a canvas context would hold it.
function rimmed(rim) {
  const w = 800, h = 800, data = new Uint8ClampedArray(4 * w * h), mask = new Uint8Array(w * h)
  const bg = [235, 235, 235], cloth = [106, 102, 97]
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, inside = x >= 200 && x < 600 && y >= 200 && y < 600
    const depth = Math.min(x - 200, 599 - x, y - 200, 599 - y) + 1   // 1 on the outline
    const t = inside && depth <= rim ? 0.5 - 0.4 * (depth - 1) / Math.max(1, rim - 1) : 0
    const c = inside ? cloth.map((v, k) => Math.round(v + (bg[k] - v) * t)) : bg
    data.set([...c, 255], 4 * i)
    mask[i] = inside ? 1 : 0
  }
  return { ctx: { getImageData: () => ({ data }), putImageData: () => {} }, data, mask, w, h, bg }
}

test("the light rim inside a photo's outline takes the cloth's colour from just inside it", async () => {
  const { cleanRim } = await import("lib/garments/redrape")
  const { ctx, data, mask, w, h, bg } = rimmed(6)
  assert.equal(cleanRim(ctx, mask, w, h, bg), 6)
  // The outline's pixel now the cloth's, and the cloth deeper in untouched.
  const at = (x, y) => Array.from(data.slice(4 * (y * w + x), 4 * (y * w + x) + 3))
  assert.deepEqual(at(200, 400), [106, 102, 97])
  assert.deepEqual(at(400, 400), [106, 102, 97])
  // The backdrop outside isn't touched.
  assert.deepEqual(at(150, 400), [235, 235, 235])
  // No rim, nothing to clean.
  const plain = rimmed(0)
  assert.equal(cleanRim(plain.ctx, plain.mask, plain.w, plain.h, plain.bg), 0)
})
