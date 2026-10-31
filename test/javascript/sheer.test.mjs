import { test } from "node:test"
import assert from "node:assert/strict"
import "./support/lib.mjs"

const { sheerShow } = await import("lib/garments/sheer")

test("a sheer cloth shows the body as much as its word says, whatever its colour", () => {
  // Semi-sheer charcoal: nearly opaque (a fixed 0.9 made it look see-through over the pale mannequin).
  assert.ok(sheerShow("#2e2e30", "semi", false) >= 0.98)
  // The same word lets more through a paler cloth: the body changes it less.
  assert.ok(sheerShow("#c8b8a8", "semi", false) < sheerShow("#2e2e30", "semi", false))
  // Sheer lets more through than semi-sheer, and a printed sheer no more than a plain one.
  for (const color of ["#2e2e30", "#7a3040", "#c8b8a8"]) {
    assert.ok(sheerShow(color, "sheer", false) <= sheerShow(color, "sheer", true))
    assert.ok(sheerShow(color, "sheer", true) < sheerShow(color, "semi", false))
  }
  // Never wholly see-through, never wholly solid.
  assert.ok(sheerShow("#ffffff", "sheer", false) >= 0.55 && sheerShow("#000000", "semi", false) <= 0.99)
  assert.equal(sheerShow("not a colour", "semi", false), sheerShow("#808080", "semi", false))
})
