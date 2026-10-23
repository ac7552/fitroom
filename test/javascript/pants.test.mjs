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
