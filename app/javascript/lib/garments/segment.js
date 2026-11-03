// Cleaning a store photo before it's read: a segmentation model (SlimSAM, Apache-2.0, run in the browser
// with Transformers.js) is pointed at the garment, and what isn't part of it (a model's hand or arm, a bag,
// a hanger, a prop) is painted out in the backdrop's colour. Shop photos taken on a person, or with a hand
// in a pocket, would otherwise put those in the garment's colour, its print or its photo on the cloth.
//
// The model and its library load from a public CDN the first time a photo is cleaned (about 15 MB, cached
// by the browser after that). The photo itself never leaves the page. Anything that goes wrong (no
// network, an old browser, a mask that doesn't look like the garment) leaves the photo as it was.

import { garmentMask, isSkin, keepInside, loadImage, paintOut, photoTraits, pickMask, promptPoints } from "lib/garments/print"
import { remoteMasks, visionUrl } from "lib/garments/vision"

const LIBRARY = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1"
const MODEL = "Xenova/slimsam-77-uniform"
const SIZE = 640    // the photo is segmented at about this many pixels across
const FULL = 1600   // and painted out at up to this many
const SKIN_SHARE = 0.002   // the share of the photo that's skin below which there's nothing to paint out

let loading = null
function load() {
  loading ??= (async () => {
    const t = await import(/* webpackIgnore: true */ LIBRARY)
    t.env.allowLocalModels = false
    // In a worker, so the page (the 3D view, the fit) keeps going while a photo is cleaned.
    if (t.env.backends?.onnx?.wasm) t.env.backends.onnx.wasm.proxy = true
    // On the CPU (WebAssembly): this model's masks come back wrong on WebGPU in this library's version (all
    // of the picture, or none of it). A photo takes about five seconds.
    const model = await t.SamModel.from_pretrained(MODEL, { dtype: "q8", device: "wasm" })
    const processor = await t.AutoProcessor.from_pretrained(MODEL)
    return { t, model, processor }
  })().catch(error => { loading = null; throw error })
  return loading
}

// The model's masks for points on a picture (raw: a Transformers.js RawImage; points [[x, y]] in its pixels;
// labels 1 for "this", 0 for "not this"): { bits, count, scores, dims } as the processor gives them back.
// The model looks at a picture once (its image encoder, nearly all of its five seconds) and answers any
// points on it after that in a few milliseconds: what it saw is kept for the last few pictures, by `key`
// (the photo's address), so cleaning a photo and finding the garment on it again later look once.
const seen = new Map()
async function masksFor(raw, points, labels, key) {
  const { t, model, processor } = await load()
  let entry = key ? seen.get(key) : null
  // (Only for the picture at the same size: the masks come back at the size it was first seen at.)
  if (entry && (entry.width !== raw.width || entry.height !== raw.height)) entry = null
  if (!entry) {
    const inputs = await processor(raw)
    entry = { inputs, embeddings: await model.get_image_embeddings(inputs), width: raw.width, height: raw.height }
    if (key) {
      if (seen.size >= 4) seen.delete(seen.keys().next().value)
      seen.set(key, entry)
    }
  }
  const [rh, rw] = entry.inputs.reshaped_input_sizes[0]
  // Points in the picture's pixels, as fractions of it, onto the size the encoder saw it at.
  const at = points.map(([x, y]) => [(x / raw.width) * rw, (y / raw.height) * rh])
  const inputPoints = new t.Tensor("float32", at.flat(), [1, 1, at.length, 2])
  const inputLabels = new t.Tensor("int64", labels.map(v => BigInt(v)), [1, 1, labels.length])
  const outputs = await model({ ...entry.embeddings, input_points: inputPoints, input_labels: inputLabels })
  const masks = await processor.post_process_masks(outputs.pred_masks, entry.inputs.original_sizes, entry.inputs.reshaped_input_sizes)
  const all = masks[0]
  return { bits: all.data, count: all.dims[1], scores: outputs.iou_scores.data }
}

// A key for a photo by its address (a data: URL's length and some of its middle and end, not all of it).
export function photoKey(src) {
  if (typeof src !== "string") return null
  return `${src.length}:${src.slice(Math.floor(src.length / 2), Math.floor(src.length / 2) + 48)}:${src.slice(-48)}`
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
  const image = await loadImage(src)
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
  // Only a hand or an arm is ever painted out (see keepInside), so a photo with no skin in it (a flat shot,
  // a hanger) is left as it is, and skips the model's five seconds.
  if (photoTraits(pixels.data, w, h).skin < SKIN_SHARE) return src

  // The model's masks: from the vision service when the server has one (vision.js), else the model here.
  const plane = w * h
  let bits, count, scores
  const remote = visionUrl() ? await remoteMasks(pixels.data, w, h, prompt.points) : null
  if (remote) ({ bits, count, scores } = remote)
  else {
    const { t } = await load()
    const raw = new t.RawImage(new Uint8ClampedArray(pixels.data), w, h, 4).rgb()
    ;({ bits, count, scores } = await masksFor(raw, prompt.points, prompt.points.map(() => 1), photoKey(src)))
  }

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

// The garment alone in a photo of someone wearing it (data: RGBA, w by h; kind "top", "dress" or
// "trousers"): a mask (1 per pixel) of the garment's cloth, without the wearer's face, hair, arms, hands or
// legs, or null when it can't be found. The person is cut from the backdrop; the face is the skin at the top
// of them; the model is pointed at the middle of the cloth below it (the torso, or the hips and legs for
// trousers) and told the face and the hair aren't it; what it gives back is kept where it isn't skin.
// Without the model (no network, an old browser), the person less their skin and anything above the
// shoulders stands in.
export async function wornGarmentMask(data, w, h, kind = "top", src = null) {
  const person = garmentMask(data, w, h)?.mask
  if (!person) return null
  const n = w * h
  const skin = new Uint8Array(n)
  for (let i = 0; i < n; i++) if (person[i] && isSkin(data[4 * i], data[4 * i + 1], data[4 * i + 2])) skin[i] = 1
  let top = -1, bottom = -1
  for (let y = 0; y < h && top < 0; y++) for (let x = 0; x < w; x++) if (person[y * w + x]) { top = y; break }
  for (let y = h - 1; y >= 0 && bottom < 0; y--) for (let x = 0; x < w; x++) if (person[y * w + x]) { bottom = y; break }
  if (top < 0 || bottom - top < 0.3 * h) return null
  const tall = bottom - top
  // The face: the skin in the person's top third, as a box; the cloth starts below its chin.
  let fx0 = w, fx1 = -1, fy0 = h, fy1 = -1, faceN = 0
  for (let y = top; y < top + tall / 3; y++) for (let x = 0; x < w; x++) if (skin[y * w + x]) { faceN++; fx0 = Math.min(fx0, x); fx1 = Math.max(fx1, x); fy0 = Math.min(fy0, y); fy1 = Math.max(fy1, y) }
  const face = faceN > 0.002 * n ? { x: (fx0 + fx1) / 2, y: (fy0 + fy1) / 2, top: fy0, bottom: fy0 + (fy1 - fy0) * 0.75, half: (fx1 - fx0) / 2 } : null
  const from = face ? Math.round(face.bottom) : top
  // The cloth's candidate: the person less skin, below the chin.
  const candidate = new Uint8Array(n)
  for (let y = from; y <= bottom; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (person[i] && !skin[i]) candidate[i] = 1 }
  // Points down the middle of it: the torso for a top or a dress, the hips and both legs for trousers.
  const runAt = (y, near) => {
    let best = null, start = -1
    for (let x = 0; x <= w; x++) {
      const on = x < w && candidate[y * w + x]
      if (on && start < 0) start = x
      if (!on && start >= 0) { const run = [start, x - 1]; if (!best || (near == null ? run[1] - run[0] > best[1] - best[0] : Math.abs((run[0] + run[1]) / 2 - near) < Math.abs((best[0] + best[1]) / 2 - near))) best = run; start = -1 }
    }
    return best && best[1] - best[0] > 0.03 * w ? [(best[0] + best[1]) / 2, y] : null
  }
  const centre = face ? face.x : w / 2
  const shares = kind === "trousers" ? [0.5, 0.65, 0.85] : [0.28, 0.4, 0.55]
  const positives = shares.map(t => runAt(Math.round(top + t * tall), centre)).filter(Boolean)
  if (!positives.length) return null
  // Not the face, nor the hair beside it.
  const negatives = []
  if (face) {
    negatives.push([face.x, face.y])
    for (const side of [-1, 1]) {
      const x = Math.round(face.x + side * face.half * 1.6), y = Math.round(face.bottom)
      if (x >= 0 && x < w && person[y * w + x] && !skin[y * w + x]) negatives.push([x, y])
    }
  }
  let mask = null
  try {
    const { t } = await load()
    const scale = Math.min(1, SIZE / Math.max(w, h))
    const sw = Math.round(w * scale), sh = Math.round(h * scale)
    const canvas = document.createElement("canvas")
    canvas.width = sw; canvas.height = sh
    const ctx = canvas.getContext("2d")
    const full = document.createElement("canvas")
    full.width = w; full.height = h
    full.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0)
    ctx.drawImage(full, 0, 0, sw, sh)
    const small = ctx.getImageData(0, 0, sw, sh)
    const raw = new t.RawImage(new Uint8ClampedArray(small.data), sw, sh, 4).rgb()
    const points = [...positives, ...negatives].map(([x, y]) => [x * scale, y * scale])
    const labels = [...positives.map(() => 1), ...negatives.map(() => 0)]
    const { bits, count, scores } = await masksFor(raw, points, labels, photoKey(src))
    const plane = sw * sh
    // The mask that holds the points on the cloth and not the face, the largest of those the model is sure of.
    let best = -1, bestArea = 0
    for (let k = 0; k < count; k++) {
      const at = ([x, y]) => bits[k * plane + Math.min(sh - 1, Math.round(y * scale)) * sw + Math.min(sw - 1, Math.round(x * scale))]
      if (!positives.every(at) || negatives.some(at) || scores[k] < 0.7) continue
      let area = 0
      for (let i = 0; i < plane; i++) if (bits[k * plane + i]) area++
      if (area > bestArea) { best = k; bestArea = area }
    }
    if (best >= 0) {
      mask = new Uint8Array(n)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (person[i] && !skin[i] && bits[best * plane + Math.min(sh - 1, Math.floor(y * scale)) * sw + Math.min(sw - 1, Math.floor(x * scale))]) mask[i] = 1
      }
    }
  } catch { mask = null }
  return mask ?? candidate
}

// How long a worn garment's sleeves are, from a photo of someone wearing it (data: RGBA, w by h): "none"
// (the arms bare from the shoulder), "short" (bare below the upper arm), "long" (covered to the wrist), or
// null when the arms can't be found. The arms are the person's outermost columns either side of the torso,
// from the shoulders to the hips; what share of them is skin, over the upper arm and over the forearm,
// says how far the sleeves reach.
export function wornSleeves(data, w, h) {
  const person = garmentMask(data, w, h)?.mask
  if (!person) return null
  let top = -1, bottom = -1
  for (let y = 0; y < h && top < 0; y++) for (let x = 0; x < w; x++) if (person[y * w + x]) { top = y; break }
  for (let y = h - 1; y >= 0 && bottom < 0; y--) for (let x = 0; x < w; x++) if (person[y * w + x]) { bottom = y; break }
  if (top < 0) return null
  const tall = bottom - top
  // The shoulders are about a fifth of the way down a photo cropped at the knee or above, an eighth on a
  // full figure; the hips about half or a third. Read the arms over 25%–40% (upper arm) and 42%–55% (forearm).
  const band = (from, to) => {
    let skin = 0, all = 0
    for (let y = Math.round(top + from * tall); y < top + to * tall; y += 2) {
      let a = -1, b = -1
      for (let x = 0; x < w; x++) if (person[y * w + x]) { if (a < 0) a = x; b = x }
      if (a < 0) continue
      const reach = Math.max(2, Math.round((b - a) * 0.14))
      for (const [x0, x1] of [[a, a + reach], [b - reach, b]]) for (let x = x0; x <= x1; x++) {
        const i = y * w + x
        if (!person[i]) continue
        all++
        if (isSkin(data[4 * i], data[4 * i + 1], data[4 * i + 2])) skin++
      }
    }
    return all > 40 ? skin / all : null
  }
  const upper = band(0.25, 0.4), fore = band(0.42, 0.55)
  if (upper == null || fore == null) return null
  if (upper > 0.5) return "none"
  if (fore > 0.5) return "short"
  if (fore < 0.2 && upper < 0.2) return "long"
  return null
}
