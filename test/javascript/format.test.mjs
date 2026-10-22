// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { formatLength, toCm } from "../../app/javascript/lib/format.js"

test("inches read like a tape measure", () => {
  assert.equal(formatLength(2.54 * 1.75, "in"), "1¾ in")
  assert.equal(formatLength(0.6, "in"), "¼ in")
  assert.equal(formatLength(-2.54 * 2, "in"), "2 in")
})

test("centimetres round to the nearest half", () => {
  assert.equal(formatLength(3.3, "cm"), "3.5 cm")
})

test("toCm converts inches only", () => {
  assert.equal(toCm(10, "in"), 25.4)
  assert.equal(toCm(10, "cm"), 10)
})
