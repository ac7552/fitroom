// Run with: node --test test/javascript/*.test.mjs
import "./support/lib.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"

const { chartFromSizes, diagram, filled, nextSizeName, partsFor, sizesFromChart, sliderRange, startingSizes } = await import("lib/size_editor")

test("a new garment starts with a tab per usual size, and + adds the next one", () => {
  assert.deepEqual(startingSizes("top").map(s => s.name), ["XS", "S", "M", "L", "XL"])
  assert.deepEqual(startingSizes("trousers").map(s => s.name), ["28", "30", "32", "34", "36"])
  assert.equal(nextSizeName(startingSizes("top")), "XXL")
  assert.equal(nextSizeName(startingSizes("trousers")), "38")
  assert.equal(nextSizeName([{ name: "40R" }]), "Size 2")
  assert.deepEqual(partsFor("coat").map(p => p.part), ["chest", "waist", "shoulders", "sleeve", "length"])
  assert.deepEqual(partsFor("trousers").map(p => p.part), ["waist", "seat", "thigh", "inseam", "leg_opening"])
})

test("a pasted chart makes one tab per row, says what it didn't use, and a size alone makes one tab", () => {
  const chart = { kind: "garment", unused: ["Hem", "Rise"], sizes: [
    { name: "S", chest: 100, waist: 92, shoulders: 44, sleeve: 63, length: 70, hem: 98 },
    { name: "M", chest: 106, waist: 98, shoulders: 46, sleeve: 64, length: 72 }
  ] }
  const { sizes, note } = sizesFromChart(chart, "top")
  assert.deepEqual(sizes.map(s => s.name), ["S", "M"])
  assert.deepEqual(sizes[1].cm, { chest: 106, waist: 98, shoulders: 46, sleeve: 64, length: 72 })
  assert.equal(note, "2 sizes from the chart. Check them, then add it. Didn't use: Hem, Rise.")
  const one = sizesFromChart({ kind: "sizes", sizes: [{ name: "M", chest: 104, shoulders: 46, sleeve: 63, length: 71, waist: null }] }, "top")
  assert.equal(one.sizes.length, 1)
  assert.match(one.note, /^1 size from the chart \(the usual measurements for that size\)/)
  assert.ok(filled(one.sizes[0]))
  assert.ok(!filled({ name: "L", cm: {} }))
})

test("a size's slider runs from the size before it to the size after it, so a typo stands out", () => {
  const sizes = [{ name: "S", cm: { chest: 100 } }, { name: "M", cm: {} }, { name: "L", cm: { chest: 112 } }]
  const [lo, hi] = sliderRange(sizes, 1, "chest", [80, 150])
  assert.ok(lo < 100 && lo > 90 && hi > 112 && hi < 120)
  // One neighbour: a span round it. None: the part's usual range.
  const [a, b] = sliderRange([{ name: "S", cm: { chest: 100 } }, { name: "M", cm: {} }], 1, "chest", [80, 150])
  assert.deepEqual([a, b], [85, 115])
  assert.deepEqual(sliderRange([{ name: "M", cm: {} }], 0, "chest", [80, 150]), [80, 150])
})

test("the garment's chart is every size with its main number in, doubled when measured flat", () => {
  const sizes = [{ name: "S", cm: { chest: 50, length: 70 } }, { name: "M", cm: { length: 72 } }, { name: " ", cm: { chest: 53 } }]
  const chart = chartFromSizes(sizes, "top", true)
  assert.deepEqual(chart.sizes.map(s => s.name), ["S", "Size 2"])
  assert.equal(chart.sizes[0].chest, 100)
  assert.equal(chart.sizes[0].length, 70)
  assert.deepEqual(chart.missing, ["waist", "shoulders", "sleeve"])
  assert.equal(chartFromSizes(sizes, "top", false).sizes[0].chest, 50)
})

test("the drawing marks the measurement being typed", () => {
  const svg = diagram("trousers", "inseam")
  assert.match(svg, /class="measure is-on" data-part="inseam"/)
  assert.equal((svg.match(/is-on/g) ?? []).length, 1)
  assert.match(diagram("coat", "chest"), /Where to measure the coat/)
})
