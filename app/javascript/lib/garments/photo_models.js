// The page's two photo models, segment.js's SlimSAM and likeness.js's DINOv2, share one Transformers.js, set up
// here once: on the graphics card (WebGPU) when the browser has one, else on the CPU (WebAssembly, in ONNX
// Runtime's own worker, as before). Each model's precision follows from that (precisionFor).
//
// Measured on an M2 Pro (Chrome 152) on ten store photos from the look audit, against full precision on the CPU:
//   SlimSAM, a photo looked at: 4.4 s on the CPU at 8 bits (as before); 1.0 s on WebGPU at half precision,
//     with the same mask picked on all ten photos (8 bits: on eight) and an IoU of 0.997 at the median (0.988).
//   DINOv2, a picture: 2.4 s on the CPU at 8 bits; 0.07 s on WebGPU at half precision, the likeness of two
//     pictures within 0.007 of full precision's (8 bits: within 0.073, against look_check.js's bar of 0.35).
// Transformers.js 3.5's WebGPU gave SAM wrong masks; 4.3's gives the CPU's, to the pixel at full precision.
//
// The files come from the Fitroom server when it has a copy (hosted.js), else the CDN and the Hugging Face hub,
// and the browser keeps them. Only models and their runtime are downloaded; no photo leaves the page.

import { loadTransformers, modelsFromHub } from "lib/hosted"

export const LIBRARY = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2"

let ready = null
// { t: the library, device: "webgpu" or "wasm", f16: whether the card does half precision }
export function photoRuntime() {
  ready ??= (async () => {
    const [t, gpu] = await Promise.all([loadTransformers(LIBRARY), graphicsCard()])
    t.env.allowLocalModels = false
    // On the CPU, ONNX Runtime works in its own worker, so the 3D view keeps going while a photo is read. (That
    // worker is for WebAssembly only: on WebGPU the work is the card's, and the page only hands it over.)
    const wasm = t.env.backends?.onnx?.wasm
    if (wasm) wasm.proxy = !gpu
    return { t, device: gpu ? "webgpu" : "wasm", f16: Boolean(gpu?.f16) }
  })().catch(error => { ready = null; throw error })
  return ready
}

// The browser's graphics card for WebGPU, as { f16 }, or null: none, or only a software one (slower than the CPU's
// WebAssembly).
async function graphicsCard() {
  try {
    if (typeof navigator === "undefined" || !navigator.gpu) return null
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
    if (!adapter || adapter.info?.isFallbackAdapter || adapter.isFallbackAdapter) return null
    return { f16: adapter.features.has("shader-f16") }
  } catch {
    return null
  }
}

// The precision each model runs at (kind "sam" or "dino"), on { device, f16 }: on WebGPU, half precision on a card
// that does it, else full; on the CPU, 8 bits, but SAM's prompt decoder at full precision: it's where 8 bits moved
// the masks most (with it, the same pick as full precision on eight photos of ten rather than seven, and an IoU of
// 0.996 at the median rather than 0.981), for 11.7 MB more to download and no slower.
export function precisionFor(kind, { device, f16 }) {
  if (device === "webgpu") return f16 ? "fp16" : "fp32"
  return kind === "sam" ? { vision_encoder: "q8", prompt_encoder_mask_decoder: "fp32" } : "q8"
}

// Loads a model (pick: the library to its class, as t => t.SamModel) and its processor at its precision. When the
// server's copy of the files hasn't the one asked for, from the Hugging Face hub instead. Rejects when it can't be
// had (offline, an old browser, a card WebGPU can't use): the callers then go on without it, as they always have.
// (Not then on the CPU instead: ONNX Runtime has already started without its worker, and a photo looked at on the
// page's own thread would stop the 3D view for seconds.)
export async function loadPhotoModel(pick, name, kind) {
  const runtime = await photoRuntime()
  const { t } = runtime
  const load = () => Promise.all([
    pick(t).from_pretrained(name, { dtype: precisionFor(kind, runtime), device: runtime.device }),
    t.AutoProcessor.from_pretrained(name)
  ])
  let model, processor
  try {
    ;[model, processor] = await load()
  } catch (error) {
    if (!modelsFromHub(t)) throw error
    ;[model, processor] = await load()
  }
  return { t, model, processor, device: runtime.device }
}

// SAM's input for a picture (a canvas, or anything drawImage takes, `width` by `height`), as its processor makes it
// (resized so its longest side is 1024, scaled, normalised, padded to 1024 square) but in a fraction of the time:
// the canvas resizes it, and one loop does the rest. The processor's own takes most of a second on the page's
// thread; this, 30 to 90 ms, to the same numbers. Returns { pixel_values, original_sizes, reshaped_input_sizes }.
export function samInputs(t, source, width, height, processor) {
  const p = processor.image_processor ?? processor
  const longest = p.size?.longest_edge ?? 1024
  const pad = { height: p.pad_size?.height ?? longest, width: p.pad_size?.width ?? longest }
  const k = longest / Math.max(width, height)
  const rw = Math.round(width * k), rh = Math.round(height * k)
  const canvas = document.createElement("canvas")
  canvas.width = rw
  canvas.height = rh
  const context = canvas.getContext("2d", { willReadFrequently: true })
  context.drawImage(source, 0, 0, rw, rh)
  const rgba = context.getImageData(0, 0, rw, rh).data
  const data = samPixels(rgba, rw, rh, pad, { mean: p.image_mean, std: p.image_std, scale: p.rescale_factor })
  return {
    pixel_values: new t.Tensor("float32", data, [1, 3, pad.height, pad.width]),
    original_sizes: [[height, width]],
    reshaped_input_sizes: [[rh, rw]]
  }
}

// The loop: RGBA pixels (w by h) to SAM's planes (red, green, blue, each pad.width by pad.height, the picture in
// the top left and zeros round it), each value (v × scale − mean) / std.
export function samPixels(rgba, w, h, pad = { width: 1024, height: 1024 }, { mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225], scale = 1 / 255 } = {}) {
  const W = pad.width, plane = W * pad.height
  const out = new Float32Array(3 * plane)
  const a = std.map(s => scale / s), b = mean.map((m, c) => -m / std[c])
  for (let y = 0; y < h; y++) {
    let i = 4 * y * w, o = y * W
    for (let x = 0; x < w; x++, i += 4, o++) {
      out[o] = rgba[i] * a[0] + b[0]
      out[plane + o] = rgba[i + 1] * a[1] + b[1]
      out[2 * plane + o] = rgba[i + 2] * a[2] + b[2]
    }
  }
  return out
}
