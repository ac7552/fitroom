// Where the page's photo tools come from: the Fitroom server itself when its image has them (/vendor, filled
// when the Docker image is built: the Dockerfile's vendor stage writes public/vendor/manifest.json), else the
// public CDNs as before (on a laptop's bin/dev, say). From the server, nothing a visitor's browser loads
// comes from anyone else, and the first photo doesn't wait on a CDN.
//
// manifest.json: { transformers: URL of transformers.js's ES module, wasm: the folder of ONNX Runtime's
// WebAssembly files, models: the folder of the Hugging Face models (laid out as <model>/<file>, as
// transformers.js's file cache keeps them), mediapipe: MediaPipe tasks-vision's folder, pose: the pose
// model's file }, each only when it's there.
const MANIFEST = "/vendor/manifest.json"

let manifest = null
export function hosted() {
  manifest ??= (typeof fetch === "undefined" ? Promise.resolve(null)
    : fetch(MANIFEST, { cache: "no-cache" }).then(r => (r.ok ? r.json() : null)).catch(() => null))
  return manifest
}

const absolute = url => new URL(url, typeof location === "undefined" ? "http://localhost/" : location.href).href

// transformers.js, from the server when it's there (and then its runtime's files and its models too), else
// from `cdn`. Returns the library's module.
export async function loadTransformers(cdn) {
  const h = await hosted()
  if (h?.transformers) {
    try {
      const t = await import(/* webpackIgnore: true */ absolute(h.transformers))
      if (h.wasm && t.env.backends?.onnx?.wasm) t.env.backends.onnx.wasm.wasmPaths = absolute(h.wasm)
      if (h.models) {
        t.env.remoteHost = absolute(h.models)
        t.env.remotePathTemplate = "{model}/"
      }
      return t
    } catch {
      // (The server's copy didn't load: the CDN's, as before.)
    }
  }
  return import(/* webpackIgnore: true */ cdn)
}

// MediaPipe's tasks-vision folder and the pose model, from the server when they're there.
export async function mediapipeSources(cdn, model) {
  const h = await hosted()
  return { base: h?.mediapipe ? absolute(h.mediapipe).replace(/\/$/, "") : cdn, model: h?.pose ? absolute(h.pose) : model }
}
