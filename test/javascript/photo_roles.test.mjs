// Run with: node --test test/javascript/*.test.mjs
import "./support/lib.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { photoTraits } from "../../app/javascript/lib/garments/print.js"

const { exampleRole, guessRoles, photoKind, photoRoles, photosByRole, pickPhotos, unit, wordsRole } = await import("lib/garments/photo_roles")

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

test("a close-up of plain cloth is nearly all its own colour; one of a graphic on it, and a full shot, aren't", () => {
  // Grey bars on oatmeal knit filling the frame (an embroidered eagle, close up), and the knit alone.
  const oatmeal = [212, 203, 185], knit = (x, y) => (x + y) % 6 < 3 ? oatmeal : [204, 195, 178]
  const graphic = picture(160, 160, (x, y) => y % 30 < 12 && x > 20 && x < 140 ? [178, 178, 180] : knit(x, y))
  assert.ok(photoTraits(closeup.data, closeup.w, closeup.h).plain > 0.95)
  assert.ok(photoTraits(...Object.values(picture(160, 160, knit))).plain > 0.95)
  assert.ok(photoTraits(graphic.data, graphic.w, graphic.h).plain < 0.9)
  assert.ok(photoTraits(flat.data, flat.w, flat.h).plain < 0.6)
})

test("without the examples, the first full shot is the front and the next the back; a role set by hand stays", () => {
  const shot = { traits: { garment: true, fills: 0.4, touches: 0, dark: 0, light: 0, busy: 0.01, skin: 0 } }
  const cloth = { traits: { garment: false, fills: 0, touches: 4, dark: 0, light: 0, busy: 0.01, skin: 0 } }
  assert.deepEqual(guessRoles([shot, cloth, shot, shot]), ["flat_front", "closeup", "flat_back", "other"])
  // The second photo marked as the front by hand: the first becomes the back.
  assert.deepEqual(guessRoles([shot, { ...shot, role: "flat_front", picked: true }]), ["flat_back", "flat_front"])
})

test("the garment keeps the first photo of each role, and a front stands in when none is marked", () => {
  assert.deepEqual(photosByRole([{ url: "a", role: "flat_back" }, { url: "b", role: "closeup" }, { url: "c", role: "other" }]), { flat_back: "a", closeup: "b", flat_front: "c" })
  assert.equal(photosByRole([{ url: "t", role: "tag" }]).flat_front, null)
  // Only a photo of it worn: that, last of all.
  assert.equal(photosByRole([{ url: "t", role: "tag" }, { url: "m", role: "on_model" }]).flat_front, "m")
})

test("the shop's words say what a photo is from how it's described, not from the garment's parts", () => {
  const role = (alt, src = "x.jpg", options = {}) => wordsRole({ alt, src }, options)
  // Kith's: a hanger shot, a model, the back, a close-up. "Snap front" and "zip front" are parts, not a view.
  assert.ok(role("Dark indigo cotton denim jacket with a high funnel collar, snap front placket, and flap side pockets, shown flat on a grey background.").flat_front > 0)
  const model = role("Man wearing a dark indigo Kith Darius denim jacket with a high funnel collar, open front showing a red quilted liner.")
  assert.equal(model.on_model, 1)
  assert.equal(model.flat_front, undefined)
  assert.ok(role("Back view of a dark indigo cotton denim Kith Darius jacket on a hanger, with high collar, long sleeves and vertical back seam.").flat_back >= 0.9)
  assert.equal(role("Close-up of a deep red ribbed knit cardigan showing textured lambswool and two dark metal woven-look buttons along the front edge.").closeup, 1)
  assert.equal(role("Model in a navy Kith for the New York Knicks crewneck sweater with a large cream and blue NY letter design.").on_model, 1)
  assert.equal(role("Woman with short dark hair wearing a cropped burgundy Kith Meika leather jacket").on_model, 1)
  assert.ok(role("Rear view of the Rick Owens Poiret Coat in carbone wool blend").flat_back > 0)
  assert.ok(role("Navy Stone Island short hooded parka in crinkled nylon, front view showing the two-way zip").flat_front > 0)
  // A brand's name isn't a person: "Kith Women", "Men's".
  assert.equal(role("Kith Women Harten aviator sweater jacket in black chunky knit").on_model, undefined)
  assert.equal(role("Men's navy crewneck sweater laid flat").on_model, undefined)
  // A back pocket is a part: laid flat says it's on its own, not which way round.
  const pocket = role("Black jeans with a back pocket patch, laid flat")
  assert.equal(pocket.flat_back, pocket.flat_front)
  // A box is no garment.
  assert.ok(role("Kith gift box with a window showing folded white, black, and heather grey crewneck undershirts").other > 0)
})

test("a file's name is a hint, unless every photo of the listing has the word", () => {
  const files = ["A-FRONT.jpg", "A-BACK.jpg", "A-DETAIL-1.jpg"]
  assert.ok(wordsRole({ src: files[1] }, { others: files }).flat_back > 0)
  assert.ok(wordsRole({ src: files[2] }, { others: files }).closeup > 0)
  // Kith names every photo "…-Detail": it says nothing.
  const kith = ["K-Detail.jpg", "K-Detail_9ad34ef2-c392-4424-a6e2-73d3b2e24ed6.jpg", "K-Detail_0834ea49-e110-4233-828d-a600c60db149.jpg"]
  assert.equal(wordsRole({ src: kith[1] }, { others: kith }).closeup, undefined)
  assert.equal(wordsRole({ src: kith[0] }, { others: kith.slice(0, 1) }).closeup, undefined)
})

test("the words outweigh a measurement that misreads (a tan plaid as skin), and a close-up never fronts", () => {
  const plaid = { garment: true, fills: 0.38, touches: 0, dark: 0.1, light: 0.1, busy: 0.04, skin: 0.04, plain: 0.1 }
  const close = { garment: false, fills: 0, touches: 4, dark: 0.1, light: 0.1, busy: 0.04, skin: 0.08, plain: 0.4 }
  const read = photoRoles([
    { image: { alt: "Green plaid button-up shirt on a hanger" }, traits: plaid },
    { image: { alt: "Model in a green plaid shirt worn open over a white tee" }, traits: plaid },
    { image: { alt: "Back view of the plaid shirt hung against grey" }, traits: plaid },
    { image: { alt: "Close-up of the plaid cotton with a crest at the front" }, traits: close }
  ])
  assert.deepEqual(read.map(r => r.role), ["flat_front", "on_model", "flat_back", "closeup"])
  const picks = pickPhotos(read)
  assert.equal(picks.front, 0)
  assert.equal(picks.worn, false)
  assert.deepEqual(picks.backs, [2])
  assert.deepEqual(picks.closeups, [3])
})

test("with no photo of it on its own, the photo of it worn is the front, marked so", () => {
  // The examples call the first photo on its own a back, and nothing says so: it's still the front.
  assert.equal(pickPhotos([{ role: "flat_back" }, { role: "flat_front" }]).front, 0)
  assert.equal(pickPhotos([{ role: "flat_back", words: { flat_back: 0.95 } }, { role: "flat_front" }]).front, 1)
  assert.equal(pickPhotos([{ role: "on_model" }, { role: "flat_back", words: { flat_back: 0.95 } }]).front, 1)
  const read = [{ role: "on_model" }, { role: "closeup" }, { role: "on_model" }]
  const picks = pickPhotos(read)
  assert.equal(picks.front, 0)
  assert.equal(picks.worn, true)
  assert.deepEqual(picks.backs, [])
  assert.equal(pickPhotos([{ role: "closeup" }, { role: "tag" }]).front, null)
})

test("the examples decide between a garment on its own and on someone, by their nearest", () => {
  // Two made-up roles' examples in four numbers, packed as photo_role_examples.js packs them.
  const rows = [[1, 0, 0, 0], [0.9, 0.1, 0, 0], [0, 1, 0, 0], [0, 0.9, 0.2, 0]]
  const bytes = Uint8Array.from(rows.flatMap(r => { const u = unit(r); return Array.from(u, v => Math.round(v * 127) & 255) }))
  const examples = { dims: 4, count: 4, roles: ["flat_front", "on_model"], labels: [0, 0, 1, 1], data: Buffer.from(bytes).toString("base64") }
  const near = exampleRole([0.95, 0.05, 0, 0], { examples, k: 3 })
  assert.ok(near.flat_front > 0.9, JSON.stringify(near))
  assert.ok(exampleRole([0.1, 1, 0.1, 0], { examples, k: 3 }).on_model > 0.9)
  assert.equal(exampleRole(null, { examples }), null)
})


test("of several garments hung together, the one in front (the leftmost) is kept and the rest painted out", async () => {
  const { severalMask } = await import("../../app/javascript/lib/garments/print.js")
  // Three tees, red in front at the left, then green, then blue behind, each overlapping the next.
  const tee = (x, y, x0) => (y > 30 && y < 140 && x > x0 + 14 && x < x0 + 70) || (y > 30 && y < 60 && x > x0 && x < x0 + 84)
  const shot = picture(240, 160, (x, y) => tee(x, y, 20) ? [190, 40, 40] : tee(x, y, 70) ? [40, 150, 60] : tee(x, y, 120) ? [40, 60, 170] : grey)
  const read = severalMask(shot.data, shot.w, shot.h)
  assert.ok(read, "read")
  // Inside the red tee kept; the blue one painted out; the backdrop is the frame's grey.
  assert.equal(read.mask[80 * 240 + 50], 1)
  assert.equal(read.mask[80 * 240 + 180], 2)
  assert.deepEqual(read.bg.map(Math.round), grey)
  // One garment alone isn't several.
  const one = picture(240, 160, (x, y) => tee(x, y, 70) ? [190, 40, 40] : grey)
  assert.equal(severalMask(one.data, one.w, one.h), null)
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
