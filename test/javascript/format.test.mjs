// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { formatAbout, formatLength, toCm } from "../../app/javascript/lib/format.js"

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

test("rough amounts are in plain words, to the nearest half inch or whole centimetre", () => {
  assert.equal(formatAbout(0.3, "in"), "about ½ inch")
  assert.equal(formatAbout(2.54, "in"), "about 1 inch")
  assert.equal(formatAbout(-2.54 * 1.6, "in"), "about 1½ inches")
  assert.equal(formatAbout(2.54 * 3, "in"), "about 3 inches")
  assert.equal(formatAbout(3.4, "cm"), "about 3 cm")
  assert.equal(formatAbout(0.2, "cm"), "about 1 cm")
})
