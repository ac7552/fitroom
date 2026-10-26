// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { FILL, easeInOut, framing } from "../../app/javascript/lib/framing.js"

const fov = 22
const visibleAt = (distance) => 2 * distance * Math.tan((fov * Math.PI) / 360)

test("easeInOut starts and stops gently and is clamped", () => {
  assert.equal(easeInOut(0), 0)
  assert.equal(easeInOut(1), 1)
  assert.equal(easeInOut(0.5), 0.5)
  assert.equal(easeInOut(-1), 0)
  assert.equal(easeInOut(2), 1)
  assert.ok(easeInOut(0.1) < 0.1, "slow at the start")
  assert.ok(easeInOut(0.9) > 0.9, "slow at the end")
})

test("with nothing over the picture, the figure fills 78% of it on a wide screen, centred", () => {
  const height = 1.78
  const { distance, centreY, fill } = framing({ height, fov, pictureHeight: 800 })
  assert.equal(fill, FILL.wide)
  assert.ok(Math.abs(height / visibleAt(distance) - 0.78) < 1e-9)
  assert.ok(Math.abs(centreY - height / 2) < 1e-9)
})

test("a phone's narrow picture leaves a little more room round the figure", () => {
  const { fill } = framing({ height: 1.65, fov, pictureHeight: 700, narrow: true })
  assert.equal(fill, FILL.narrow)
})

test("things over the top and bottom move the figure between them, and shrink it only when they must", () => {
  const height = 1.78
  // Controls 110 px deep over the top, size rows 60 px over the bottom of a 700 px picture: the band is 530 px.
  const framed = framing({ height, fov, pictureHeight: 700, insets: { top: 110, bottom: 60 } })
  assert.ok(framed.fill < FILL.wide && framed.fill >= FILL.least, `fill ${framed.fill}`)
  // The figure's middle sits at the band's middle (110 + 265 = 375 px down, 25 px below the picture's centre).
  const visible = visibleAt(framed.distance)
  const perPixel = visible / 700
  assert.ok(Math.abs((framed.centreY - height / 2) - 25 * perPixel) < 1e-9)
  // And the figure stays inside the band.
  const figurePx = height / perPixel
  assert.ok(figurePx <= 530, `${figurePx} px in a 530 px band`)
  // A tall picture has room for the whole 78%.
  assert.equal(framing({ height, fov, pictureHeight: 860, insets: { top: 60, bottom: 50 } }).fill, FILL.wide)
})

test("the figure never shrinks below the least fill, however much is laid over the picture", () => {
  const { fill } = framing({ height: 1.78, fov, pictureHeight: 600, insets: { top: 300, bottom: 300 } })
  assert.equal(fill, FILL.least)
})
