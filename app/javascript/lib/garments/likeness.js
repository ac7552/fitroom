// How alike two pictures of a garment look, to an AI model: DINOv2-small (Apache-2.0), run in the browser with
// Transformers.js, as segment.js runs its model. Each picture becomes the model's summary of it (its CLS token,
// 384 numbers, as the AI picture's check takes it on the server: script/modal/validate.py), and their cosine
// is the score, from about 0 (unrelated) to 1 (the same picture).
//
// The model and its library load from a public CDN the first time (about 25 MB, cached by the browser after
// that), in a worker. The pictures never leave the page. Anything that goes wrong (no network, an old browser,
// too slow) gives null, and the 3D view's check goes on without it (look_check.js).

const LIBRARY = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1"
const MODEL = "onnx-community/dinov2-small"

let loading = null
function load() {
  loading ??= (async () => {
    const t = await import(/* webpackIgnore: true */ LIBRARY)
    t.env.allowLocalModels = false
    if (t.env.backends?.onnx?.wasm) t.env.backends.onnx.wasm.proxy = true
    const model = await t.AutoModel.from_pretrained(MODEL, { dtype: "q8", device: "wasm" })
    const processor = await t.AutoProcessor.from_pretrained(MODEL)
    return { t, model, processor }
  })().catch(error => { loading = null; throw error })
  return loading
}

// Starts loading the model now (while the clothes drape), so it's ready when the check runs.
export function warmLikeness() {
  load().catch(() => {})
}

// a, b: ImageData (or { data, width, height } RGBA). Returns their likeness (cosine of the two summaries), or
// null when it can't be had within `timeout` ms.
export async function likeness(a, b, { timeout = 20000 } = {}) {
  try {
    return await Promise.race([score(a, b), new Promise(resolve => setTimeout(() => resolve(null), timeout))])
  } catch {
    return null
  }
}

async function score(a, b) {
  const { t, model, processor } = await load()
  const summary = async pixels => {
    const image = new t.RawImage(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height, 4).rgb()
    const inputs = await processor(image)
    const { last_hidden_state: hidden } = await model(inputs)
    return Array.from(hidden.data.slice(0, hidden.dims[2]))
  }
  const [x, y] = [await summary(a), await summary(b)]
  let dot = 0, nx = 0, ny = 0
  for (let i = 0; i < x.length; i++) { dot += x[i] * y[i]; nx += x[i] * x[i]; ny += y[i] * y[i] }
  return dot / Math.sqrt(nx * ny || 1)
}
