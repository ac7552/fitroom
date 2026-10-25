// Cleaning a store photo before it's read: a segmentation model (SlimSAM, Apache-2.0, run in the browser
// with Transformers.js) is pointed at the garment, and what isn't part of it (a model's hand or arm, a bag,
// a hanger, a prop) is painted out in the backdrop's colour. Shop photos taken on a person, or with a hand
// in a pocket, would otherwise put those in the garment's colour, its print or its photo on the cloth.
//
// The model and its library load from a public CDN the first time a photo is cleaned (about 15 MB, cached
// by the browser after that). The photo itself never leaves the page. Anything that goes wrong (no
// network, an old browser, a mask that doesn't look like the garment) leaves the photo as it was.

import { keepInside, paintOut, pickMask, promptPoints } from "lib/garments/print"

const LIBRARY = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1"
const MODEL = "Xenova/slimsam-77-uniform"
const SIZE = 640    // the photo is segmented at about this many pixels across
const FULL = 1600   // and painted out at up to this many

let loading = null
function load() {
  loading ??= (async () => {
    const t = await import(/* webpackIgnore: true */ LIBRARY)
    t.env.allowLocalModels = false
    // On the CPU (WebAssembly): this model's masks come back wrong on WebGPU in this library's version (all
    // of the picture, or none of it). A photo takes about five seconds.
    const model = await t.SamModel.from_pretrained(MODEL, { dtype: "q8", device: "wasm" })
    const processor = await t.AutoProcessor.from_pretrained(MODEL)
    return { t, model, processor }
  })().catch(error => { loading = null; throw error })
  return loading
}

// src: the photo (a data: URL). kind: "top" or "trousers" (where to point). Returns a data: URL of the
// cleaned photo, or src when there's nothing to clean or it can't be done in `timeout` ms.
export async function cleanPhoto(src, kind = "top", { timeout = 25000 } = {}) {
  try {
    return await Promise.race([clean(src, kind), new Promise(resolve => setTimeout(() => resolve(src), timeout))])
  } catch {
    return src
  }
}

async function clean(src, kind) {
  const image = new Image()
  image.src = src
  await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject })
  const scale = Math.min(1, SIZE / Math.max(image.naturalWidth, image.naturalHeight))
  const w = Math.round(image.naturalWidth * scale), h = Math.round(image.naturalHeight * scale)
  const canvas = document.createElement("canvas")
  canvas.width = w
  canvas.height = h
  const context = canvas.getContext("2d", { willReadFrequently: true })
  context.drawImage(image, 0, 0, w, h)
  const pixels = context.getImageData(0, 0, w, h)
  const prompt = promptPoints(pixels.data, w, h, kind)
  if (!prompt) return src

  const { t, model, processor } = await load()
  const raw = new t.RawImage(new Uint8ClampedArray(pixels.data), w, h, 4).rgb()
  const inputs = await processor(raw, { input_points: [[prompt.points]], input_labels: [[prompt.points.map(() => 1)]] })
  const outputs = await model(inputs)
  const masks = await processor.post_process_masks(outputs.pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes)
  const scores = outputs.iou_scores.data
  const all = masks[0]   // [1, 3, h, w]
  const count = all.dims[1], plane = w * h, bits = all.data

  const best = pickMask(bits, count, plane, prompt.mask, scores)
  if (best < 0) return src
  // Grown by a couple of pixels, so the garment's own edge isn't shaved off.
  const keep = new Uint8Array(plane)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bits[best * plane + y * w + x]) continue
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const yy = y + dy, xx = x + dx
        if (yy >= 0 && yy < h && xx >= 0 && xx < w) keep[yy * w + xx] = 1
      }
    }
  }
  // Only a hand or an arm reaching in from outside the garment: a print the model left out stays.
  keepInside(prompt.mask, keep, w, h, pixels.data)
  const share = paintOut(new Uint8ClampedArray(pixels.data), w, h, prompt.mask, keep, prompt.bg)
  // Nothing worth painting out, or too much to trust: the photo as it was.
  if (share < 0.004 || share > 0.35) return src
  // Painted out on the photo at its own size (up to FULL across), so its print stays sharp.
  const k = Math.min(1, FULL / Math.max(image.naturalWidth, image.naturalHeight))
  const W = Math.round(image.naturalWidth * k), H = Math.round(image.naturalHeight * k)
  const full = document.createElement("canvas")
  full.width = W
  full.height = H
  const fc = full.getContext("2d", { willReadFrequently: true })
  fc.drawImage(image, 0, 0, W, H)
  const big = fc.getImageData(0, 0, W, H), d = big.data
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / H))
    for (let x = 0; x < W; x++) {
      const i = sy * w + Math.min(w - 1, Math.floor((x * w) / W))
      if (!prompt.mask[i] || keep[i]) continue
      const o = 4 * (y * W + x)
      d[o] = prompt.bg[0]; d[o + 1] = prompt.bg[1]; d[o + 2] = prompt.bg[2]
    }
  }
  fc.putImageData(big, 0, 0)
  return full.toDataURL("image/png")
}
