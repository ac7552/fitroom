// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import "./support/lib.mjs"

const { outlineIoU, HangTrial } = await import("lib/garments/silhouette")

// A T shape as points and triangles (x across, y up): a body 40 wide and 60 high, arms 20 out each side.
function tee(arms = 20) {
  const pts = [[-20, 0], [20, 0], [20, 60], [-20, 60], [-20 - arms, 60], [-20 - arms, 45], [20 + arms, 60], [20 + arms, 45], [-20, 45], [20, 45]]
  const positions = Float32Array.from(pts.flatMap(([x, y]) => [x / 100, y / 100, 0]))
  const triangles = [[0, 1, 2], [0, 2, 3], [4, 5, 8], [4, 8, 3], [9, 7, 6], [9, 6, 2]]
  return { positions, triangles }
}
// The same T as a photo's cloth mask, 200 × 200 pixels.
function photoOf(arms = 20) {
  const w = 200, mask = new Uint8Array(w * w)
  const scale = 2, ox = 100, oy = 170
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    const X = (x - ox) / scale, Y = (oy - y) / scale
    if ((Math.abs(X) <= 20 && Y >= 0 && Y <= 60) || (Math.abs(X) <= 20 + arms && Y >= 45 && Y <= 60)) mask[y * w + x] = 1
  }
  let left = w, right = 0, top = w, bottom = 0
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y) }
  return { mask, box: { left, right, top, bottom, w } }
}

test("a garment's outline matches a photo of the same shape, and a different shape less", () => {
  const same = outlineIoU(tee().positions, tee().triangles, null, photoOf())
  const other = outlineIoU(tee(0).positions, tee(0).triangles, null, photoOf())
  assert.ok(same > 0.9, `the same shape: ${same}`)
  assert.ok(other < same - 0.15, `arms down against arms out: ${other}`)
})

test("of several hangings, the one matching the photo best is kept", () => {
  const photo = photoOf()
  const hung = arms => ({ done: true, positions: tee(arms).positions, advance: () => false })
  const top = { cloth: { triangles: tee().triangles }, drape: { map: null } }
  const trial = new HangTrial([{ flat: null, hanger: hung(0) }, { flat: { angle: 0.4 }, hanger: hung(20) }, { flat: { angle: 0.9 }, hanger: hung(8) }], top, photo)
  assert.equal(trial.done, true)
  assert.deepEqual(trial.chosen.flat, { angle: 0.4 })
  assert.equal(trial.positions, trial.best.hanger.positions)
})
