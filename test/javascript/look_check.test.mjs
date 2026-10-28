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
  assert.ok(result.checks.place.size > BARS.size, JSON.stringify(result.checks.place))
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

test("a cropped top on a guessed chart takes its length from the photo; a usual one, or a real chart, doesn't", async () => {
  const { croppedLengths } = await import("../../app/javascript/lib/garments/look_check.js")
  const chart = { kind: "sizes", sizes: [{ name: "S", chest: 100, length: 70 }, { name: "M", chest: 110, length: 72 }] }
  assert.deepEqual(croppedLengths(chart, { proportion: 0.6 }).map(s => s.length), [30, 33])
  assert.equal(croppedLengths(chart, { proportion: 1.4 }), null)
  assert.equal(croppedLengths({ ...chart, kind: "chart" }, { proportion: 0.6 }), null)
  assert.equal(croppedLengths(chart, null), null)
})

test("a plain photo's render may not carry a graphic, but a graphic's share of a worn front isn't held to the flat photo's", () => {
  const withGraphic = compareLooks(photo, { ...photo, coverage: photo.coverage * 2.2 })
  assert.equal(withGraphic.checks.printed.pass, true)
})

test("a graphic across most of the front isn't held to its shape (a worn front shows less of its width)", () => {
  const wide = { color: "#17181a", coverage: 0.13, allOver: false, box: { left: 0.08, right: 0.89, top: 0.35, bottom: 0.87, shape: 1.03 } }
  const worn = { ...wide, box: { left: 0.07, right: 0.92, top: 0.33, bottom: 0.86, shape: 0.6 } }
  assert.equal(compareLooks(wide, worn).ok, true, JSON.stringify(compareLooks(wide, worn)))
  // A chest graphic still is.
  const chest = { ...wide, box: { left: 0.3, right: 0.7, top: 0.2, bottom: 0.4, shape: 1.5 } }
  assert.ok(compareLooks(chest, { ...chest, box: { ...chest.box, shape: 0.6 } }).failed.includes("place"))
})

test("a small logo reading just under the size that's placed isn't missing; one that's gone is", () => {
  const logo = { color: "#1d1a1d", coverage: 0.0037, allOver: false, box: { left: 0.63, right: 0.73, top: 0.27, bottom: 0.32, shape: 1.5 } }
  assert.equal(compareLooks(logo, { ...logo, coverage: 0.002, box: null }).ok, true)
  assert.ok(compareLooks(logo, { ...logo, coverage: 0.0002, box: null }).failed.includes("place"))
})

test("a scrap of print at one side, read in one picture and not the other, doesn't move the graphic's place", () => {
  const pw = 100, ph = 140
  const image = scrap => {
    const out = new Uint8ClampedArray(4 * pw * ph)
    const mark = (x0, x1, y0, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out[4 * (y * pw + x) + 3] = 255 }
    mark(45, 90, 50, 120)          // the scene, to the right
    if (scrap) mark(6, 18, 108, 118) // a scrap by the hem, at the left
    return lookOf(out, pw, ph, 0.25, false, "#17181a")
  }
  const photo = image(true), render = image(false)
  assert.ok(render.box.left - photo.box.left > 0.3, "the boxes differ a lot")
  assert.equal(compareLooks(photo, render).checks.place.pass, true, JSON.stringify(compareLooks(photo, render).checks.place))
})

test("a wide print's middle across may sit further out on a worn front; a chest graphic's may not", () => {
  const wide = { color: "#17181a", coverage: 0.134, allOver: false, box: { left: 0.088, right: 0.891, top: 0.35, bottom: 0.871, cx: 0.561, cy: 0.62, shape: 1.03 } }
  const worn = { color: "#14171c", coverage: 0.146, allOver: false, box: { left: 0.244, right: 1, top: 0.335, bottom: 0.875, cx: 0.671, cy: 0.58, shape: 0.76 } }
  assert.equal(compareLooks(wide, worn).checks.place.pass, true, JSON.stringify(compareLooks(wide, worn).checks.place))
  const chest = { ...wide, box: { left: 0.4, right: 0.6, top: 0.2, bottom: 0.35, cx: 0.5, cy: 0.27, shape: 1.3 } }
  assert.equal(compareLooks(chest, { ...chest, box: { ...chest.box, left: 0.51, right: 0.71, cx: 0.61 } }).checks.place.pass, false)
})
