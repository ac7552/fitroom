// Depth from a shop photo: a monocular depth model (Depth Anything V2 Small, Apache-2.0, 25 MB at 8 bits) run in
// the browser with Transformers.js, as the photo tools in segment.js and likeness.js are. It gives, for every
// pixel of a photo, how near the camera that point is relative to the rest: on a shoe's side photo, the curve of
// the toe box, the vamp's dip, a heel's stem standing proud of the upper, a cuff's folds; on a coat, a puffer's
// baffles or a shearling's pile. The shape a shoe or a garment is built with takes it as relief (see relief.js).
//
// The model loads from the Fitroom server's /vendor when it has a copy (hosted.js), else from the public CDN,
// once per page, and runs on WebGPU where there is one and WebAssembly otherwise, in a worker. A photo takes
// about a second on a laptop, a few on a phone. Anything that goes wrong (no network, an old browser) gives
// null, and the caller builds without relief, as before.
import { loadTransformers } from "lib/hosted"

const LIBRARY = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1"
const MODEL = "onnx-community/depth-anything-v2-small"
export const DEPTH_SIZE = 518   // the model's input: the longer side is scaled to this (a multiple of 14)

let loading = null
function load() {
  loading ??= (async () => {
    const t = await loadTransformers(LIBRARY)
    t.env.allowLocalModels = false
    if (t.env.backends?.onnx?.wasm) t.env.backends.onnx.wasm.proxy = true
    const device = typeof navigator !== "undefined" && navigator.gpu ? "webgpu" : "wasm"
    let estimator
    try {
      estimator = await t.pipeline("depth-estimation", MODEL, { dtype: device === "webgpu" ? "fp16" : "q8", device })
    } catch {
      estimator = await t.pipeline("depth-estimation", MODEL, { dtype: "q8", device: "wasm" })
    }
    return { t, estimator }
  })().catch(error => { loading = null; throw error })
  return loading
}

// Relative depth over a picture: { data: Float32Array (0 far to 1 near, over the picture's pixels), w, h } for
// an HTMLImageElement, a canvas or an ImageData, at the model's working size (the picture's aspect kept), or null.
// Everything outside `mask` (an optional Uint8Array at the picture's size) is left out of the normalisation, so
// a backdrop or a cast shadow doesn't set the range.
export async function readDepth(source, { mask = null, maskW = 0, maskH = 0 } = {}) {
  try {
    const { t, estimator } = await load()
    const raw = await rawImage(t, source)
    const out = await estimator(raw)
    // Transformers gives `predicted_depth` as a tensor at the model's size and `depth` as an image at the
    // input's; the tensor is the finer measure.
    const tensor = out.predicted_depth
    const [h, w] = tensor.dims.slice(-2)
    const values = tensor.data
    // Normalise over the masked pixels (or all of them): 0 far, 1 near.
    let lo = Infinity, hi = -Infinity
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (mask && !mask[Math.min(maskH - 1, Math.floor((y / h) * maskH)) * maskW + Math.min(maskW - 1, Math.floor((x / w) * maskW))]) continue
      const v = values[y * w + x]
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    if (!(hi > lo)) return null
    const data = new Float32Array(w * h)
    for (let i = 0; i < w * h; i++) data[i] = Math.min(1, Math.max(0, (values[i] - lo) / (hi - lo)))
    return { data, w, h }
  } catch {
    return null
  }
}

// The depth over a shoe's side photo (src), the shoe itself setting the range: the photo at the model's size,
// masked by the side outline's columns (shoeSide's top and bottom per column, shares of the photo).
export async function depthForSide(src, side) {
  try {
    const image = await new Promise((resolve, reject) => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => resolve(i); i.onerror = reject; i.src = src })
    const scale = DEPTH_SIZE / Math.max(image.naturalWidth, image.naturalHeight)
    const w = Math.max(14, Math.round((image.naturalWidth * scale) / 14) * 14), h = Math.max(14, Math.round((image.naturalHeight * scale) / 14) * 14)
    const canvas = document.createElement("canvas")
    canvas.width = w; canvas.height = h
    canvas.getContext("2d").drawImage(image, 0, 0, w, h)
    const mask = new Uint8Array(w * h)
    if (side?.top && side.bottom) {
      const bins = side.top.length
      for (let x = 0; x < w; x++) {
        const share = (x + 0.5) / w
        if (share < side.left || share > side.right) continue
        let u = (share - side.left) / (side.right - side.left)
        if (!side.toeRight) u = 1 - u
        const b = Math.min(bins - 1, Math.max(0, Math.floor(u * bins)))
        const y0 = Math.floor(side.top[b] * h), y1 = Math.ceil(side.bottom[b] * h)
        for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) mask[y * w + x] = 1
      }
    }
    return readDepth(canvas, { mask: mask.some(v => v) ? mask : null, maskW: w, maskH: h })
  } catch {
    return null
  }
}

// Depth sampled at a share of the picture's width and height (u, v in 0..1), bilinear.
export function depthAt(depth, u, v) {
  const x = Math.min(depth.w - 1, Math.max(0, u * (depth.w - 1))), y = Math.min(depth.h - 1, Math.max(0, v * (depth.h - 1)))
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(depth.w - 1, x0 + 1), y1 = Math.min(depth.h - 1, y0 + 1)
  const fx = x - x0, fy = y - y0
  const d = depth.data
  return (d[y0 * depth.w + x0] * (1 - fx) + d[y0 * depth.w + x1] * fx) * (1 - fy) + (d[y1 * depth.w + x0] * (1 - fx) + d[y1 * depth.w + x1] * fx) * fy
}

async function rawImage(t, source) {
  if (typeof source === "string") return t.RawImage.read(source)
  if (source instanceof ImageData) return new t.RawImage(source.data, source.width, source.height, 4)
  const canvas = source.getContext ? source : (() => { const c = document.createElement("canvas"); c.width = source.naturalWidth || source.width; c.height = source.naturalHeight || source.height; c.getContext("2d").drawImage(source, 0, 0); return c })()
  const context = canvas.getContext("2d", { willReadFrequently: true })
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  return new t.RawImage(pixels.data, pixels.width, pixels.height, 4)
}
