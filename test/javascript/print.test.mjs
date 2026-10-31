// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { findPrint, garmentRows, sidesFromCuffs, stripeStrip, stripeColumns, measureTop, measureBottom, readBottom, readDress, shoeColors, shoeSide } from "../../app/javascript/lib/garments/print.js"
import "./support/lib.mjs"

const { bottomsPhotoUV, dressPhotoUV } = await import("lib/garments/photo_map")
const { draftTop } = await import("lib/garments/pattern")
const { draftBottoms } = await import("lib/garments/pants")
const { buildCloth } = await import("lib/garments/cloth")

// A made-up product photo: a navy tee on a light grey background, with a white square printed on its chest.
function photo({ print = true } = {}) {
  const w = 200, h = 200, data = new Uint8ClampedArray(4 * w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = [236, 236, 236]
      const body = x > 50 && x < 150 && y > 30 && y < 160, sleeves = y > 30 && y < 70 && x > 20 && x < 180
      if (body || sleeves) c = [31, 44, 77]
      if (print && x > 80 && x < 120 && y > 60 && y < 100) c = [250, 250, 250]
      data.set([...c, 255], 4 * (y * w + x))
    }
  }
  return { data, w, h }
}

test("finds the garment's colour and the print on its front", () => {
  const { data, w, h } = photo()
  const found = findPrint(data, w, h)
  assert.equal(found.color, "#1f2c4d")
  assert.deepEqual(found.rect.slice(0, 1), [51])
  assert.ok(found.print.coverage > 0.08 && found.print.coverage < 0.16, `coverage ${found.print.coverage}`)
  // The print keeps its colour; plain cloth around it is see-through.
  const at = (x, y) => 4 * (y * found.print.width + x)
  assert.equal(found.print.data[at(49, 50) + 3], 255)
  assert.equal(found.print.data[at(10, 100) + 3], 0)
})

test("a plain garment has no print", () => {
  const { data, w, h } = photo({ print: false })
  assert.equal(findPrint(data, w, h).print, null)
})

// A black hoodie with a big chest graphic (a row of bold red letters over a line of yellow text), as wide as
// most of the front, down to about halfway; plain below it, round the pocket, and at the sides.
function bigChestGraphic() {
  const w = 400, h = 440, data = new Uint8ClampedArray(4 * w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = [236, 236, 236]
      const body = x >= 100 && x < 300 && y >= 80 && y < 380, sleeves = y >= 80 && y < 140 && x >= 60 && x < 340
      if (body || sleeves) c = [24, 25, 28]
      const letters = x >= 120 && x < 285 && y >= 120 && y < 210 && (x - 120) % 33 < 28
      const text = x >= 125 && x < 280 && y >= 215 && y < 235 && (x - 125) % 9 < 6
      if (letters) c = [176, 36, 40]
      if (text) c = [218, 178, 70]
      data.set([...c, 255], 4 * (y * w + x))
    }
  }
  return { data, w, h }
}

test("a big chest graphic isn't an all-over print: it isn't repeated over the sleeves and back", () => {
  const { data, w, h } = bigChestGraphic()
  const found = findPrint(data, w, h)
  // It covers more than a quarter of the front (once called all-over on that alone), but only its top half.
  assert.ok(found.print.coverage > 0.25, `coverage ${found.print.coverage}`)
  assert.ok(found.print.spread < 0.8, `spread ${found.print.spread}`)
  assert.equal(found.print.allOver, false)
  assert.equal(found.print.stripes, false)
  assert.equal(found.look.allOver, false)
  // Plain cloth below the graphic stays see-through, so the cloth's own colour shows there.
  const { data: pixels, width, height } = found.print
  assert.equal(pixels[4 * (Math.round(height * 0.85) * width + Math.round(width * 0.2)) + 3], 0)
})

// A tee laid flat: its body, and sleeves from its shoulders down to armpit (how far down its arms are sewn in).
function tee({ armpit, sleeveOut = 30 }) {
  const w = 240, h = 240, data = new Uint8ClampedArray(4 * w * h)
  const top = 30, bottom = 190, x0 = 70, x1 = 170
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const body = x > x0 && x < x1 && y > top && y < bottom
      const sleeves = y > top && y < top + armpit && x > x0 - sleeveOut && x < x1 + sleeveOut
      data.set([...(body || sleeves ? [200, 60, 60] : [236, 236, 236]), 255], 4 * (y * w + x))
    }
  }
  return { data, w, h }
}

test("reads how high a tee's arms are sewn in, against its width", () => {
  const baby = tee({ armpit: 50 }), boxy = tee({ armpit: 80 })
  const close = measureTop(baby.data, baby.w, baby.h), roomy = measureTop(boxy.data, boxy.w, boxy.h)
  assert.ok(Math.abs(close.length - 160 / 100) < 0.08, `length ${close.length}`)
  assert.ok(close.armpit * close.length < 0.62, `close depth ${close.armpit * close.length}`)
  assert.ok(roomy.armpit * roomy.length >= 0.72, `roomy depth ${roomy.armpit * roomy.length}`)
  assert.ok(close.waist > 0.95 && close.waist < 1.05, `waist ${close.waist}`)
})

// Pants laid flat: a waistband, a seat, two legs from the crotch down; or a skirt flaring out.
function bottoms({ hem = 30, skirt = false }) {
  const w = 240, h = 300, data = new Uint8ClampedArray(4 * w * h)
  const top = 20, crotch = 100, bottom = 280, x0 = 70, x1 = 170
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = false
      if (y > top && y < bottom) {
        const t = (y - crotch) / (bottom - crotch)
        if (skirt) { const half = 50 + (y - top) * 0.25; on = Math.abs(x - 120) < half }
        else if (y < crotch) on = x > x0 && x < x1
        else { const legW = 48 + (hem - 48) * t; on = (x > x0 && x < x0 + legW) || (x < x1 && x > x1 - legW) }
      }
      data.set([...(on ? [40, 40, 44] : [236, 236, 236]), 255], 4 * (y * w + x))
    }
  }
  return { data, w, h }
}

test("reads pants' legs and a skirt's flare, against the waist", () => {
  const wide = bottoms({ hem: 48 }), slim = bottoms({ hem: 24 }), skirt = bottoms({ skirt: true })
  const a = measureBottom(wide.data, wide.w, wide.h), b = measureBottom(slim.data, slim.w, slim.h), c = measureBottom(skirt.data, skirt.w, skirt.h)
  assert.ok(Math.abs(a.length - 260 / 100) < 0.1, `length ${a.length}`)
  assert.ok(Math.abs(a.rise - 80 / 260) < 0.05, `rise ${a.rise}`)
  assert.ok(a.hem > 0.42 && b.hem < 0.3, `hems ${a.hem} ${b.hem}`)
  assert.equal(c.skirt, true)
  assert.ok(c.hem > 1.6, `skirt hem ${c.hem}`)
})

test("a hem's fold of light and a shadow down the side aren't taken for a print", () => {
  const { data, w, h } = photo({ print: true })
  // A light line across near the hem, and a dark-grey streak down one side of the body.
  for (let x = 55; x < 145; x++) for (let y = 148; y < 150; y++) data.set([200, 200, 205, 255], 4 * (y * w + x))
  for (let y = 75; y < 150; y++) for (let x = 53; x < 55; x++) data.set([150, 150, 155, 255], 4 * (y * w + x))
  const found = findPrint(data, w, h)
  const at = (x, y) => 4 * (y * found.print.width + x)
  const [x0, top] = found.rect
  assert.equal(found.print.data[at(60 - x0, 149 - top) + 3], 0, "the hem's line is gone")
  assert.equal(found.print.data[at(49, 50) + 3], 255, "the print stays")
})

test("reads a pants photo to lay on the cloth: its outline, crotch and colour, the backdrop filled in", () => {
  const { data, w, h } = bottoms({ hem: 40 })
  // A pale stripe down the photo's left leg (the wearer's right).
  for (let y = 120; y < 270; y++) for (let x = 80; x < 90; x++) data.set([180, 160, 120, 255], 4 * (y * w + x))
  const read = readBottom(data, w, h)
  assert.ok(read, "read")
  assert.equal(read.color, "#28282c")
  const { top, bottom, crotch } = read.layout
  assert.ok(Math.abs(top - 21) <= 3 && Math.abs(bottom - 279) <= 3, `top ${top} bottom ${bottom}`)
  assert.ok(crotch > 85 && crotch < 115, `crotch ${crotch}`)
  // Just outside the garment, the backdrop takes the cloth's colour (so a point a little off its outline
  // isn't drawn light grey); the stripe is kept.
  const at = (pixels, x, y) => [...pixels.slice(4 * (y * w + x), 4 * (y * w + x) + 3)]
  assert.ok(at(read.filled, 68, 60).every(v => v < 90), `outside ${at(read.filled, 68, 60)}`)
  // (Its photo's light is evened out a little, so it's near its colour, not exactly it.)
  const stripe = at(read.filled, 85, 200)
  assert.ok(stripe.every((v, c) => Math.abs(v - [180, 160, 120][c]) < 25), `stripe ${stripe}`)
})

test("lays a pants photo on its cloth: the front from the photo, the wearer's left on its right, the back softened", () => {
  const { data, w, h } = bottoms({ hem: 40 })
  const { layout } = readBottom(data, w, h)
  const pattern = draftBottoms("trousers", { waist: 86, seat: 104, thigh: 62, inseam: 76, leg_opening: 40 }, { waist: 86.4, hips: 101, inseam: 81, height: 178, rise: 24 })
  const cloth = buildCloth(pattern, 2)
  const uv = bottomsPhotoUV(cloth, pattern, layout)
  const by = name => cloth.points.map((_, i) => i).filter(i => cloth.panels[cloth.panel[i]] === name)
  for (let i = 0; i < cloth.points.length; i++) {
    assert.ok(uv[3 * i] >= 0 && uv[3 * i] <= 1 && uv[3 * i + 1] >= 0 && uv[3 * i + 1] <= 1, `point ${i} off the photo`)
  }
  const mean = list => list.reduce((s, i) => s + uv[3 * i], 0) / list.length
  assert.ok(mean(by("front_L")) > 0.5 && mean(by("front_R")) < 0.5, "the wearer's left is on the photo's right")
  assert.ok(by("front_L").every(i => uv[3 * i + 2] === 1), "the front takes the photo")
  assert.ok(by("back_L").every(i => uv[3 * i + 2] === 2), "the back takes the softened copy")
  // Every point lands on the garment, not the backdrop.
  const on = i => { const x = Math.round(uv[3 * i] * w), y = Math.round((1 - uv[3 * i + 1]) * h); return data[4 * (y * w + x)] < 100 }
  const off = by("front_L").filter(i => !on(i))
  assert.ok(off.length < by("front_L").length * 0.02, `${off.length} front points off the garment`)
})

// A layered long-sleeve tee: a navy body with long grey sleeves hanging beside it (as Ksubi's is
// photographed), and a small patch on a sleeve that's only a graphic.
function layered({ sleeve = [150, 150, 156], patch = false } = {}) {
  const w = 240, h = 260, data = new Uint8ClampedArray(4 * w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let c = [236, 236, 236]
    const torso = x >= 70 && x < 170 && y >= 30 && y < 200
    const left = x >= 40 && x < 64 && y >= 30 && y < 225, right = x >= 176 && x < 200 && y >= 30 && y < 225
    if (left || right || (y >= 30 && y < 52 && x >= 40 && x < 200)) c = sleeve
    if (torso) c = [31, 44, 77]
    if (patch && x >= 44 && x < 60 && y >= 90 && y < 110) c = [220, 40, 40]
    data.set([...c, 255], 4 * (y * w + x))
  }
  return { data, w, h }
}

test("sleeves another colour all round are wrapped round, with their cuffs' colour; a graphic on one isn't", () => {
  const grey = layered()
  const found = findPrint(grey.data, grey.w, grey.h)
  assert.equal(found.color, "#1f2c4d")
  for (const side of ["left", "right"]) {
    assert.ok(found.sleeves[side].wrap, side)
    assert.equal(found.sleeves[side].cuff, "#96969c", side)
  }
  const navy = layered({ sleeve: [31, 44, 77], patch: true })
  const graphic = findPrint(navy.data, navy.w, navy.h)
  assert.ok(graphic.sleeves.left && !graphic.sleeves.left.wrap && !graphic.sleeves.left.cuff, "a patch is a graphic")
})

// A navy crewneck on a hanger, its sleeves folded behind it, with the backdrop's soft shadow down its left side
// and under its hem (as Kith's Needlepoint Box Logo Nelson Crewneck is photographed).
function shadowed() {
  const w = 240, h = 260, data = new Uint8ClampedArray(4 * w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let c = [236, 236, 236]
    const t = (y >= 40 && y < 222 && x >= 46 && x < 70) ? 1 - (70 - x) / 24 : (y >= 200 && y < 214 && x >= 52 && x < 196) ? 1 - (y - 200) / 14 : 0
    if (t > 0) c = [222, 222, 225].map(v => Math.round(236 + (v - 236) * (0.4 + 0.6 * t)))
    const torso = x >= 70 && x < 190 && y >= 40 && y < 200
    const shoulders = y >= 30 && y < 60 && x >= 64 + (60 - y) * 0.3 && x < 196 - (60 - y) * 0.3
    if (torso || shoulders) c = [22, 28, 41]
    data.set([...c, 255], 4 * (y * w + x))
  }
  return { data, w, h }
}

test("the backdrop's shadow beside a garment isn't read as a grey sleeve, nor as front", () => {
  const { data, w, h } = shadowed()
  const found = findPrint(data, w, h)
  assert.equal(found.color, "#161c29")
  assert.equal(found.sleeves.left, null)
  assert.equal(found.sleeves.right, null)
  // The front is the body's own, side to side and down to its hem: a logo in its middle is laid in the middle.
  assert.deepEqual([found.rect[0], found.rect[2], found.rect[3]], [70, 189, 199])
  // White sleeves (lighter than the backdrop) aren't shadow: they're still wrapped round.
  const white = layered({ sleeve: [250, 250, 250] })
  const sleeved = findPrint(white.data, white.w, white.h)
  assert.ok(sleeved.sleeves.left?.wrap && sleeved.sleeves.right?.wrap)
})

// A made-up dress photo: a wine slip dress on two straps, fitted to the waist and flaring to its hem, with a
// pale square on the skirt at the photo's right (the wearer's left).
function dressPhoto() {
  const w = 200, h = 320, data = new Uint8ClampedArray(4 * w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = [236, 236, 236]
      const straps = y >= 20 && y < 60 && ((x >= 70 && x < 76) || (x >= 124 && x < 130))
      const half = y < 60 ? 0 : y < 140 ? 34 : 34 + (y - 140) * 0.3
      if (straps || (y >= 60 && y < 300 && Math.abs(x - 100) < half)) c = [92, 22, 40]
      if (y >= 200 && y < 240 && x >= 112 && x < 140) c = [240, 210, 220]
      data.set([...c, 255], 4 * (y * w + x))
    }
  }
  return { data, w, h }
}

test("reads a dress photo to lay on the cloth, and lays it: the front from the photo, the back softened", () => {
  const { data, w, h } = dressPhoto()
  const read = readDress(data, w, h)
  assert.ok(read, "read")
  assert.equal(read.color, "#5c1628")
  assert.ok(read.layout.dress)
  assert.ok(Math.abs(read.layout.top - 20) <= 3 && Math.abs(read.layout.bottom - 299) <= 3, `top ${read.layout.top} bottom ${read.layout.bottom}`)
  const body = { chest: 91.5, waist: 74, hips: 100, shoulders: 39.5, arm: 58, height: 165, neck: 33, armpit: 20.8, bicep: 26, wrist: 15 }
  const pattern = draftTop("dress", { chest: 87, waist: 70, hips: 95, length: 95 }, body, { sleeves: "thin_straps", neckline: "scoop", length: "midi", fit: "flared", stretch: false, fabric: "silk" })
  const cloth = buildCloth(pattern, 2)
  const uv = dressPhotoUV(cloth, pattern, read.layout)
  const by = name => cloth.points.map((_, i) => i).filter(i => cloth.panels[cloth.panel[i]] === name)
  for (let i = 0; i < cloth.points.length; i++) assert.ok(uv[3 * i] >= 0 && uv[3 * i] <= 1 && uv[3 * i + 1] >= 0 && uv[3 * i + 1] <= 1, `point ${i} off the photo`)
  assert.ok(by("front").every(i => uv[3 * i + 2] === 1) && by("back").every(i => uv[3 * i + 2] === 2))
  // The front's points land on the dress, and the square on the wearer's left of the skirt.
  const pixel = i => { const x = Math.min(w - 1, Math.round(uv[3 * i] * w)), y = Math.min(h - 1, Math.round((1 - uv[3 * i + 1]) * h)); return [x, y, data[4 * (y * w + x)]] }
  const off = by("front").filter(i => pixel(i)[2] > 200 && !(pixel(i)[1] >= 200 && pixel(i)[1] < 240))
  assert.ok(off.length < by("front").length * 0.03, `${off.length} of ${by("front").length} front points off the dress`)
  const onSquare = by("front").filter(i => { const [x, y] = pixel(i); return y >= 205 && y < 235 && x >= 116 && x < 136 })
  assert.ok(onSquare.length && onSquare.every(i => cloth.points[i][0] > 0), "the square is on the wearer's left")
})

test("lays a jacket's photo on it the same way, its hem band along the photo's hem", () => {
  const { data, w, h } = dressPhoto()
  const { layout } = readDress(data, w, h)
  const body = { chest: 101.6, waist: 86.4, shoulders: 45.5, arm: 65.5, height: 178, neck: 40, armpit: 19 }
  const pattern = draftTop("bomber", { chest: 124, shoulders: 52, sleeve: 64, length: 66 }, body, { hood: true })
  const cloth = buildCloth(pattern, 2)
  const uv = dressPhotoUV(cloth, pattern, layout)
  const on = name => cloth.points.map((_, i) => i).filter(i => cloth.panels[cloth.panel[i]] === name)
  for (let i = 0; i < cloth.points.length; i++) assert.ok(uv[3 * i] >= 0 && uv[3 * i] <= 1 && uv[3 * i + 1] >= 0 && uv[3 * i + 1] <= 1, `point ${i} off the photo`)
  assert.ok(on("front").every(i => uv[3 * i + 2] === 1))
  // The hem band's front half on the photo, at its bottom rows; the hood the softened copy, at its top.
  const band = on("waistband"), rowOf = i => (1 - uv[3 * i + 1]) * h
  assert.ok(band.some(i => uv[3 * i + 2] === 1) && band.some(i => uv[3 * i + 2] === 2))
  assert.ok(band.every(i => rowOf(i) > layout.bottom - (layout.bottom - layout.top) * 0.12), "the band at the hem")
  assert.ok(on("hood_L").every(i => uv[3 * i + 2] === 2 && rowOf(i) < layout.top + (layout.bottom - layout.top) * 0.2))
})

test("pants on a hanger: the hook and the hanger's bar aren't taken for the waistband", () => {
  const { data, w, h } = bottoms({ hem: 40 })
  // Move the pants down to leave room above, then draw the hook and the bar over their top.
  const shifted = new Uint8ClampedArray(data.length).fill(236)
  for (let i = 3; i < shifted.length; i += 4) shifted[i] = 255
  const down = 20
  shifted.set(data.subarray(0, 4 * w * (h - down)), 4 * w * down)
  const paint = (x0, x1, y0, y1, c) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) shifted.set([...c, 255], 4 * (y * w + x)) }
  paint(118, 122, 4, 38, [30, 30, 30])        // the hook
  paint(64, 176, 38, 46, [20, 20, 20])        // the bar, wider than the waist
  paint(64, 176, 46, 50, [236, 236, 236])     // the gap between the bar and the cloth, the clips aside
  paint(80, 86, 46, 50, [165, 165, 165]); paint(154, 160, 46, 50, [165, 165, 165])   // its metal clips
  const read = readBottom(shifted, w, h)
  assert.ok(read, "read")
  assert.ok(read.layout.top >= 48 && read.layout.top <= 44 + down, `top ${read.layout.top}`)
  assert.equal(read.color, "#28282c")
})

test("a striped front keeps its stripes, while a single fold's line is dropped", () => {
  const w = 200, h = 200
  const make = count => {
    const data = new Uint8ClampedArray(4 * w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let c = [236, 236, 236]
      if ((x > 50 && x < 150 && y > 30 && y < 170) || (y > 30 && y < 70 && x > 20 && x < 180)) c = [20, 20, 22]
      const stripe = [70, 85, 115, 130].slice(0, count).some(sx => x >= sx && x < sx + 2)
      if (stripe && y > 40 && y < 168) c = [190, 40, 50]
      data.set([...c, 255], 4 * (y * w + x))
    }
    return findPrint(data, w, h)
  }
  assert.ok(make(4).print?.coverage > 0.02)
  assert.equal(make(1).print, null)
})

test("wide legs lying touching don't put the crotch down at the knees", () => {
  const { data, w, h } = bottoms({ hem: 48 })
  // Fill the gap between the legs down to near the hem, as wide sweatpants laid flat lie touching.
  for (let y = 100; y < 250; y++) for (let x = 70; x < 170; x++) data.set([40, 40, 44, 255], 4 * (y * w + x))
  const { layout } = readBottom(data, w, h)
  const share = (layout.crotch - layout.top) / (layout.bottom - layout.top)
  assert.ok(share > 0.27 && share < 0.4, `crotch at ${share.toFixed(2)} of the length`)
})

test("a pale logo down a leg's outer seam stays on the photo", () => {
  const { data, w, h } = bottoms({ hem: 40 })
  // A cream band of lettering right along the photo's left leg's outer edge, near the backdrop's colour.
  for (let y = 130; y < 250; y++) for (let x = 71; x < 79; x++) data.set([222, 218, 205, 255], 4 * (y * w + x))
  const read = readBottom(data, w, h)
  const at = (x, y) => [...read.filled.slice(4 * (y * w + x), 4 * (y * w + x) + 3)]
  assert.ok(at(75, 190).every(v => v > 170), `logo ${at(75, 190)}`)
})

test("the back's softened copy has the front's print painted out, keeping the wash and a band round the leg", () => {
  const { data, w, h } = bottoms({ hem: 40 })
  const paint = (x0, x1, y0, y1, c) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data.set([...c, 255], 4 * (y * w + x)) }
  paint(84, 96, 150, 240, [200, 40, 50])      // lettering down the photo's left leg
  paint(88, 100, 60, 72, [190, 170, 60])      // a hip logo
  paint(140, 160, 140, 230, [62, 62, 66])     // a broad, slightly lighter wash on the right leg
  paint(130, 170, 262, 278, [120, 120, 124])  // a contrast band right round the right leg's hem
  const read = readBottom(data, w, h)
  const at = (pixels, x, y) => [...pixels.slice(4 * (y * w + x), 4 * (y * w + x) + 3)]
  assert.ok(read.print[195 * w + 90] && read.print[66 * w + 94], "the lettering and the logo are print")
  assert.ok(at(read.filled, 90, 195)[0] > 150, `the front keeps the lettering ${at(read.filled, 90, 195)}`)
  assert.ok(at(read.soft, 90, 195).every(v => v < 80), `the back has it painted out ${at(read.soft, 90, 195)}`)
  assert.ok(at(read.soft, 94, 66).every(v => v < 80), `and the logo ${at(read.soft, 94, 66)}`)
  assert.ok(!read.print[185 * w + 150] && at(read.soft, 150, 185)[0] > 52, `the wash stays ${at(read.soft, 150, 185)}`)
  assert.ok(!read.print[270 * w + 150] && at(read.soft, 150, 270)[0] > 100, `the band stays ${at(read.soft, 150, 270)}`)
  // A thin bit hanging below the hem (lettering running off the leg) isn't the pants' length.
  paint(86, 92, 280, 296, [200, 40, 50])
  assert.ok(Math.abs(readBottom(data, w, h).layout.bottom - read.layout.bottom) <= 1, "the hem stays where it was")
})

// A made-up boot's side photo: a tall shaft at the heel (left), a low toe (right), a gap of backdrop between
// its laces, and a sole.
function bootPhoto() {
  const w = 240, h = 160, data = new Uint8ClampedArray(4 * w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = [238, 238, 238]
      if (y >= 120 && y < 132 && x >= 40 && x < 210) c = [190, 140, 80]
      else if (y < 120 && x >= 42 && x < 208 && (x < 120 ? y >= 30 : y >= 30 + (x - 120) * 0.8)) c = [60, 40, 30]
      if (x >= 100 && x < 106 && y >= 40 && y < 48) c = [238, 238, 238]
      data.set([...c, 255], 4 * (y * w + x))
    }
  }
  return { data, w, h }
}

test("reads a shoe's side photo: its outline heel to toe, which way the toe points, with backdrop gaps taken out", () => {
  const { data, w, h } = bootPhoto()
  const side = shoeSide(data, w, h)
  assert.equal(side.toeRight, true)
  assert.ok(Math.abs(side.left - 40 / w) < 0.01 && Math.abs(side.right - 210 / w) < 0.01)
  assert.ok(side.top[2] < 0.25, "tall at the heel")
  assert.ok(side.top.at(-3) > 0.6, "low at the toe")
  assert.ok(Math.abs(side.bottom[10] - 132 / h) < 0.03)
  assert.equal(side.mask[44 * w + 102], 0, "the gap between the laces")
  assert.equal(side.mask[60 * w + 102], 1)
  // Turned round, the toe points left and the outline still runs heel to toe.
  const flipped = new Uint8ClampedArray(data.length)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) flipped.set(data.subarray(4 * (y * w + x), 4 * (y * w + x) + 4), 4 * (y * w + w - 1 - x))
  const turned = shoeSide(flipped, w, h)
  assert.equal(turned.toeRight, false)
  assert.ok(Math.abs(turned.top[2] - side.top[2]) < 0.02)
  // A shoe seen from the front isn't a side view.
  const front = new Uint8ClampedArray(4 * w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) front.set(x > 100 && x < 140 && y > 10 && y < 150 ? [60, 40, 30, 255] : [238, 238, 238, 255], 4 * (y * w + x))
  assert.equal(shoeSide(front, w, h), null)
})

test("a shoe shot at an angle keeps its upper's colour, not its shadows', and its sole's", () => {
  // A tan boot: a lit face, a darker and more saturated shaded face, warm bounce light under the toe, and a
  // cream sole along the bottom. Too tall for its length to be a side view.
  const w = 240, h = 240, data = new Uint8ClampedArray(4 * w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let c = [240, 240, 240]
    const inside = x > 60 && x < 180 && y > 30 && y < 210
    if (inside) c = x < 120 ? [201, 166, 107] : [170, 110, 40]
    if (inside && y > 185) c = [222, 214, 190]
    if (inside && y > 170 && y <= 185 && x >= 120) c = [190, 100, 20]
    data.set([...c, 255], 4 * (y * w + x))
  }
  const read = shoeColors(data, w, h)
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  assert.equal(read.side, null)
  assert.ok(rgb(read.color).every((v, c) => Math.abs(v - [201, 166, 107][c]) <= 10), `upper ${read.color}`)
  assert.ok(rgb(read.sole).every((v, c) => Math.abs(v - [222, 214, 190][c]) <= 10), `sole ${read.sole}`)
  assert.equal(read.collar, null, "the shaded half of the top isn't a collar")
})

// A striped zip hoodie laid flat with its hood standing up (as shops photograph one): a cream body with green,
// black and brown stripes right across body and sleeves, a dark zip down the middle, the sleeves hanging
// straight down beside the body and on past the hem, and the hood above the shoulders showing its dark inside.
function stripedHoodie({ hood = true } = {}) {
  const w = 300, h = 360, data = new Uint8ClampedArray(4 * w * h)
  const shoulders = 110, hem = 270, cuffs = 320, x0 = 100, x1 = 200, sleeve = 30
  const stripes = [[0, 12, [235, 230, 210]], [12, 20, [40, 120, 70]], [20, 26, [235, 230, 210]], [26, 36, [30, 30, 34]], [36, 48, [120, 90, 40]]]
  const stripeAt = y => { const k = (y - shoulders) % 48; return stripes.find(([a, b]) => k >= a && k < b)[2] }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = [236, 236, 236]
      const body = x >= x0 && x < x1 && y >= shoulders && y < hem
      const sleeves = ((x >= x0 - sleeve && x < x0) || (x >= x1 && x < x1 + sleeve)) && y >= shoulders && y < cuffs
      if (body || sleeves) c = stripeAt(y)
      if (body && Math.abs(x - 150) < 2) c = [50, 50, 55]   // the zip
      if (hood) {
        const dx = (x - 150) / 34, dy = (y - 70) / 44
        if (dx * dx + dy * dy < 1) c = dx * dx * 1.6 + dy * dy * 1.6 < 1 && y < 108 ? [28, 28, 30] : [40, 120, 70]
      }
      data.set([...c, 255], 4 * (y * w + x))
    }
  }
  return { data, w, h, shoulders, hem, x0, x1, stripeAt }
}

test("a hoodie's print starts at the shoulders below the hood and ends at the hem, with the hood's inside left out", () => {
  const { data, w, h, shoulders, hem, x0, x1 } = stripedHoodie()
  const found = findPrint(data, w, h)
  const [, top, , bottom] = found.rect
  assert.ok(top >= shoulders - 2 && top <= shoulders + 8, `top ${top} (shoulders at ${shoulders})`)
  assert.ok(Math.abs(bottom - (hem - 1)) <= 3, `bottom ${bottom} (hem at ${hem})`)
  assert.ok(found.print.allOver, "an all-over print")
  // Nothing of the hood's dark inside ends up on the front.
  const { data: pixels, width, height } = found.print
  let dark = 0
  for (let k = 0; k < width * height; k++) if (pixels[4 * k + 3] > 0 && pixels[4 * k] === 28 && pixels[4 * k + 1] === 28 && pixels[4 * k + 2] === 30) dark++
  assert.equal(dark, 0, `${dark} hood pixels in the print`)
  assert.equal(pixels[4 * (2 * width + Math.round(width / 2)) + 3], 0, "the neck opening is clear")
  assert.ok(found.rect[0] <= x0 && found.rect[2] >= x1 - 1)
})

test("a striped front is read as stripes: a column of its colours by height, with no hood or zip in it", () => {
  const { data, w, h, shoulders, hem, stripeAt } = stripedHoodie()
  const found = findPrint(data, w, h)
  assert.equal(found.print.stripes, true)
  const { strip } = found.print
  // It runs from the shoulders to the hem, and on down the sleeves hanging below the hem (to the cuffs).
  const top = found.rect[1]
  assert.ok(strip.height >= found.rect[3] - top + 1 && Math.abs(strip.height - (320 - top)) <= 2, `strip height ${strip.height}`)
  assert.ok(Math.abs(strip.span - strip.height / (found.rect[3] - top + 1)) < 1e-6)
  for (const y of [shoulders + 30, shoulders + 65, shoulders + 100, hem - 10, hem + 30]) {
    const want = stripeAt(y), got = [...strip.data.slice(4 * (y - top), 4 * (y - top) + 3)]
    assert.ok(got.every((v, c) => Math.abs(v - want[c]) <= 6), `row ${y}: ${got} for ${want}`)
  }
  // A plain tee with a chest print isn't striped.
  const plain = photo()
  assert.equal(findPrint(plain.data, plain.w, plain.h).print.stripes, false)
})

test("measures a hooded top from its shoulders, not from the top of its hood", () => {
  const up = stripedHoodie(), down = stripedHoodie({ hood: false })
  const a = measureTop(up.data, up.w, up.h), b = measureTop(down.data, down.w, down.h)
  assert.ok(Math.abs(a.length - b.length) < 0.05, `length ${a.length} with the hood up, ${b.length} without`)
  assert.ok(Math.abs(a.length - 160 / 160) < 0.08, `length ${a.length}`)
})

test("stripes are laid by height, so a sleeve's meet the body's at the shoulder seam and the cuff carries on below the sleeve", async () => {
  const { draftTop } = await import("lib/garments/pattern")
  const { buildCloth } = await import("lib/garments/cloth")
  const { heightsDown } = await import("lib/garments/photo_map")
  const pattern = draftTop("hoodie", { chest: 86, shoulders: 38, sleeve: 60, length: 52 }, { chest: 91, waist: 74, shoulders: 39.5, arm: 58, height: 165, armpit: 18, bicep: 28, wrist: 15, neck: 36, head: 55 }, { fit: "fitted", stretch: true, closure: "zip" })
  const cloth = buildCloth(pattern, 1.6)
  const down = heightsDown(cloth, pattern)
  const m = pattern.measures
  const points = name => cloth.points.map((_, i) => i).filter(i => cloth.panels[cloth.panel[i]] === name)
  const topOf = name => Math.min(...points(name).map(i => down[i]))
  // The front's shoulder point and the sleeve's cap top are at the same height.
  assert.ok(Math.abs(topOf("sleeve_L") - m.shoulderDrop) < 0.5, `sleeve top at ${topOf("sleeve_L")}`)
  const frontShoulder = points("front").filter(i => Math.abs(Math.abs(cloth.points[i][0]) - m.shoulders / 2) < 1)
  assert.ok(frontShoulder.some(i => Math.abs(down[i] - m.shoulderDrop) < 1.2), "the front's shoulder point")
  // The cuff starts where the sleeve ends, the hem band where the body ends.
  assert.ok(Math.abs(topOf("cuff_L") - (m.shoulderDrop + m.sleeve)) < 0.5, `cuff top at ${topOf("cuff_L")}`)
  assert.ok(Math.abs(topOf("waistband") - m.length) < 0.5, `waistband top at ${topOf("waistband")}`)
  // A fitted knit is cut without the usual room, and draped as a knit that gives.
  assert.equal(pattern.fabric, "rib")
  const loose = draftTop("hoodie", { chest: 86, shoulders: 38, sleeve: 60, length: 52 }, { chest: 91, waist: 74, shoulders: 39.5, arm: 58, height: 165, armpit: 18, bicep: 28, wrist: 15, neck: 36, head: 55 }, { closure: "zip" })
  assert.ok(m.bicep < loose.measures.bicep - 3 && m.opening < loose.measures.opening - 2 && m.armhole < loose.measures.armhole, "closer sleeves and armholes")
  assert.equal(m.chest, 86)
})

// A button-up shirt laid flat (as shops photograph one): short sleeves out to the sides, a white collar at the
// top, a placket with buttons down the middle, a chest pocket, and two soft fold shadows down the front.
// stripes: [colour, colour, period, width of the first] for vertical stripes; check: the same, both ways.
function buttonUp({ stripes = null, check = false, plain = [240, 242, 245] } = {}) {
  const w = 320, h = 360, data = new Uint8ClampedArray(4 * w * h)
  const shoulders = 60, hem = 330, x0 = 90, x1 = 230
  const cloth = (x, y) => {
    if (!stripes) return plain
    const [a, b, period, first] = stripes
    const across = (x - x0) % period < first
    if (!check) return across ? a : b
    const down = (y - shoulders) % period < first
    return across && down ? a.map(v => v - 40) : across || down ? a : b
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = [244, 244, 242]
      const body = x >= x0 && x < x1 && y >= shoulders && y < hem
      const sleeves = ((x >= x0 - 50 && x < x0) || (x >= x1 && x < x1 + 50)) && y >= shoulders + (Math.abs(x - 160) - 70) * 0.5 && y < shoulders + 70
      if (body || sleeves) {
        c = cloth(x, y)
        // Soft fold shadows down the front.
        for (const [fx, depth] of [[125, 0.08], [196, 0.06]]) c = c.map(v => v * (1 - depth * Math.max(0, 1 - Math.abs(x - fx) / 6)))
      }
      if (body && Math.abs(x - 160) <= 4) c = cloth(x + 3, y)   // the placket, a little off the body's stripes
      if (body && Math.abs(x - 160) <= 2 && (y - shoulders) % 30 < 4) c = [250, 250, 248]   // buttons
      if (x >= 180 && x < 212 && y >= 90 && y < 130) c = cloth(x + 5, y)   // the pocket, its stripes off
      if (y >= shoulders - 6 && y < shoulders + 18 && Math.abs(x - 160) < 26 - (y - shoulders + 6) * 0.6) c = [247, 248, 250]   // collar
      data.set([...c.map(Math.round), 255], 4 * (y * w + x))
    }
  }
  return { data, w, h, x0, x1, cloth }
}

test("a button-up with faint vertical stripes is read as stripes down it: a row of its colours across the front", () => {
  const blue = [196, 211, 231], white = [238, 240, 243]
  const { data, w, h, x0, x1, cloth } = buttonUp({ stripes: [blue, white, 9, 5] })
  const found = findPrint(data, w, h)
  assert.ok(found.print, "a print is read (the stripes are too faint to count as print on their own)")
  assert.equal(found.print.stripes, true)
  assert.equal(found.print.allOver, true)
  const { strip } = found.print
  assert.equal(strip.vertical, true)
  assert.equal(strip.height, 1)
  // It spans the middle of the front, its sides left off; from and span say where, as shares of its width.
  const [fx0, , fx1] = found.rect
  assert.ok(Math.abs(fx0 - x0) <= 2 && Math.abs(fx1 - (x1 - 1)) <= 2, `front ${fx0}..${fx1}`)
  const pw = fx1 - fx0 + 1
  assert.ok(strip.from > 0 && strip.from < 0.1 && Math.abs(strip.from * pw + strip.width - pw * (1 - strip.from)) <= 1, `from ${strip.from}, width ${strip.width}`)
  assert.ok(Math.abs(strip.span - strip.width / pw) < 1e-6)
  // Each column's colour is the stripe's there (the placket, buttons, pocket and folds left out).
  let right = 0
  for (let c = 0; c < strip.width; c++) {
    const x = fx0 + Math.round(strip.from * pw) + c, want = cloth(x, 200)
    const got = [...strip.data.slice(4 * c, 4 * c + 3)]
    if (got.every((v, k) => Math.abs(v - want[k]) <= 12)) right++
  }
  assert.ok(right > strip.width * 0.85, `${right} of ${strip.width} columns match`)
  // The front is laid whole, as photographed.
  const { data: pixels, width, height } = found.print
  assert.equal(pixels[4 * (Math.round(height / 2) * width + 20) + 3], 255)
})

test("bold vertical stripes are read as stripes down, not across", () => {
  const { data, w, h } = buttonUp({ stripes: [[180, 40, 50], [232, 232, 226], 12, 4] })
  const found = findPrint(data, w, h)
  assert.equal(found.print.stripes, true)
  assert.equal(found.print.strip.vertical, true)
})

test("a check (stripes both ways) isn't laid as stripes: it falls back to the photo's print", () => {
  const { data, w, h } = buttonUp({ stripes: [[150, 170, 205], [238, 240, 243], 12, 6], check: true })
  const found = findPrint(data, w, h)
  assert.ok(found.print, "the photo's print")
  assert.equal(found.print.stripes, false)
  assert.equal(found.print.strip, null)
  assert.equal(found.print.allOver, true)
})

test("a plain button-up's placket, buttons, pocket and fold shadows aren't stripes", () => {
  for (const plain of [[240, 242, 245], [40, 60, 110]]) {
    const { data, w, h } = buttonUp({ plain })
    const found = findPrint(data, w, h)
    assert.ok(!found.print?.stripes, `plain ${plain} read as stripes`)
  }
  // Nor are a striped hoodie's horizontal stripes read as vertical ones.
  const hoodie = stripedHoodie()
  assert.equal(findPrint(hoodie.data, hoodie.w, hoodie.h).print.strip.vertical, undefined)
})

test("vertical stripes are laid by how far across: the back's meet the front's at the side seams, the cuffs and hem band carry on the sleeves' and body's", async () => {
  const { draftTop } = await import("lib/garments/pattern")
  const { widthsAcross } = await import("lib/garments/photo_map")
  const pattern = draftTop("shirt", { chest: 116, shoulders: 48, sleeve: 64, length: 74 }, { chest: 101.6, waist: 86.4, shoulders: 45.5, arm: 65.5, height: 178, armpit: 20, bicep: 32, wrist: 17, neck: 39, head: 57 })
  const cloth = buildCloth(pattern, 1.6)
  const across = widthsAcross(cloth, pattern)
  const m = pattern.measures
  const points = name => cloth.points.map((_, i) => i).filter(i => cloth.panels[cloth.panel[i]] === name)
  const range = name => { const v = points(name).map(i => across[i]); return [Math.min(...v), Math.max(...v)] }
  // The front from its middle; the back mirrored, so at each side seam both are the same distance across.
  assert.deepEqual(range("front").map(Math.round), [-Math.round(m.chest / 4), Math.round(m.chest / 4)])
  const sideOf = (panel, edge) => cloth.edges[`${panel}/${edge}`].map(i => across[i])
  for (const side of ["L", "R"]) {
    const f = sideOf("front", `side_${side}`), b = sideOf("back", `side_${side}`)
    assert.ok(Math.abs(Math.sign(f[0]) - Math.sign(b[0])) < 1e-6 && Math.abs(Math.abs(f[0]) - Math.abs(b[0])) < 1.5, `side ${side}: front ${f[0]}, back ${b[0]}`)
  }
  // A sleeve across its own width, from its middle; its cuff across the same width as the sleeve's hem.
  const sleeve = range("sleeve_L"), cuff = range("cuff_L")
  assert.ok(Math.abs(sleeve[0] + sleeve[1]) < 0.5 && Math.abs(sleeve[1] - m.bicep / 2) < 0.5, `sleeve ${sleeve}`)
  assert.ok(Math.abs(cuff[0] + m.opening / 2) < 0.5 && Math.abs(cuff[1] - m.opening / 2) < 0.5, `cuff ${cuff}`)
  // The hem band: as far across as the front's and back's hems it's sewn to.
  const band = range("waistband")
  assert.ok(Math.abs(band[0] + m.hem / 4) < 0.5 && Math.abs(band[1] - m.hem / 4) < 0.5, `band ${band}`)
})

// A long-sleeve flat-lay: the sleeves hang down against the body, past its hem, as most shops lay them.
function longSleeveFlatLay({ graphic = true } = {}) {
  const w = 320, h = 400, data = new Uint8ClampedArray(4 * w * h)
  const cloth = [228, 222, 206], back = [244, 244, 242]
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = back
      const body = x >= 100 && x < 220 && y >= 60 && y < 300
      const sleeveL = x >= 70 && x < 100 && y >= 64 && y < 330
      const sleeveR = x >= 220 && x < 250 && y >= 64 && y < 330
      if (body || sleeveL || sleeveR) c = cloth
      // A red graphic on the photo's left sleeve, up by the shoulder.
      if (graphic && x >= 76 && x < 94 && y >= 110 && y < 160) c = [190, 40, 40]
      data.set([...c, 255], 4 * (y * w + x))
    }
  }
  return { data, w, h }
}

test("a graphic on a long sleeve laid against the body is read off it, down from the shoulder", () => {
  const { data, w, h } = longSleeveFlatLay()
  const found = findPrint(data, w, h)
  assert.ok(found.sleeves.left, "the left sleeve's graphic")
  assert.equal(found.sleeves.right, null, "the right sleeve is plain")
  const { data: strip, width, height } = found.sleeves.left
  // Red, opaque, in the strip's upper part; the rest of it clear.
  let redTop = 0, opaqueLow = 0
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const q = 4 * (j * width + i)
      if (strip[q + 3] > 128 && strip[q] > 150 && strip[q + 1] < 90) j < height / 2 ? redTop++ : 0
      if (j > height * 0.6 && strip[q + 3] > 128) opaqueLow++
    }
  }
  assert.ok(redTop > width * height * 0.05, `red in the top half: ${redTop}`)
  assert.equal(opaqueLow, 0)
})

test("plain sleeves give no sleeve graphic", () => {
  const { data, w, h } = longSleeveFlatLay({ graphic: false })
  const found = findPrint(data, w, h)
  assert.equal(found.sleeves.left, null)
  assert.equal(found.sleeves.right, null)
})

test("a T-shirt's shoulders, sloping out from its collar to sleeves held out sideways, aren't a hood", () => {
  const w = 320, h = 360, mask = new Uint8Array(w * h)
  for (let y = 40; y < 320; y++) {
    // The collar 60 wide, widening to the shoulders (140) by y 70; the sleeves out to 260 wide down to y 130;
    // the body 150 wide to the hem.
    const half = y < 70 ? 30 + (y - 40) * (40 / 30) : y < 130 ? 130 - (y - 70) * 0.9 : 75
    for (let x = Math.round(160 - half); x < Math.round(160 + half); x++) mask[y * w + x] = 1
  }
  const rows = garmentRows(mask, w, h)
  assert.equal(rows.hood, null)
  assert.ok(rows.top < 70, `the front starts at the shoulders, not down at row ${rows.top}`)
})

// A shirt laid flat: long sleeves down its sides, touching the body, their cuffs hanging on below the hem, a
// brown trim down each sleeve and a cream body.
function overshirtFlatLay({ label = false } = {}) {
  const w = 300, h = 320, data = new Uint8ClampedArray(4 * w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = [235, 235, 235]
      const body = x >= 100 && x < 200 && y >= 40 && y < 260
      // The sleeves: from the shoulders out and down the sides, 30 wide, to below the hem.
      const leftSleeve = y >= 50 && y < 290 && x >= 70 && x < 100, rightSleeve = y >= 50 && y < 290 && x >= 200 && x < 230
      const shoulders = y >= 40 && y < 50 && x >= 70 && x < 230
      if (body || leftSleeve || rightSleeve || shoulders) c = [227, 221, 202]
      if ((leftSleeve && x >= 80 && x < 88) || (rightSleeve && x >= 212 && x < 220)) c = [110, 70, 40]
      // A small chest logo, and (optionally) a size label in the neck.
      if (x >= 160 && x < 176 && y >= 90 && y < 104) c = [190, 150, 40]
      if (label && x >= 145 && x < 155 && y >= 43 && y < 48) c = [250, 250, 250]
      data.set([...c, 255], 4 * (y * w + x))
    }
  }
  return { data, w, h }
}

test("long sleeves laid down a shirt's sides, cuffs below the hem, aren't part of its front", () => {
  const { data, w, h } = overshirtFlatLay()
  const found = findPrint(data, w, h)
  const [x0, , x1] = found.rect
  assert.ok(x0 >= 97 && x1 <= 203, `the front is the body only: ${x0}..${x1}`)
  // So the sleeves' trim isn't laid on the chest: only the logo is print.
  assert.ok(found.look.box && found.look.box.left > 0.5, `the graphic is the logo: ${JSON.stringify(found.look.box)}`)
})

test("the body's sides from the cuffs need sleeves hanging below the hem", () => {
  const w = 100, h = 100, mask = new Uint8Array(w * h)
  for (let y = 10; y < 90; y++) for (let x = 20; x < 80; x++) mask[y * w + x] = 1
  const rows = garmentRows(mask, w, h)
  assert.equal(sidesFromCuffs(mask, w, rows, 20, 79), null)
})

test("a size label in the neck isn't print on the front", () => {
  const { data, w, h } = overshirtFlatLay({ label: true })
  const found = findPrint(data, w, h)
  const { box } = found.look
  assert.ok(box && box.top > 0.15, `the graphic starts at the logo, not the label: ${JSON.stringify(box)}`)
})

test("three stripes side by side over each shoulder stay on the front; one diagonal line doesn't", () => {
  // A black jersey with a red word on its chest and, over each shoulder, `count` red stripes slanting down
  // from the neck toward the sleeves (as on the adidas x Willy Chavarria jersey).
  const w = 240, h = 240
  const make = count => {
    const data = new Uint8ClampedArray(4 * w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let c = [236, 236, 236]
      if ((x > 50 && x < 190 && y > 30 && y < 200) || (y > 30 && y < 80 && x > 20 && x < 220)) c = [24, 24, 26]
      if (x > 90 && x < 150 && y > 100 && y < 114) c = [200, 40, 40]
      for (let n = 0; n < count; n++) {
        // Each stripe: 4 px thick, 6 px apart, from the neck out and down (left side, and its mirror).
        for (const side of [-1, 1]) {
          const along = side < 0 ? 104 - x : x - 136, off = y - (42 + n * 7) - along * 0.45
          if (along > 0 && along < 44 && off >= 0 && off < 3) c = [200, 40, 40]
        }
      }
      data.set([...c, 255], 4 * (y * w + x))
    }
    return findPrint(data, w, h)
  }
  const kept = (found, x, y) => found.print.data[4 * ((y - found.rect[1]) * found.print.width + (x - found.rect[0])) + 3]
  // A point on the left side's first stripe, halfway out.
  const x = 104 - 22, y = Math.round(42 + 22 * 0.45 + 1)
  const three = make(3), one = make(1)
  assert.ok(kept(three, x, y) > 200, "the stripes stay")
  assert.ok(kept(one, x, y) < 50, "a single line goes")
  assert.ok(kept(one, 120, 106) > 200 && kept(three, 120, 106) > 200, "the word stays either way")
})

test("a print is laid from the top of the collar (about the shoulders' high points), not the shoulder line", () => {
  const w = 200, h = 220, data = new Uint8ClampedArray(4 * w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let c = [236, 236, 236]
    const collar = y >= 20 && y < 34 && x >= 80 && x < 120
    const shoulders = y >= 34 && y < 44 && x >= 80 - (y - 34) * 4 && x < 120 + (y - 34) * 4
    const body = x > 50 && x < 150 && y >= 44 && y < 180
    if (collar || shoulders || body) c = [31, 44, 77]
    if (x > 85 && x < 115 && y > 70 && y < 90) c = [250, 250, 250]
    data.set([...c, 255], 4 * (y * w + x))
  }
  const found = findPrint(data, w, h)
  // The front is read from the shoulder line (y 36) to the hem (179); the collar's top is 16 rows above it.
  assert.equal(found.rect[1], 36)
  assert.ok(Math.abs(found.print.fromTop - 16 / 159) < 0.01, `fromTop ${found.print.fromTop}`)
})
