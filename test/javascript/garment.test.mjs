// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { guessGarment } from "../../app/javascript/lib/garments/print.js"

// A made-up photo: dark cloth (shapes given as tests on x and y) on a light grey background.
function drawn(...shapes) { return drawnIn(240, ...shapes) }
function drawnIn(h, ...shapes) {
  const w = 200, data = new Uint8ClampedArray(4 * w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = [236, 236, 236]
      for (const [inside, colour = [40, 44, 52]] of shapes) if (inside(x, y)) c = colour
      data.set([...c, 255], 4 * (y * w + x))
    }
  }
  return guessGarment(data, w, h)
}
// About as long as it is wide, as a shirt is (a dress is far longer).
const torso = [(x, y) => x > 60 && x < 140 && y > 40 && y < 150]
const shortSleeves = [(x, y) => y > 40 && y < 80 && x > 30 && x < 170]
// Long sleeves hang down beside the body, a little apart from it.
const longSleeves = [(x, y) => (y > 40 && y < 60 && x > 40 && x < 160) || (y >= 60 && y < 145 && ((x > 40 && x < 56) || (x > 144 && x < 160)))]

test("a T-shirt: short sleeves", () => {
  assert.deepEqual(drawn(torso, shortSleeves), { kind: "top", style: "tee" })
})

test("long sleeves, and a hem as wide as the body: a long-sleeve top", () => {
  assert.deepEqual(drawn(torso, longSleeves), { kind: "top", style: "longsleeve" })
})

test("long sleeves and a gathered hem: a sweatshirt", () => {
  const ribbed = [(x, y) => x > 60 && x < 140 && y > 40 && y < 142 || (x > 66 && x < 134 && y >= 142 && y < 150)]
  assert.deepEqual(drawn(ribbed, longSleeves), { kind: "top", style: "sweatshirt" })
})

test("a hood above the shoulders: a hoodie", () => {
  const hood = [(x, y) => x > 78 && x < 122 && y > 8 && y <= 40]
  assert.deepEqual(drawn(torso, longSleeves, hood), { kind: "top", style: "hoodie" })
})

test("a line down the middle of the front: a jacket", () => {
  const zip = [(x, y) => x >= 99 && x <= 101 && y > 42 && y < 150, [200, 200, 205]]
  assert.deepEqual(drawn(torso, longSleeves, zip), { kind: "jacket", style: "zip" })
})

test("two legs below a waistband: pants", () => {
  const pants = [(x, y) => (y > 20 && y < 80 && x > 60 && x < 140) || (y >= 80 && y < 225 && ((x > 60 && x < 96) || (x > 104 && x < 140)))]
  assert.deepEqual(drawn(pants), { kind: "trousers", style: null })
})

test("far longer than it is wide: a dress, with long sleeves when they reach past the waist", () => {
  const dress = [(x, y) => x > 70 && x < 130 && y > 40 && y < 380 && Math.abs(x - 100) < 30 + (y - 40) * 0.04]
  assert.deepEqual(drawnIn(400, dress, [(x, y) => y > 40 && y < 70 && x > 45 && x < 155]), { kind: "top", style: "dress" })
  const long = [(x, y) => (y > 40 && y < 60 && x > 50 && x < 150) || (y >= 60 && y < 190 && ((x > 50 && x < 64) || (x > 136 && x < 150)))]
  assert.deepEqual(drawnIn(400, dress, long), { kind: "top", style: "dress_long" })
})
