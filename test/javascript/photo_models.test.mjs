// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import "./support/lib.mjs"

const { precisionFor, samPixels } = await import("lib/garments/photo_models")

const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225]

test("SAM's input is the picture's planes, scaled and normalised, in the top left of a padded square", () => {
  // A 3 by 2 picture, every pixel a different colour, padded to 4 by 4.
  const w = 3, h = 2, rgba = new Uint8ClampedArray(4 * w * h)
  for (let i = 0; i < w * h; i++) rgba.set([10 * i, 255 - 20 * i, 7 * i + 3, 255], 4 * i)
  const out = samPixels(rgba, w, h, { width: 4, height: 4 })
  assert.equal(out.length, 3 * 16)
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const got = out[c * 16 + y * 4 + x]
      // As the processor does it: rescale by 1/255, then (v - mean) / std; zeros where it's padded.
      const want = x < w && y < h ? (rgba[4 * (y * w + x) + c] / 255 - MEAN[c]) / STD[c] : 0
      assert.ok(Math.abs(got - want) < 1e-5, `channel ${c} at ${x},${y}: ${got} for ${want}`)
    }
  }
})

test("SAM's input takes the processor's own scale, mean and spread when it's given them", () => {
  const rgba = new Uint8ClampedArray([100, 150, 200, 255])
  const out = samPixels(rgba, 1, 1, { width: 1, height: 1 }, { mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5], scale: 1 / 255 })
  assert.deepEqual(Array.from(out, v => +v.toFixed(4)), [-0.2157, 0.1765, 0.5686])
})

test("half precision on a graphics card that has it, full on one that doesn't, 8 bits on the CPU", () => {
  assert.equal(precisionFor("sam", { device: "webgpu", f16: true }), "fp16")
  assert.equal(precisionFor("dino", { device: "webgpu", f16: true }), "fp16")
  assert.equal(precisionFor("sam", { device: "webgpu", f16: false }), "fp32")
  assert.equal(precisionFor("dino", { device: "wasm", f16: false }), "q8")
  // SAM's prompt decoder stays at full precision on the CPU: 8 bits moved its masks the most.
  assert.deepEqual(precisionFor("sam", { device: "wasm", f16: false }), { vision_encoder: "q8", prompt_encoder_mask_decoder: "fp32" })
})
