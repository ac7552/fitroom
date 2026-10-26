// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { findPrint, measureTop, measureBottom, readBottom, shoeColors, shoeSide } from "../../app/javascript/lib/garments/print.js"
import "./support/lib.mjs"

const { bottomsPhotoUV } = await import("lib/garments/photo_map")
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
