// Run with: node --test test/javascript/*.test.mjs
import "./support/lib.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"

const { draftTop, necklineOf, necked, STYLES } = await import("lib/garments/pattern")
const { garmentRows } = await import("lib/garments/print")

const body = { chest: 100, waist: 86, shoulders: 46, arm: 62, height: 180, neck: 39, armpit: 20, bicep: 32, wrist: 17 }
const size = { name: "M", chest: 112, length: 70 }
const neckDepth = pattern => Math.max(...pattern.panels.front.edges.find(e => e.name === "neck_L").points.map(p => -p[1]))
const collarHeight = pattern => { const ys = pattern.panels.collar.edges.flatMap(e => e.points.map(p => p[1])); return Math.max(...ys) - Math.min(...ys) }

test("a listing's neckline by its name, then by its description when that names one", () => {
  assert.equal(necklineOf({ name: "Cashmere Crewneck Sweater" }), "crew")
  assert.equal(necklineOf({ name: "Ribbed Mock Neck Sweater" }), "mock")
  assert.equal(necklineOf({ name: "Merino Turtleneck - Black" }), "turtle")
  assert.equal(necklineOf({ name: "Knit V-Neck Pullover" }), "v")
  assert.equal(necklineOf({ name: "Striped Boat Neck Tee" }), "boat")
  assert.equal(necklineOf({ name: "Pima Tee", description: "<p>Scoop neckline. Relaxed fit.</p>" }), "scoop")
  // Two named in the description (its own and another piece's): it doesn't say.
  assert.equal(necklineOf({ name: "Wool Sweater", description: "Crewneck. Layer it over a mock neck." }), null)
  assert.equal(necklineOf({ name: "Polo Shirt" }), null)
})

test("a sweater is drafted with a crew's low rib unless it's called a mock or turtle neck", () => {
  const crew = draftTop("sweater", size, body)
  assert.ok(collarHeight(crew) < 3.5, `crew rib ${collarHeight(crew)}`)
  const mock = draftTop("sweater", size, body, { neck: "mock" })
  assert.ok(collarHeight(mock) > 5, `mock ${collarHeight(mock)}`)
  const turtle = draftTop("sweater", size, body, { neck: "turtle" })
  assert.ok(collarHeight(turtle) > collarHeight(mock))
})

test("a V-neck comes down straight to its point, deeper than a crew", () => {
  const crew = draftTop("tee", size, body, { neck: "crew" })
  const v = draftTop("tee", size, body, { neck: "v" })
  assert.ok(neckDepth(v) > neckDepth(crew) + 5, `${neckDepth(v)} vs ${neckDepth(crew)}`)
  // Straight: the neckline's middle point lies on the line from the high point to the point.
  const pts = v.panels.front.edges.find(e => e.name === "neck_L").points
  const [a, b] = [pts[0], pts[pts.length - 1]], m = pts[pts.length >> 1]
  const off = Math.abs((b[0] - a[0]) * (m[1] - a[1]) - (b[1] - a[1]) * (m[0] - a[0])) / Math.hypot(b[0] - a[0], b[1] - a[1])
  assert.ok(off < 0.5, `off the line by ${off}`)
})

test("a named neckline never replaces a hood, a shirt's or a polo's collar", () => {
  for (const name of ["hoodie", "shirt", "polo"]) assert.equal(necked(STYLES[name], "crew"), STYLES[name])
})

test("a hood is found over sloping shoulders, which widen out from its neck to the shoulder line", () => {
  // A hood 40 wide standing over a body 120 wide, its neck pinched to 30, then shoulders sloping out.
  const w = 200, h = 240, mask = new Uint8Array(w * h)
  const fill = (y, half) => { for (let x = Math.round(100 - half); x <= Math.round(100 + half); x++) mask[y * w + x] = 1 }
  for (let y = 10; y < 40; y++) fill(y, 6 + (y - 10) * 0.5)          // the crown, widening
  for (let y = 40; y < 60; y++) fill(y, 20 - (y - 40) * 0.25)        // narrowing to the neck
  for (let y = 60; y < 80; y++) fill(y, 15 + (y - 60) * 2.2)         // the shoulders sloping out
  for (let y = 80; y < 220; y++) fill(y, 60)                         // the body
  const rows = garmentRows(mask, w, h, { hood: true })
  assert.ok(rows.hood, "hood found")
  assert.ok(rows.top >= 55 && rows.top <= 75, `shoulders at ${rows.top}`)
})

test("a hood that falls straight to the shoulders, no neck to it, is found too, and a T-shirt's collar isn't one", () => {
  const w = 200, h = 300
  const shaped = rowsOf => { const mask = new Uint8Array(w * h); for (let y = 0; y < h; y++) { const half = rowsOf(y); if (half > 0) for (let x = Math.round(100 - half); x <= Math.round(100 + half); x++) mask[y * w + x] = 1 } return mask }
  // A crown widening to 54 across, its sides straight down, then the shoulders leaping out (raglan).
  const raglan = shaped(y => y < 10 ? 0 : y < 40 ? 8 + (y - 10) * 0.65 : y < 85 ? 27 : y < 95 ? 27 + (y - 85) * 5 : y < 280 ? 77 + Math.min(20, (y - 95) * 0.2) : 0)
  const rows = garmentRows(raglan, w, h, { hood: true })
  assert.ok(rows.hood, "hood found")
  assert.ok(rows.top >= 82 && rows.top <= 96, `shoulders at ${rows.top}`)
  // A T-shirt laid flat: its collar's rim, shoulders sloping out, sleeves out to the side, the body.
  const tee = shaped(y => y < 20 ? 0 : y < 28 ? 22 : y < 40 ? 22 + (y - 28) * 2.5 : y < 90 ? 92 : y < 270 ? 62 : 0)
  assert.equal(garmentRows(tee, w, h, { hood: true }).hood, null)
})
