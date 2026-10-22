// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { drawnSize, fitBody, fitJacket, fitTrousers } from "../../app/javascript/lib/body_fit.js"

const calibration = JSON.parse(readFileSync(new URL("../../public/models/mannequin.json", import.meta.url)))

// Predicts what the fitted body measures, from the calibration, to check the solver.
function predicted(fit, measure) {
  let value = calibration.body[measure]
  for (const [key, weight] of Object.entries(fit.influences)) value += weight * (calibration.targets[key].body[measure] ?? 0)
  return value * fit.scale
}

test("the base body needs no shape keys", () => {
  const fit = fitBody(calibration, calibration.body)
  assert.equal(fit.scale, 1)
  for (const weight of Object.values(fit.influences)) assert.ok(Math.abs(weight) < 1e-6)
})

test("matches a 40R build within half a centimetre", () => {
  const body = { chest: 101.6, waist: 86.4, shoulders: 45.5, arm: 65.5, height: 178 }
  const fit = fitBody(calibration, body)
  for (const measure of ["chest", "waist", "shoulders", "arm"]) {
    assert.ok(Math.abs(predicted(fit, measure) - body[measure]) < 0.5, `${measure}: ${predicted(fit, measure)}`)
  }
})

test("a size that matches the modelled jacket needs no ease", () => {
  const fit = fitBody(calibration, calibration.body)
  const ease = fitJacket(calibration, fit, { ...calibration.jacket })
  for (const weight of Object.values(ease)) assert.ok(Math.abs(weight) < 1e-6)
})

test("a bigger chest on the chart grows the jacket's chest", () => {
  const fit = fitBody(calibration, calibration.body)
  const ease = fitJacket(calibration, fit, { ...calibration.jacket, chest: calibration.jacket.chest + 5, length: null })
  assert.ok(ease["ease-chest"] > 4)
  assert.equal(ease["ease-length"], 0)
})

test("matches hips and inseam when given", () => {
  const body = { chest: 101.6, waist: 86.4, shoulders: 45.5, arm: 65.5, height: 178, hips: 102, inseam: 81 }
  const fit = fitBody(calibration, body)
  for (const measure of ["hips", "inseam"]) {
    assert.ok(Math.abs(predicted(fit, measure) - body[measure]) < 0.6, `${measure}: ${predicted(fit, measure)}`)
  }
})

test("says which measurements are beyond what the model can show", () => {
  const fit = fitBody(calibration, { chest: 101.6, waist: 86.4, shoulders: 63.5, arm: 65.5, height: 178 })
  assert.deepEqual(fit.limited, ["shoulders"])
})

test("a jacket never shrinks inside the body", () => {
  const fit = fitBody(calibration, calibration.body)
  const ease = fitJacket(calibration, fit, { ...calibration.jacket, chest: 60 })
  const drawn = calibration.jacket.chest + ease["ease-chest"] * calibration.ease_check["ease-chest"].chest
  assert.ok(drawn >= calibration.body.chest + 2.9)
})

test("trousers ease follows the chart", () => {
  const fit = fitBody(calibration, { ...calibration.body })
  const ease = fitTrousers(calibration, fit, { ...calibration.trousers, inseam: calibration.trousers.inseam + 4 })
  assert.ok(Math.abs(ease["ease-inseam"] - 4) < 0.01)
  assert.ok(Math.abs(ease["ease-seat"]) < 1e-6)
})

test("a casual jacket is cut to its chart's length, or a usual one when the chart has none", () => {
  const fit = fitBody(calibration, calibration.body)
  const listed = drawnSize(calibration, fit, fitJacket(calibration, fit, { chest: 112, length: 68 }, { layer: "casual" }), "casual")
  const unlisted = drawnSize(calibration, fit, fitJacket(calibration, fit, { chest: 112 }, { layer: "casual" }), "casual")
  assert.ok(Math.abs(listed.length - 68) < 0.5, `listed: ${listed.length}`)
  assert.ok(unlisted.length > 60 && unlisted.length < 70, `unlisted: ${unlisted.length}`)
})

test("a casual jacket keeps room at the waist, since it hangs straight from the chest", () => {
  const fit = fitBody(calibration, calibration.body)
  const drawn = drawnSize(calibration, fit, fitJacket(calibration, fit, { chest: 112, waist: 80 }, { layer: "casual" }), "casual")
  assert.ok(drawn.waist >= calibration.body.waist + 5.9, `waist: ${drawn.waist}`)
})

test("a coat is drawn outside the jacket under it", () => {
  const fit = fitBody(calibration, calibration.body)
  const jacket = drawnSize(calibration, fit, fitJacket(calibration, fit, { chest: 115, waist: 112 }, { layer: "casual" }), "casual")
  const coat = drawnSize(calibration, fit, fitJacket(calibration, fit, { chest: 110, waist: 100, length: 100 }, { over: jacket }))
  // At least a centimetre round (lengthening a coat takes a little off its waist); the page also stands a
  // coat out a little further over a jacket.
  for (const part of ["chest", "waist"]) assert.ok(coat[part] >= jacket[part] + 1, `${part}: ${coat[part]} over ${jacket[part]}`)
})
