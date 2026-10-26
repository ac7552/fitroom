// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { cornerColor, deltaE, knockoutWhite, toLab } from "../../app/javascript/lib/garments/knockout.js"

// A little picture: a `ground` background with a `fill` box in the middle (and, if asked, a `spot` inside it).
function picture({ width = 24, height = 24, ground = [250, 250, 250], fill = [40, 90, 60], spot = null } = {}) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inBox = x >= 6 && x < width - 6 && y >= 4 && y < height - 4
      const inSpot = spot && x >= 10 && x < width - 10 && y >= 9 && y < height - 9
      const c = inSpot ? spot : inBox ? fill : ground
      data.set([...c, 255], 4 * (y * width + x))
    }
  }
  return { width, height, data }
}
const alphaAt = (image, x, y) => image.data[4 * (y * image.width + x) + 3]

test("toLab and deltaE: white is far from green and near off-white", () => {
  const white = toLab(255, 255, 255)
  assert.ok(Math.abs(white[0] - 100) < 0.5)
  assert.ok(deltaE(white, toLab(40, 90, 60)) > 50)
  assert.ok(deltaE(white, toLab(248, 247, 244)) < 5)
})

test("the corner colour is the backdrop's", () => {
  const { rgb } = cornerColor(picture({ ground: [240, 238, 235] }))
  assert.deepEqual(rgb.map(Math.round), [240, 238, 235])
})

test("a white backdrop goes clear and the garment stays, with a soft edge", () => {
  const source = picture()
  const out = knockoutWhite(source, { tolerance: 10, feather: 2 })
  assert.equal(out.width, 24)
  assert.equal(alphaAt(out, 0, 0), 0, "corner clear")
  assert.equal(alphaAt(out, 2, 12), 0, "backdrop beside the box clear")
  assert.equal(alphaAt(out, 12, 12), 255, "the middle of the garment is solid")
  const edge = alphaAt(out, 6, 12)
  assert.ok(edge > 0 && edge < 255, `the box's edge pixel is soft (${edge})`)
  assert.ok(alphaAt(out, 9, 12) === 255, "two pixels in, it's solid again")
  // The input wasn't touched.
  assert.equal(alphaAt(source, 0, 0), 255)
})

test("backdrop noise within the tolerance goes too; a different colour doesn't", () => {
  const noisy = picture({ ground: [250, 250, 250] })
  // A speckle of slightly darker off-white in the backdrop.
  noisy.data.set([242, 241, 238, 255], 4 * (2 * 24 + 2))
  assert.equal(alphaAt(knockoutWhite(noisy), 2, 2), 0)
  const tinted = picture({ ground: [250, 250, 250] })
  tinted.data.set([200, 220, 250, 255], 4 * (2 * 24 + 2))   // a pale blue speck
  assert.equal(alphaAt(knockoutWhite(tinted, { feather: 0 }), 2, 2), 255)
})

test("a white print inside the garment stays: only backdrop touching the edge goes", () => {
  const out = knockoutWhite(picture({ spot: [250, 250, 250] }), { feather: 0 })
  assert.equal(alphaAt(out, 12, 12), 255, "the white spot in the middle is kept")
  assert.equal(alphaAt(out, 1, 1), 0)
})

test("a photo on a dark ground is left whole", () => {
  const out = knockoutWhite(picture({ ground: [30, 30, 32] }))
  assert.equal(alphaAt(out, 0, 0), 255)
})
