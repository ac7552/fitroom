import { test } from "node:test"
import assert from "node:assert/strict"
import { BARS, colourGap, compareLooks, nextReading } from "../../app/javascript/lib/garments/look_check.js"
import { lookOf } from "../../app/javascript/lib/garments/print.js"

const photo = { color: "#f4f3ef", coverage: 0.17, allOver: false, box: { left: 0.2, right: 0.8, top: 0.18, bottom: 0.44 } }

test("a render that looks like its photo passes every check", () => {
  const render = { color: "#dcd9d2", coverage: 0.18, allOver: false, box: { left: 0.22, right: 0.83, top: 0.15, bottom: 0.41 } }
  const result = compareLooks(photo, render)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.failed, [])
})

test("a graphic blown up and pushed under the collar fails on place", () => {
  const render = { ...photo, coverage: 0.36, box: { left: 0.05, right: 0.97, top: 0.06, bottom: 0.48 } }
  const result = compareLooks(photo, render)
  assert.ok(result.failed.includes("place"))
  assert.ok(result.failed.includes("printed"))
})

test("a chest graphic laid as stripes all round fails on how much is printed", () => {
  const result = compareLooks(photo, { color: "#c03030", coverage: 1, allOver: true, box: null })
  assert.ok(result.failed.includes("printed"))
})

test("the wrong colour fails on colour, and a photo far from the listing's named colour fails on named", () => {
  assert.deepEqual(compareLooks(photo, { ...photo, color: "#1d1e22" }).failed, ["colour"])
  const named = compareLooks({ ...photo, color: "#e2dccb" }, { ...photo, color: "#e2dccb" }, { named: "#151619" })
  assert.deepEqual(named.failed, ["named"])
})

test("a plain photo allows only a little stray graphic in the render", () => {
  const plain = { color: "#2a3552", coverage: 0.002, allOver: false, box: null }
  assert.equal(compareLooks(plain, { ...plain, coverage: 0.03 }).ok, true)
  assert.deepEqual(compareLooks(plain, { ...plain, coverage: 0.2, box: photo.box }).failed, ["printed"])
})

test("the likeness counts only when it was had", () => {
  const render = { ...photo }
  assert.equal(compareLooks(photo, render).checks.likeness, undefined)
  assert.deepEqual(compareLooks(photo, render, { likeness: 0.05 }).failed, ["likeness"])
  assert.equal(compareLooks(photo, render, { likeness: 0.6 }).ok, true)
})

test("the second try is aimed at what failed; the third is the safe reading; there's no fourth", () => {
  assert.deepEqual(nextReading(2, ["place"]), { hood: false, patterns: true, sleeves: true, back: true, listingColour: false })
  assert.deepEqual(nextReading(2, ["printed"]), { hood: true, patterns: false, sleeves: false, back: true, listingColour: false })
  assert.equal(nextReading(2, ["colour"]).listingColour, true)
  assert.deepEqual(nextReading(3, ["place"]), { hood: false, patterns: false, sleeves: false, back: false, listingColour: false })
  assert.equal(nextReading(4, ["place"]), null)
})

test("colour gaps count lightness at half", () => {
  assert.ok(colourGap("#808080", "#808080") < 1e-6)
  assert.ok(colourGap("#ffffff", "#000000") < 60)
  assert.ok(colourGap("#c03030", "#30c030") > BARS.colour * 3)
})

test("a look's graphic box is where most of the graphic is, a speck by the hem left out", () => {
  const pw = 100, ph = 200, out = new Uint8ClampedArray(4 * pw * ph)
  const mark = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out[4 * (y * pw + x) + 3] = 255 }
  mark(20, 40, 80, 90)
  mark(90, 180, 92, 182)   // a speck
  const look = lookOf(out, pw, ph, 0.15, false, "#ffffff")
  assert.ok(Math.abs(look.box.top - 0.2) < 0.03 && Math.abs(look.box.bottom - 0.45) < 0.03, JSON.stringify(look.box))
  assert.ok(look.box.right < 0.85, JSON.stringify(look.box))
})
