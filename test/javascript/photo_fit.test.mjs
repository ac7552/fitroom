// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import "./support/lib.mjs"

const { clothMask } = await import("lib/garments/redrape")
const { measureOutline, fitChart, constructionFrom } = await import("lib/garments/photo_fit")
const { draftTop, measures, STYLES } = await import("lib/garments/pattern")

// A dark tee laid flat on a light backdrop, 300 by 360: a body 100 wide from the shoulders (row 60) to the
// hem (row 300), a crew band 6 rows high over a 40-wide neck, and sleeves laid out to the sides, apart from
// the body, ending at row 160 (short) or 300 (long, with a narrower cuff when asked).
function tee({ sleeves = "short", cuff = false, hemBand = false } = {}) {
  const w = 300, h = 360, data = new Uint8ClampedArray(4 * w * h)
  const bg = [236, 236, 236], cloth = [40, 40, 60]
  const put = (x, y, c) => data.set([...c, 255], 4 * (y * w + x))
  const end = sleeves === "short" ? 160 : 300
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let c = bg
    const body = y >= 60 && y <= 300 && x >= 100 && x <= 200
    if (hemBand && y > 288 && y <= 300 && (x < 108 || x > 192)) { put(x, y, c); continue }
    if (body) c = cloth
    // The band round the neck, with the opening between its sides at the front.
    if (y >= 54 && y < 60 && x >= 100 && x <= 200 && !(x > 130 && x < 170 && y >= 56)) c = cloth
    if (y >= 60 && y < 72 && x > 130 && x < 170) c = bg   // the neck opening, seen through to the backdrop
    // Sleeves: 24 wide, joined to the body at the shoulder for 14 rows (the cap), then out at a slight angle
    // apart from the body by a 10-pixel gap.
    for (const [x0, dir] of [[100, -1], [200, 1]]) {
      const s = (y - 60) / Math.max(1, end - 60)
      if (y >= 60 && y <= end) {
        const joined = y < 74
        const inner = x0 + dir * (joined ? 0 : 10 + Math.round(10 * s)), outer = inner + dir * (cuff && y > end - 14 ? 16 : 24)
        if ((dir < 0 && x <= inner && x >= outer) || (dir > 0 && x >= inner && x <= outer)) c = cloth
      }
    }
    put(x, y, c)
  }
  return { data, w, h }
}

function outlineOf(options) {
  const { data, w, h } = tee(options)
  const found = clothMask(data, w, h)
  return measureOutline({ mask: found.mask, box: { ...found.box, w, h } })
}

test("measures a laid-flat tee: shoulders, underarm, hem, sleeves apart", () => {
  const o = outlineOf()
  assert.ok(o.apart)
  assert.ok(!o.sleeveless)
  assert.ok(Math.abs(o.shoulderW - 100) <= 6, `shoulders ${o.shoulderW}`)
  assert.ok(Math.abs(o.underarmW - 100) <= 4, `underarm ${o.underarmW}`)
  assert.ok(Math.abs(o.bodyLength - 240) <= 8, `length ${o.bodyLength}`)
  assert.ok(o.sleeveLength > 90 && o.sleeveLength < 120, `sleeve ${o.sleeveLength}`)
  assert.equal(o.hemShape, "straight")
  assert.equal(o.collar, "band")
})

test("fits the chart to the outline, keeping the grading, and reads the make", () => {
  const o = outlineOf({ sleeves: "long", cuff: true })
  const chart = { sizes: [{ name: "S", chest: 96, length: 60, sleeve: 50 }, { name: "M", chest: 104, length: 62, sleeve: 52 }, { name: "L", chest: 112, length: 64, sleeve: 54 }] }
  const fit = fitChart(chart, o, { chest: 104, length: 62 })
  assert.equal(fit.by, "chest")
  // Half the chest is 52 cm over about 100 pixels: about 0.52 cm a pixel; the body is 240 pixels, so 125 cm,
  // capped at a quarter over the chart's 62.
  assert.ok(Math.abs(fit.scale - 0.52) < 0.04, `scale ${fit.scale}`)
  assert.equal(fit.sizes[1].length, 77.5)
  assert.equal(fit.sizes[0].length, 75, "every size moves by the sample's share")
  assert.ok(fit.moved.includes("length") && fit.moved.includes("shoulders"))
  assert.ok(fit.sizes[1].photo.armhole > 4, "the armhole's depth from the photo")
  const make = constructionFrom(o, fit.scale)
  assert.equal(make.sleeves, "long")
  assert.equal(make.cuffBand, true)
  assert.equal(make.collar, "band")
})

test("a plain hem reads as no band; a narrowed one is left open", () => {
  assert.equal(outlineOf({ hemBand: true }).hemBand, null)
  assert.equal(outlineOf().hemBand, false)
})

test("the pattern follows the photo's make and proportions", () => {
  const body = { chest: 96, waist: 84, shoulders: 44, arm: 60, height: 178, neck: 40, armpit: 19, bicep: 32, wrist: 17 }
  const size = { chest: 110, length: 70, sleeve: 60 }
  const plain = draftTop("shirt", size, body)
  assert.ok(plain.panels.collar, "a shirt has a collar")
  const open = draftTop("shirt", size, body, { photo: { collar: "open", sleeves: "short", hemBand: false } })
  assert.ok(!open.panels.collar, "the photo showed no collar")
  assert.ok(!open.panels.cuff_L, "short sleeves have no cuffs")
  const banded = draftTop("tee", size, body, { photo: { hemBand: true, sleeves: "long", cuffBand: true } })
  assert.ok(banded.panels.waistband && banded.panels.cuff_L)
  const m = measures(STYLES.tee, { ...size, photo: { neckWidth: 9, neckDepth: 12, armhole: 30, bicep: 48 } }, body)
  assert.equal(m.neckWidth, 9)
  assert.equal(m.frontNeck, 12)
  assert.equal(m.armhole, 30)
  assert.equal(m.bicep, 48)
  const narrow = measures(STYLES.tee, { ...size, photo: { bicep: 10 } }, body)
  assert.ok(narrow.bicep > 30, "never narrower than the arm")
})
