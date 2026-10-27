// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { BORDER, DEPTH_BIAS, FACING, LIGHT, facingWeight, insideWeight, linearDepth, meanRatio, ndcToUv, pictureAlbedo, pictureWeight, projectPoint, tintWeight, unoccludedWeight } from "../../app/javascript/lib/projection.js"

// A perspective projection (as THREE.PerspectiveCamera makes it, column major) looking down -z from the origin.
function perspective(fovDeg, aspect, near, far) {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360)
  const m = new Array(16).fill(0)
  m[0] = f / aspect
  m[5] = f
  m[10] = -(far + near) / (far - near)
  m[11] = -1
  m[14] = (-2 * far * near) / (far - near)
  return m
}
const near = 1, far = 5
const vp = perspective(90, 1, near, far)   // the camera at the origin: view is the identity

test("a point straight ahead lands in the middle of the picture, at the depth a depth buffer stores", () => {
  const { uv, depth, inFront } = projectPoint(vp, [0, 0, -2])
  assert.ok(inFront)
  assert.ok(Math.abs(uv[0] - 0.5) < 1e-9 && Math.abs(uv[1] - 0.5) < 1e-9)
  // Back from the stored depth to the distance it came from.
  assert.ok(Math.abs(linearDepth(depth, near, far) - 2) < 1e-9)
  assert.ok(Math.abs(linearDepth(0, near, far) - near) < 1e-9)
  assert.ok(Math.abs(linearDepth(1, near, far) - far) < 1e-9)
})

test("up and to the right in the world is up and to the right in the picture, read from the bottom left", () => {
  // With a 90 degree view, a point as far right as it is deep sits on the picture's right edge.
  const { uv } = projectPoint(vp, [2, 1, -2])
  assert.ok(Math.abs(uv[0] - 1) < 1e-9)
  assert.ok(Math.abs(uv[1] - 0.75) < 1e-9)
  assert.deepEqual(ndcToUv([-1, -1]), [0, 0])
  assert.deepEqual(ndcToUv([1, 1]), [1, 1])
})

test("a point behind the camera gets no picture", () => {
  assert.equal(projectPoint(vp, [0, 0, 2]).inFront, false)
})

test("facing: nothing edge-on or facing away, all when square to the camera, smooth between", () => {
  assert.equal(facingWeight(-1), 0)
  assert.equal(facingWeight(0), 0)
  assert.equal(facingWeight(FACING.from), 0)
  assert.equal(facingWeight(FACING.to), 1)
  assert.equal(facingWeight(1), 1)
  const mid = facingWeight((FACING.from + FACING.to) / 2)
  assert.ok(mid > 0.45 && mid < 0.55)
  // The fallback's tint reaches further round than the picture, so there's no line where it stops.
  assert.equal(tintWeight(FACING.from), 1)
  assert.ok(tintWeight(0) > 0 && tintWeight(0) < 1)
  assert.equal(tintWeight(-0.2), 0)
})

test("inside: full well inside the picture, fading out over the border at every edge", () => {
  assert.equal(insideWeight([0.5, 0.5]), 1)
  assert.equal(insideWeight([0, 0.5]), 0)
  assert.equal(insideWeight([0.5, 1]), 0)
  assert.equal(insideWeight([BORDER, 0.5]), 1)
  const edge = insideWeight([BORDER / 2, 0.5])
  assert.ok(edge > 0 && edge < 1)
  assert.equal(insideWeight([1.2, 0.5]), 0)
})

test("occlusion: a point the camera saw is in view, one behind something nearer isn't, with a soft bias", () => {
  assert.equal(unoccludedWeight(2, 2), 1)
  assert.equal(unoccludedWeight(2 + DEPTH_BIAS, 2), 1, "within the bias (a cloth drawn a hair off its surface)")
  assert.equal(unoccludedWeight(2 + 3 * DEPTH_BIAS, 2), 0, "a sleeve lying in front of the torso")
  assert.equal(unoccludedWeight(1.5, 2), 1, "nearer than what was stored can't be hidden by it")
  assert.equal(pictureWeight({ facing: 1, inside: 1, unoccluded: 0 }), 0)
  assert.equal(pictureWeight({ facing: 0.5, inside: 1, unoccluded: 1 }), 0.5)
  assert.equal(pictureWeight({ facing: 1, inside: 1, unoccluded: 1, on: 0 }), 0)
})

test("the picture's colour shift against the page's photo is read over the figure only", () => {
  // Four pixels: two on the figure (the mask), two off it. The AI painted the figure half as bright and redder.
  const page = new Uint8Array([200, 200, 200, 255, 100, 100, 100, 255, 50, 50, 50, 255, 0, 0, 0, 255])
  const ai = new Uint8Array([120, 100, 100, 255, 60, 50, 50, 255, 255, 255, 255, 255, 255, 255, 255, 255])
  const mask = new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255])
  const [r, g, b] = meanRatio(ai, page, mask)
  assert.ok(Math.abs(r - 180 / 300) < 0.01 && Math.abs(g - 0.5) < 0.01 && Math.abs(b - 0.5) < 0.01)
  // Without a mask, everything counts, and the ratio is kept within reason.
  const all = meanRatio(ai, page, null)
  assert.ok(all.every(v => v >= 0.5 && v <= 2))
  assert.deepEqual(meanRatio(ai, page, new Uint8Array(16)), [1, 1, 1], "no figure: no shift")
})

test("the page's light comes out of the picture: the page's own photo gives back the cloth, the AI's colour stays", () => {
  const albedo = [0.4, 0.3, 0.2], light = 0.7
  const page = albedo.map(c => c * light)
  const same = pictureAlbedo(page, page, albedo)
  same.forEach((v, c) => assert.ok(Math.abs(v - albedo[c]) < 1e-9))
  // Magenta painted where the page's light is 0.7: the cloth is the magenta, unlit.
  const ai = pictureAlbedo([0.7, 0, 0.35], page, albedo)
  assert.ok(Math.abs(ai[0] - 1) < 1e-9 && ai[1] === 0 && Math.abs(ai[2] - 0.5) < 1e-9)
  // Light over dark cloth (a channel near black): read from the brightness, not blown up by the dark channel.
  const dark = [0.05, 0.05, 0.001]
  const out = pictureAlbedo([0.3, 0.3, 0.3], dark.map(c => c * 0.5), dark)
  out.forEach(v => assert.ok(Math.abs(v - 0.6) < 0.01, "grey over the page's light of 0.5, in every channel"))
  // The light is kept within reason: deep shadow can't make a pale picture glow.
  assert.equal(pictureAlbedo([0.9, 0.9, 0.9], [0.001, 0.001, 0.001], [0.5, 0.5, 0.5])[0], 1)
  assert.ok(LIGHT.min > 0 && LIGHT.max > 1)
})
