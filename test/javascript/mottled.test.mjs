import { test } from "node:test"
import assert from "node:assert/strict"
import { mottled, tileWindow } from "../../app/javascript/lib/garments/print.js"

// A front pw by ph in Lab: `at(x, y)` gives [L, a, b].
function front(pw, ph, at) {
  const lab = new Float32Array(3 * pw * ph)
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) lab.set(at(x, y), 3 * (y * pw + x))
  return lab
}
const all = () => true, same = k => k

test("a low-contrast camo all over the front is mottled; plain cloth with a fold's shading isn't", () => {
  const pw = 90, ph = 90, base = [30, 5, 10]
  // Blobs of tan (L 50) over a third of each cell, the rest the dark base.
  const camo = front(pw, ph, (x, y) => ((Math.floor(x / 6) + Math.floor(y / 7)) % 3 === 0 ? [50, 6, 14] : [30, 5, 10]))
  assert.equal(mottled(camo, base, pw, ph, all, same), true)
  // Plain, with a shadow down the middle 8 darker.
  const plain = front(pw, ph, (x) => (Math.abs(x - 45) < 10 ? [22, 5, 10] : [30, 5, 10]))
  assert.equal(mottled(plain, base, pw, ph, all, same), false)
  // A chest graphic, however big, leaves the hem's cells plain.
  const graphic = front(pw, ph, (x, y) => (y < 50 ? [80, 0, 0] : [30, 5, 10]))
  assert.equal(mottled(graphic, base, pw, ph, all, same), false)
})

test("an all-over print's tile is taken clear of a drawcord hanging over the chest", () => {
  const pw = 100, ph = 100, data = new Uint8ClampedArray(4 * pw * ph)
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
    const i = 4 * (y * pw + x), cord = x >= 40 && x <= 43 && y < 60
    data.set(cord ? [240, 235, 225, 255] : [90, 70, 55, 255], i)
  }
  const [x0, x1] = tileWindow(data, pw, ph)
  assert.ok(x1 <= 40 || x0 > 43, `tile ${x0}..${x1} takes in the cord`)
  // With nothing in the way, the first (widest) piece.
  data.fill(80)
  assert.deepEqual(tileWindow(data, pw, ph), [6, 44, 30, 92])
})
