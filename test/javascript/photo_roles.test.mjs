// Run with: node --test test/javascript/*.test.mjs
import "./support/lib.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { photoTraits } from "../../app/javascript/lib/garments/print.js"

const { guessRoles, photoKind, photosByRole } = await import("lib/garments/photo_roles")

// A made-up photo, w x h, coloured pixel by pixel.
function picture(w, h, colourAt) {
  const data = new Uint8ClampedArray(4 * w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([...colourAt(x, y), 255], 4 * (y * w + x))
  return { data, w, h }
}

const grey = [236, 236, 236], navy = [31, 44, 77], skin = [224, 172, 140]
// A navy tee flat on light grey.
const flat = picture(160, 160, (x, y) => (x > 40 && x < 120 && y > 20 && y < 140) || (y > 20 && y < 56 && x > 14 && x < 146) ? navy : grey)
// Navy knit filling the frame, a little texture to it.
const closeup = picture(160, 160, (x, y) => (x + y) % 6 < 3 ? navy : [40, 54, 88])
// A white label filling the frame, with lines of black words on it.
const tag = picture(160, 160, (x, y) => y % 16 < 5 && x % 9 < 6 && x > 12 && x < 148 ? [10, 10, 10] : [245, 244, 240])
// Someone in the tee: a face and arms in skin above and beside it.
const worn = picture(160, 160, (x, y) => {
  if (Math.hypot(x - 80, y - 22) < 16) return skin
  if (y > 40 && y < 140 && x > 48 && x < 112) return navy
  if (y > 44 && y < 120 && ((x > 30 && x < 46) || (x > 114 && x < 130))) return skin
  return grey
})

// Dark red cloth filling the frame: red, but not skin.
const redCloth = picture(160, 160, (x, y) => y % 8 < 4 ? [122, 42, 42] : [130, 48, 47])

test("each kind of photo reads as itself", () => {
  const read = ({ data, w, h }) => photoKind(photoTraits(data, w, h))
  assert.equal(read(flat), "garment")
  assert.equal(read(closeup), "closeup")
  assert.equal(read(redCloth), "closeup")
  assert.equal(read(tag), "tag")
  assert.equal(read(worn), "worn")
})

test("the first full shot is the front and the next the back; a role set by hand stays", () => {
  const shot = { traits: { garment: true, fills: 0.4, touches: 0, dark: 0, light: 0, busy: 0.01, skin: 0 } }
  const cloth = { traits: { garment: false, fills: 0, touches: 4, dark: 0, light: 0, busy: 0.01, skin: 0 } }
  assert.deepEqual(guessRoles([shot, cloth, shot, shot]), ["front", "closeup", "back", "other"])
  // The second photo marked as the front by hand: the first becomes the back.
  assert.deepEqual(guessRoles([shot, { ...shot, role: "front", picked: true }]), ["back", "front"])
})

test("the garment keeps the first photo of each role, and a front stands in when none is marked", () => {
  assert.deepEqual(photosByRole([{ url: "a", role: "back" }, { url: "b", role: "closeup" }, { url: "c", role: "other" }]), { back: "a", closeup: "b", front: "c" })
  assert.equal(photosByRole([{ url: "t", role: "tag" }]).front, null)
})

// Dresses drawn as masks row by row: each row's runs of cloth as [from, to] pairs.
const { measureDressMask } = await import("../../app/javascript/lib/garments/print.js")
function dressMask(runsAt, w = 200, h = 300) {
  const mask = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (const [a, b] of runsAt(y)) for (let x = Math.max(0, Math.round(a)); x <= Math.min(w - 1, Math.round(b)); x++) mask[y * w + x] = 1
  return { mask, w, h }
}
const read = ({ mask, w, h }) => measureDressMask(mask, w, h)
const straps = y => y < 30 ? [[60, 72], [128, 140]] : null   // two straps, the neckline between them

test("a dress's photo gives its waist, hem and where it widens", () => {
  // Fitted to the waist (y 110), then widening in a straight line to a hem half again as wide: an A-line.
  const aline = read(dressMask(y => straps(y) ?? (y < 20 || y > 280 ? [] : y < 110 ? [[60, 140]] : [[60 - (y - 110) * 0.18, 140 + (y - 110) * 0.18]])))
  assert.equal(aline.flareFrom, "waist")
  assert.ok(aline.hem > 1.4, `hem ${aline.hem}`)
  assert.ok(aline.neckDepth > 0.03 && aline.neckWidth > 0.5)
  // A sheath: in at the waist (y 100), out over the hips (y 140), straight down.
  const half = y => y < 60 ? 40 : y < 100 ? 40 - (y - 60) * 0.2 : y < 140 ? 32 + (y - 100) * 0.15 : 38
  const sheath = read(dressMask(y => straps(y) ?? (y > 280 ? [] : [[100 - half(y), 100 + half(y)]])))
  assert.equal(sheath.flareFrom, null)
  assert.ok(sheath.waist < 0.85 && sheath.hem < 1.05)
  // A flounce at the hem: straight, then wide in its last tenth.
  const flounce = read(dressMask(y => straps(y) ?? (y > 280 ? [] : y < 250 ? [[62, 138]] : [[40, 160]])))
  assert.equal(flounce.flareFrom, "knee")
})

test("a dress's photo says when it's a halter, strapless, or has sleeves", () => {
  // Straps meeting at the neck: narrow at the top, widening to the chest.
  const halter = read(dressMask(y => (y > 280 ? [] : y < 40 ? [[95 - y * 0.6, 105 + y * 0.6]] : [[60, 140]])))
  assert.equal(halter.halter, true)
  assert.equal(read(dressMask(y => (y > 280 ? [] : [[60, 140]]))).strapless, true)
  // Long sleeves laid along the body, parting from it near their cuffs.
  const sleeved = read(dressMask(y => y > 280 ? [] : y < 200 ? [[30, 170]] : y < 240 ? [[30, 48], [60, 140], [152, 170]] : [[60, 140]]))
  assert.equal(sleeved.sleeves, "long")
  // A collar is narrow at the very top too, but shoulders as wide as the chest come right below it: a shirt
  // dress (sleeves lying against the body to the hips) and a polo dress aren't halters.
  const shirtDress = read(dressMask(y => y > 280 ? [] : y < 8 ? [[94, 106]] : y < 200 ? [[40, 160]] : [[60, 140]]))
  assert.equal(shirtDress.halter, false)
  const polo = read(dressMask(y => y > 280 ? [] : y < 6 ? [[92, 108]] : y < 14 ? [[66, 134]] : y < 60 ? [[44, 156]] : [[60, 140]]))
  assert.equal(polo.halter, false)
})
