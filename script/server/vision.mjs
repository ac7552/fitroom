// Fitroom's vision service: the two AI models the page runs on store photos (SlimSAM to cut a hand or a prop
// out of a photo, DINOv2 to score how alike a render and a photo look), run here on the server's CPU instead
// of in the visitor's browser. The same library and models as the page (segment.js, likeness.js), on
// onnxruntime's native CPU build, which is several times faster than the browser's WebAssembly and starts
// warm; and nothing to download into the visitor's browser. Only store photos ever come here: the page sends
// a store photo's pixels (shrunk) and gets masks or a summary back; nothing is written down or logged.
//
//   node script/server/vision.mjs            # listens on PORT (8787)
//   FITROOM_VISION_URL=http://localhost:8787 (the page's .env) sends the page's photo work here
//
// POST /clean   { width, height, rgba (base64), points: [[x, y], ...] }
//               → { masks: [base64 of width×height bytes, 0/1] × 3, scores: [3 numbers] }
// POST /embed   { width, height, rgba (base64) } → { embedding: [384 numbers] }
// GET  /up      → ok once the models are loaded
//
// The models (about 40 MB) are fetched from the Hugging Face hub into MODELS_DIR the first time (or put
// there beforehand: see docs/droplet.md), then read from disk.
import http from "node:http"
import path from "node:path"
import { env, SamModel, AutoProcessor, AutoModel, RawImage } from "@huggingface/transformers"

const PORT = Number(process.env.PORT ?? 8787)
const MODELS_DIR = process.env.MODELS_DIR ?? path.resolve("tmp/models")
const SAM = "Xenova/slimsam-77-uniform"
const DINO = "onnx-community/dinov2-small"
const MAX_BODY = 12 * 1024 * 1024   // a 1024-pixel photo's RGBA, base64

env.cacheDir = MODELS_DIR
env.allowLocalModels = true
env.localModelPath = MODELS_DIR
env.allowRemoteModels = process.env.MODELS_OFFLINE !== "1"

let sam = null, dino = null
const loading = (async () => {
  const [samModel, samProcessor, dinoModel, dinoProcessor] = await Promise.all([
    SamModel.from_pretrained(SAM, { dtype: "q8", device: "cpu" }),
    AutoProcessor.from_pretrained(SAM),
    AutoModel.from_pretrained(DINO, { dtype: "q8", device: "cpu" }),
    AutoProcessor.from_pretrained(DINO)
  ])
  sam = { model: samModel, processor: samProcessor }
  dino = { model: dinoModel, processor: dinoProcessor }
  console.log(`[vision] models ready (${MODELS_DIR})`)
})().catch(error => { console.error("[vision] couldn't load the models:", error.message); process.exitCode = 1 })

// One request at a time through each model (onnxruntime sessions aren't reentrant); the rest queue.
let queue = Promise.resolve()
const inTurn = job => { const next = queue.then(job, job); queue = next.catch(() => {}); return next }

async function clean({ width, height, rgba, points }) {
  if (!(width > 0 && height > 0 && width * height <= 1024 * 1024) || !Array.isArray(points) || !points.length) throw new Error("bad input")
  const data = Buffer.from(rgba, "base64")
  if (data.length !== 4 * width * height) throw new Error("bad pixels")
  const image = new RawImage(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width, height, 4).rgb()
  const inputs = await sam.processor(image, { input_points: [[points]], input_labels: [[points.map(() => 1)]] })
  const outputs = await sam.model(inputs)
  const masks = await sam.processor.post_process_masks(outputs.pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes)
  const all = masks[0]   // [1, 3, h, w]
  const count = all.dims[1], plane = width * height
  const bits = all.data
  const out = []
  for (let k = 0; k < count; k++) out.push(Buffer.from(Uint8Array.from(bits.subarray(k * plane, (k + 1) * plane), v => (v ? 1 : 0))).toString("base64"))
  return { masks: out, scores: Array.from(outputs.iou_scores.data) }
}

async function embed({ width, height, rgba }) {
  if (!(width > 0 && height > 0 && width * height <= 1024 * 1024)) throw new Error("bad input")
  const data = Buffer.from(rgba, "base64")
  if (data.length !== 4 * width * height) throw new Error("bad pixels")
  const image = new RawImage(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width, height, 4).rgb()
  const inputs = await dino.processor(image)
  const { last_hidden_state: hidden } = await dino.model(inputs)
  return { embedding: Array.from(hidden.data.slice(0, hidden.dims[2])) }
}

const ROUTES = { "/clean": clean, "/embed": embed }

function body(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on("data", chunk => {
      size += chunk.length
      if (size > MAX_BODY) { reject(new Error("too big")); request.destroy() } else chunks.push(chunk)
    })
    request.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))) } catch (error) { reject(error) } })
    request.on("error", reject)
  })
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }

http.createServer(async (request, response) => {
  const send = (status, payload) => { response.writeHead(status, { "Content-Type": "application/json", ...CORS }); response.end(JSON.stringify(payload)) }
  if (request.method === "OPTIONS") { response.writeHead(204, CORS); return response.end() }
  const url = new URL(request.url, "http://x")
  if (request.method === "GET" && url.pathname === "/up") return send(sam && dino ? 200 : 503, { ok: Boolean(sam && dino) })
  const route = request.method === "POST" ? ROUTES[url.pathname] : null
  if (!route) return send(404, { error: "no such route" })
  try {
    await loading
    if (!sam || !dino) return send(503, { error: "models not loaded" })
    const input = await body(request)
    const t0 = performance.now()
    const result = await inTurn(() => route(input))
    result.ms = Math.round(performance.now() - t0)
    send(200, result)
  } catch (error) {
    send(error.message === "bad input" || error.message === "bad pixels" ? 400 : 500, { error: error.message })
  }
}).listen(PORT, () => console.log(`[vision] listening on ${PORT}`))
