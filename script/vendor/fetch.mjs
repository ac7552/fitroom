// The page's photo tools, for the Fitroom server to serve itself (lib/hosted.js): transformers.js and ONNX
// Runtime's WebAssembly, MediaPipe's tasks-vision, the pose model, and the two Hugging Face models the page
// runs on shop photos (SlimSAM, DINOv2-small, 8-bit), laid out under one folder with a manifest.json saying
// what's there. Run by the Dockerfile's vendor stage (where the build has the internet), after
// `npm install` of the two packages below:
//
//   npm install --prefix /tmp/vendor @huggingface/transformers@3.5.1 @mediapipe/tasks-vision@1.1.1
//   NODE_PATH=/tmp/vendor/node_modules node script/vendor/fetch.mjs /tmp/vendor/node_modules public/vendor
//
// What can't be fetched is left out of the manifest, and the page takes that one from the CDN as before.
import fs from "node:fs"
import path from "node:path"

const [modules, out] = process.argv.slice(2)
if (!modules || !out) { console.error("usage: fetch.mjs <node_modules> <out>"); process.exit(2) }
const manifest = {}
fs.mkdirSync(out, { recursive: true })
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to) }

// transformers.js's browser build (transformers.min.js, the one the CDN serves: ONNX Runtime bundled in) and
// ONNX Runtime's WebAssembly, which it ships beside it.
const tf = path.join(modules, "@huggingface/transformers/dist")
if (fs.existsSync(path.join(tf, "transformers.min.js"))) {
  for (const file of fs.readdirSync(tf)) {
    if (/^transformers\.min\.js$|^ort-wasm.*\.(mjs|wasm)$/.test(file)) copy(path.join(tf, file), path.join(out, "transformers", file))
  }
  manifest.transformers = "/vendor/transformers/transformers.min.js"
  manifest.wasm = "/vendor/transformers/"
  console.log("transformers.js copied")
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
const POSE = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task"
try {
  await download(POSE, path.join(out, "models", "pose_landmarker_lite.task"))
  manifest.pose = "/vendor/models/pose_landmarker_lite.task"
  console.log("pose model fetched")
} catch (error) { console.warn("pose model not fetched:", error.message) }

// The shop photos' models, as the page asks for them (segment.js, likeness.js: 8-bit, on the CPU). Loading
// them once in Node with the models folder as transformers.js's file cache leaves every file the browser
// will ask for at <model>/<file>, as the page's hosted.js points it there.
try {
  const t = await import(path.resolve(modules, "@huggingface/transformers/dist/transformers.node.mjs"))
  t.env.cacheDir = path.join(out, "models")
  t.env.allowLocalModels = false
  for (const [Model, name] of [[t.SamModel, "Xenova/slimsam-77-uniform"], [t.AutoModel, "onnx-community/dinov2-small"]]) {
    await Model.from_pretrained(name, { dtype: "q8", device: "cpu" })
    await t.AutoProcessor.from_pretrained(name)
  }
  manifest.models = "/vendor/models/"
  console.log("photo models fetched")
} catch (error) { console.warn("photo models not fetched:", error.message) }

fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
console.log("wrote", path.join(out, "manifest.json"), Object.keys(manifest).join(", "))
