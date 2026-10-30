// Run with: node --test test/javascript/*.test.mjs
import "./support/lib.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"

const { draftTop } = await import("lib/garments/pattern")
const { draftBottoms } = await import("lib/garments/pants")

// The example woman, and a size M from a chart like the Kith Desma's (cm).
const body = { chest: 91.5, waist: 74, hips: 100, shoulders: 39.5, arm: 58, height: 165, neck: 33, armpit: 20.8, bicep: 26, wrist: 15 }
const size = { name: "M", chest: 87.4, waist: 70.3, hips: 95, length: 80 }
const edge = (pattern, panel, name) => pattern.panels[panel].edges.find(e => e.name === name).points
const width = points => Math.max(...points.map(p => p[0])) - Math.min(...points.map(p => p[0]))

test("a dress that flares from the waist in its photo is cut flaring from the waist, its hem curved", () => {
  const cut = { sleeves: "none", neckline: "straight", length: "mini", fit: "flared", waist_flare: true, stretch: true, fabric: "structured",
                shape: { waist: 0.81, waist_at: 0.42, hips: 1.07, hem: 1.35, neck_depth: 0.1, neck_width: 0.75 } }
  const dress = draftTop("dress", size, body, cut)
  assert.equal(dress.fabric, "structured")
  const m = dress.measures
  // As wide at the hem, for its chest, as the photo.
  assert.ok(Math.abs(m.hem - size.chest * 1.35) < 0.5, `hem ${m.hem}`)
  // The side goes straight from the waist to the hem: three points, the waist's in the middle.
  const side = edge(dress, "front", "side_L")
  assert.equal(side.length, 3)
  assert.ok(Math.abs(side[1][1] + m.shaped.waistAt) < 0.01)
  // The hem curves: lower in the middle than at the sides.
  const hem = edge(dress, "front", "hem")
  const middle = hem[Math.floor(hem.length / 2)][1], end = hem[hem.length - 1][1]
  assert.ok(middle < end - 1, `middle ${middle}, side ${end}`)
  assert.ok(Math.abs(middle + m.length) < 0.01, "the length is at the middle")
  // Its neckline as deep and wide as the photo's.
  assert.ok(Math.abs(m.frontNeck - 0.1 * m.length) < 0.01)
  assert.ok(m.neckWidth > 14, `neck ${m.neckWidth}`)
  // The same dress by its words alone hangs straight from the hips.
  const words = draftTop("dress", size, body, { ...cut, fit: "fitted", waist_flare: false, shape: null })
  assert.equal(edge(words, "front", "side_L").length, 4)
  assert.ok(words.measures.hem < m.hem * 0.8)
})

test("a halter's straps rise to the neck, its armholes cut deep and its back open", () => {
  const halter = draftTop("dress", size, body, { sleeves: "halter", neckline: "high", length: "maxi", fit: "fitted", stretch: true, fabric: "stretch" })
  const tank = draftTop("dress", size, body, { sleeves: "straps", neckline: "high", length: "maxi", fit: "fitted", stretch: true, fabric: "stretch" })
  assert.ok(halter.measures.shoulders / 2 < 13, `strap ends ${halter.measures.shoulders / 2} cm out`)
  assert.ok(halter.measures.shoulders < tank.measures.shoulders - 6)
  assert.ok(halter.measures.backNeck > tank.measures.backNeck + 8)
  assert.ok(width(edge(halter, "front", "shoulder_L")) > 3.5, "a strap, not a point")
})

test("a skirt is as full at its hem as its photo, and a flared hem flares", () => {
  const skirt = (cut) => draftBottoms("skirt", { name: "M", waist: 76, seat: 103, length: 40 }, body, cut).measures
  const straight = skirt({ length: "mini", fit: "relaxed", stretch: false, fabric: "silk" })
  const flared = skirt({ length: "mini", fit: "relaxed", stretch: false, fabric: "silk", hem_flare: true })
  const photo = skirt({ length: "mini", fit: "relaxed", stretch: false, fabric: "silk", shape: { hips: 1.3, hem: 2.0 } })
  assert.ok(flared.hem > straight.hem * 1.15)
  assert.ok(Math.abs(photo.hem / photo.seat - 2.0 / 1.3) < 0.01)
})
