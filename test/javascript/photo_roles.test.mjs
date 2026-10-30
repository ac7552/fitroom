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
