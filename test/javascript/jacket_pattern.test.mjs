// Run with: node --test test/javascript/*.test.mjs
import "./support/lib.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"

const { draftTop } = await import("lib/garments/pattern")

const body = { chest: 101.6, waist: 86.4, shoulders: 45.5, arm: 65.5, height: 178, neck: 40, armpit: 19 }
const size = { chest: 124, shoulders: 52, sleeve: 64, length: 72 }

test("a jacket with a hood (a parka, a hooded puffer) is drafted with the hood in place of its collar", () => {
  const plain = draftTop("zip", size, body, { fit: "oversized" })
  assert.ok(plain.panels.collar && !plain.panels.hood_L)
  const hooded = draftTop("zip", size, body, { fit: "oversized", hood: true })
  assert.ok(hooded.panels.hood_L && hooded.panels.hood_R && !hooded.panels.collar)
  assert.equal(hooded.closure, "zip")
  assert.ok(hooded.seams.some(([a, , b]) => a === "hood_L" && b === "hood_R"), "the halves sewn at the crown")
  // A coat too; a dress's cut never has one.
  assert.ok(draftTop("coat", size, body, { hood: true }).panels.hood_L)
})

test("a half-zip pullover has a stand collar and a short zip", () => {
  const top = draftTop("sweatshirt", { chest: 116, shoulders: 50, sleeve: 62, length: 70 }, body, { half_zip: true })
  assert.equal(top.closure, "halfzip")
  assert.ok(top.panels.collar, "a collar")
  assert.equal(draftTop("sweatshirt", { chest: 116, shoulders: 50, sleeve: 62, length: 70 }, body, null).closure, null)
})
