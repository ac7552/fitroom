// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import "./support/lib.mjs"

const { draftBottoms } = await import("lib/garments/pants")
const { draftTop } = await import("lib/garments/pattern")
const { buildCloth } = await import("lib/garments/cloth")
const { length } = await import("lib/garments/curves")

const man = { waist: 86.4, hips: 101, inseam: 81, height: 178, rise: 24 }
const edge = (pattern, panel, name) => pattern.panels[panel].edges.find(e => e.name === name).points

test("pants are cut to their chart: as round as it says at the waist, and as long", () => {
  const p = draftBottoms("trousers", { waist: 91, seat: 118, thigh: 72, inseam: 81, leg_opening: 50 }, man)
  const waist = ["front_L", "front_R", "back_L", "back_R"].reduce((sum, panel) => sum + length(edge(p, panel, "waist")), 0)
  assert.ok(Math.abs(waist - 91) < 1.5, `waist ${waist}`)
  const legLength = -Math.min(...edge(p, "front_L", "hem").map(q => q[1]))
  assert.ok(Math.abs(legLength - (p.measures.rise + 81)) < 0.01)
  // The back's crotch seam is the longer: it runs under the body and up over the seat.
  assert.ok(length(edge(p, "back_L", "crotch")) > length(edge(p, "front_L", "crotch")) + 3)
  // Every piece is drawn anticlockwise and every seam pairs up.
  const cloth = buildCloth(p, 2)
  assert.ok(cloth.sewing.length > 100)
})

test("each kind of pants has its own make, and a skirt is a front, a back and a band", () => {
  const sizes = { waist: 80, seat: 104, thigh: 62, inseam: 76, leg_opening: 26 }
  assert.ok(draftBottoms("joggers", sizes, man).panels.cuff_L, "joggers have cuffs")
  assert.equal(draftBottoms("jeans", sizes, man).fabric, "denim")
  assert.equal(draftBottoms("leggings", sizes, man).fabric, "stretch")
  const shorts = draftBottoms("shorts", { ...sizes, inseam: 18 }, man)
  assert.ok(shorts.measures.length < 50)
  const skirt = draftBottoms("skirt", { waist: 76, seat: 104, length: 74 }, { ...man, waist: 74, hips: 99 }, { fit: "flared" })
  assert.deepEqual(Object.keys(skirt.panels).sort(), ["back", "front", "waistband"])
  const hem = length(edge(skirt, "front", "hem")) * 2
  assert.ok(hem > 104 * 1.3, `an A-line flares: hem ${hem}`)
  buildCloth(skirt, 2)
})

test("polos, tank tops, sweaters and cardigans have their own patterns", () => {
  const body = { chest: 101.6, waist: 86.4, shoulders: 45.5, arm: 65.5, height: 178, neck: 40, armpit: 19 }
  const size = { chest: 110, shoulders: 48, sleeve: 22, length: 70 }
  assert.equal(draftTop("polo", size, body).closure, "placket")
  assert.ok(!Object.keys(draftTop("tank", size, body).panels).some(name => name.startsWith("sleeve")), "a tank has no sleeves")
  assert.ok(draftTop("sweater", { ...size, sleeve: 64 }, body).panels.waistband, "a sweater has a ribbed hem")
  assert.equal(draftTop("cardigan", { ...size, sleeve: 64 }, body).closure, "buttons")
})

test("a jogger's inseam runs to the bottom of its cuff, so the leg pieces stop where the cuff starts", () => {
  const sizes = { waist: 80, seat: 104, thigh: 62, inseam: 76, leg_opening: 26 }
  const joggers = draftBottoms("joggers", sizes, man)
  const trousers = draftBottoms("trousers", sizes, man)
  const legOf = p => -Math.min(...edge(p, "front_L", "hem").map(q => q[1])) - p.measures.rise
  assert.ok(Math.abs(legOf(trousers) - 76) < 0.01)
  assert.ok(Math.abs(legOf(joggers) + joggers.measures.cuff - 76) < 0.01, `leg ${legOf(joggers)} + cuff ${joggers.measures.cuff}`)
})

test("a sleeve is never cut narrower than the arm it goes on, at the underarm or the elbow", () => {
  // The women's example body with its arm measured off the mesh (body.js): the upper arm 23 cm round below
  // the armpit, the forearm 22 cm just under the elbow, 29.7 cm down.
  const body = { chest: 91.5, waist: 74, shoulders: 39.5, arm: 58, height: 165, neck: 27, armpit: 20.8, bicep: 22.3, upperArm: 23, forearm: 22, elbow: 29.7, wrist: 11.2 }
  const size = { chest: 86.36, shoulders: 38.1, sleeve: 65.72, length: 52.71 }
  const fitted = draftTop("hoodie", size, body, { fit: "fitted", stretch: true })
  const m = fitted.measures
  assert.ok(m.bicep >= 23 * 1.06, `bicep ${m.bicep}`)
  // Its hem (where the cuff is sewn on) is wide enough that the straight taper from the underarm still
  // clears the forearm at the elbow.
  const underarm = 20.8 - 4.4 + 1.5, elbow = 29.7 + 1.5
  const share = (elbow - underarm) / (m.sleeve - underarm)
  const atElbow = m.bicep * (1 - share) + m.opening * share
  assert.ok(atElbow >= 22 * 1.06 - 0.01, `at the elbow ${atElbow}`)
  assert.ok(m.opening < m.bicep, "it still tapers")
  // A thick arm in a fitted knit: the arm's real girth wins over the chart's share of the chest.
  const thick = draftTop("hoodie", size, { ...body, bicep: 30, upperArm: 34, forearm: 30 }, { fit: "fitted", stretch: true }).measures
  assert.ok(thick.bicep >= 34 * 1.06, `bicep ${thick.bicep}`)
  // A loose sleeve has more room still, and a body measured without the arm's girths drafts as before.
  const loose = draftTop("hoodie", size, body).measures
  assert.ok(loose.bicep >= 23 * 1.1 && loose.bicep > m.bicep)
  const plain = draftTop("hoodie", size, { chest: 91.5, waist: 74, shoulders: 39.5, arm: 58, height: 165 }).measures
  assert.ok(plain.bicep > 0 && plain.opening > 0)
})

test("a skirt sits where the body is as round as its waist, so it's laid on at its own size", async () => {
  const { riseFor } = await import("lib/garments/pants")
  // A body round in section: 100 cm round 8 cm above the crotch (the seat), narrowing to 68 cm 26 cm up (the
  // natural waist), and wider again above.
  const crotch = 0.8
  const girth = cm => cm <= 8 ? 92 + cm : cm <= 26 ? 100 - (32 * (cm - 8)) / 18 : 68 + (cm - 26) * 2
  const frame = { crotch, torso: { envelope: y => girth((y - crotch + 0.015) * 100) / 100 / (2 * Math.PI) } }
  const at = waist => riseFor(frame, 21, waist)
  // Where the body is 74 cm round, less the few millimetres it's laid off it.
  const rise = at(74)
  assert.ok(Math.abs(girth(rise) + 1.9 - 74) < 1.2, `a 74 cm waist sits at ${rise} cm, where the body is ${girth(rise).toFixed(1)} cm`)
  assert.ok(at(70) > rise, "a smaller waist sits higher")
  assert.equal(at(110), 8, "a waist bigger than the seat sits at the seat")
  assert.ok(Math.abs(at(60) - 26) <= 0.5, "one smaller than the natural waist sits at it")
  const skirt = draftBottoms("skirt", { waist: 74, seat: 104 }, { waist: 68, hips: 100, height: 165, rise: 21, riseFor: round => riseFor(frame, 21, round) }, { fit: "slim" })
  assert.equal(skirt.measures.rise, rise, "the skirt is drafted from there")
})

test("a chart's long rise doesn't lift jeans' waist up the ribs", () => {
  // Kith's Twisted Seam Jeans, size 32: a 31 cm (12.25 in) front rise, on a man whose rise to his natural
  // waist is 24 cm. Their 87.6 cm waist sits a little below it (he's 86.4 round there).
  const jeans = draftBottoms("jeans", { waist: 87.63, seat: 108.6, rise: 31.12, inseam: 76.2, leg_opening: 42.6 }, man)
  const sitAt = 1 - 0.65 * (87.63 - 86.4) / (101 - 86.4)
  assert.ok(Math.abs(jeans.measures.rise - (24 * sitAt - 2 + 2)) < 0.01, `rise ${jeans.measures.rise}`)
  // A low rise still sits low.
  assert.equal(draftBottoms("jeans", { waist: 87.63, seat: 108.6, rise: 22, inseam: 76.2 }, man).measures.rise, 22 * 0.9)
})
