// The page's photo tools, for the Fitroom server to serve itself (lib/hosted.js): transformers.js and ONNX
// Runtime's WebAssembly, MediaPipe's tasks-vision, the pose model, and the two Hugging Face models the page
// runs on shop photos (SlimSAM, DINOv2-small, Depth Anything V2 Small, at the precisions the page asks for), laid
// out under one folder with a manifest.json saying what's there. Run by the Dockerfile's vendor stage (where
// the build has the internet), after `npm install` of the two packages below:
//
//   npm install --prefix /tmp/vendor @huggingface/transformers@4.3.2 @mediapipe/tasks-vision@1.1.1
//   node script/vendor/fetch.mjs /tmp/vendor/node_modules public/vendor
//
// What can't be fetched is left out of the manifest, and the page takes that one from the CDN as before.
import fs from "node:fs"
import path from "node:path"

const [modules, out] = process.argv.slice(2)
if (!modules || !out) { console.error("usage: fetch.mjs <node_modules> <out>"); process.exit(2) }
const manifest = {}
fs.mkdirSync(out, { recursive: true })
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to) }

// transformers.js's browser build (transformers.min.js, the one the CDN serves: ONNX Runtime's JavaScript
// bundled in) and ONNX Runtime's WebAssembly: version 3 shipped it beside it, 4 has the browser fetch it from
// onnxruntime-web's own package (its .mjs and .wasm, by the names in env.backends.onnx.wasm.wasmPaths), which
// npm installs with it. hosted.js points the page at this folder for both.
const tf = path.join(modules, "@huggingface/transformers/dist")
const ortWeb = path.join(modules, "onnxruntime-web/dist")
const ORT_FILE = /^ort-wasm-simd-threaded(\.asyncify|\.jsep)?\.(mjs|wasm)$/
if (fs.existsSync(path.join(tf, "transformers.min.js"))) {
  copy(path.join(tf, "transformers.min.js"), path.join(out, "transformers", "transformers.min.js"))
  let runtime = 0
  for (const dir of [tf, ortWeb]) {
    if (!fs.existsSync(dir)) continue
    for (const file of fs.readdirSync(dir)) if (ORT_FILE.test(file)) { copy(path.join(dir, file), path.join(out, "transformers", file)); runtime++ }
  }
  manifest.transformers = "/vendor/transformers/transformers.min.js"
  if (runtime) manifest.wasm = "/vendor/transformers/"
  console.log(`transformers.js copied${runtime ? ", with ONNX Runtime's WebAssembly" : " (ONNX Runtime's WebAssembly not found: the page takes it from the CDN)"}`)
}

// MediaPipe's tasks-vision: its ES module and its WebAssembly folder.
const mp = path.join(modules, "@mediapipe/tasks-vision")
if (fs.existsSync(path.join(mp, "vision_bundle.mjs"))) {
  copy(path.join(mp, "vision_bundle.mjs"), path.join(out, "mediapipe", "vision_bundle.mjs"))
  for (const file of fs.readdirSync(path.join(mp, "wasm"))) copy(path.join(mp, "wasm", file), path.join(out, "mediapipe", "wasm", file))
  manifest.mediapipe = "/vendor/mediapipe"
  console.log("MediaPipe copied")
}

async function download(url, to) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.writeFileSync(to, Buffer.from(await response.arrayBuffer()))
}

// The pose model (measure_photo.js's MODEL).
const POSE = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task"
try {
  await download(POSE, path.join(out, "models", "pose_landmarker_full.task"))
  manifest.pose = "/vendor/models/pose_landmarker_full.task"
  console.log("pose model fetched")
} catch (error) { console.warn("pose model not fetched:", error.message) }

// The shop photos' models, the files the page asks for (photo_models.js's precisionFor): half precision for a
// graphics card, 8 bits for the CPU with SAM's prompt decoder at full precision. Laid out as <model>/<file>, where
// hosted.js points the page. (Full precision for a card without half precision isn't kept here, nor is
// anything a later version asks for that isn't listed: the page takes those from the Hugging Face hub.)
const MODELS = {
  "Xenova/slimsam-77-uniform": ["onnx/vision_encoder_fp16.onnx", "onnx/prompt_encoder_mask_decoder_fp16.onnx", "onnx/vision_encoder_quantized.onnx", "onnx/prompt_encoder_mask_decoder.onnx"],
  "onnx-community/dinov2-small": ["onnx/model_fp16.onnx", "onnx/model_quantized.onnx"],
  // The depth model (lib/garments/depth.js): a shoe's relief from its side photo.
  "onnx-community/depth-anything-v2-small": ["onnx/model_fp16.onnx", "onnx/model_quantized.onnx"]
}
try {
  for (const [name, files] of Object.entries(MODELS)) {
    for (const file of ["config.json", "preprocessor_config.json", ...files]) {
      await download(`https://huggingface.co/${name}/resolve/main/${file}`, path.join(out, "models", name, file))
    }
  }
  manifest.models = "/vendor/models/"
  console.log("photo models fetched")
} catch (error) { console.warn("photo models not fetched:", error.message) }

fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
console.log("wrote", path.join(out, "manifest.json"), Object.keys(manifest).join(", "))
