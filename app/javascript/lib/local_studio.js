// Studio look: the photo of the 3D view, finished by an image model running on this computer (ComfyUI with
// SDXL and a ControlNet, at 127.0.0.1:8188). Nothing leaves the device: the photo goes to the local
// program and comes back from it.
//
// The model repaints the photo lightly (lighting, cloth texture, a real mannequin's finish), guided by the
// photo itself so the shape and fit stay as draped. Its result is then blended with the photo: broad light
// and fine texture from the model, colours and prints from the photo, so a print or a jean's wash isn't
// redrawn into something else.
//
// ComfyUI must be started with --enable-cors-header so this page may talk to it.

export const LOCAL_STUDIO = "http://127.0.0.1:8188"
const CHECKPOINT = "sd_xl_base_1.0.safetensors"
const CONTROLNET = "diffusion_pytorch_model_promax.safetensors"

// Whether the local studio is running (and has the models), within a moment.
export async function localStudioReady() {
  try {
    const r = await fetch(`${LOCAL_STUDIO}/object_info/CheckpointLoaderSimple`, { signal: AbortSignal.timeout(1500) })
    if (!r.ok) return false
    const info = await r.json()
    const names = info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]
    const list = Array.isArray(names) ? names : info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[1]?.options ?? []
    return list.includes(CHECKPOINT)
  } catch {
    return false
  }
}

// What's worn, in words the model knows: "a black sweatshirt with a printed picture on the front, light
// blue denim jeans".
export function describeOutfit(items) {
  const words = { tee: "t-shirt", longsleeve: "long-sleeve t-shirt", sweatshirt: "crewneck sweatshirt", hoodie: "hoodie", polo: "polo shirt", tank: "tank top", shirt: "button-up shirt", shortshirt: "short-sleeve button-up shirt", sweater: "knit sweater", shortknit: "short-sleeve knit sweater", cardigan: "cardigan", zip: "zip jacket", bomber: "bomber jacket", tailored: "tailored jacket", coat: "coat", dress: "dress", jeans: "jeans", trousers: "trousers", joggers: "joggers", shorts: "shorts", leggings: "leggings", skirt: "skirt", sneaker: "sneakers", hightop: "high-top sneakers", boot: "boots", loafer: "loafers", sandal: "sandals", crew: "crew socks", ankle: "ankle socks", knee: "knee socks", belt: "belt" }
  return items.map(({ garment }) => {
    const what = garment.style === "hoodie" && garment.zip ? "zip-up hoodie" : words[garment.style] ?? garment.style ?? "clothes"
    const cloth = garment.fabric && !["cotton", "jersey"].includes(garment.fabric) ? `${garment.fabric} ` : ""
    const colour = garment.color_name ? `${garment.color_name.toLowerCase()} ` : ""
    const print = garment.print ? " with a printed picture on the front" : ""
    return `${colour}${cloth}${what}${print}`
  }).join(", ")
}

// photo: a Blob of the 3D view. Returns a Blob of the finished picture. onProgress(fraction, words).
export async function studioLook(photo, outfit, { onProgress = () => {}, signal } = {}) {
  const image = await loadImage(photo)
  // About a million pixels, in multiples of 64, as SDXL likes.
  const k = Math.sqrt((1024 * 1024) / (image.width * image.height))
  const w = Math.round((image.width * k) / 64) * 64, h = Math.round((image.height * k) / 64) * 64

  onProgress(0, "Sending the photo to the studio on this computer…")
  const form = new FormData()
  form.append("image", photo, `fitroom-${Date.now()}.png`)
  form.append("overwrite", "true")
  const uploaded = await fetch(`${LOCAL_STUDIO}/upload/image`, { method: "POST", body: form, signal }).then(r => r.json())

  const prompt = `professional studio fashion photograph, white matte faceless mannequin, plain seamless studio backdrop, soft key light, realistic fabric texture, natural folds, sharp focus, product photo, wearing ${outfit}`
  const graph = {
    1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: CHECKPOINT } },
    2: { class_type: "LoadImage", inputs: { image: uploaded.name } },
    3: { class_type: "ImageScale", inputs: { image: ["2", 0], upscale_method: "lanczos", width: w, height: h, crop: "disabled" } },
    4: { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: prompt } },
    5: { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: "cartoon, 3d render, cgi, plastic, blurry, deformed, extra limbs, text, watermark, human face, skin" } },
    6: { class_type: "ControlNetLoader", inputs: { control_net_name: CONTROLNET } },
    7: { class_type: "SetUnionControlNetType", inputs: { control_net: ["6", 0], type: "tile" } },
    8: { class_type: "ControlNetApplyAdvanced", inputs: { positive: ["4", 0], negative: ["5", 0], control_net: ["7", 0], image: ["3", 0], strength: 0.7, start_percent: 0, end_percent: 0.8, vae: ["1", 2] } },
    9: { class_type: "VAEEncode", inputs: { pixels: ["3", 0], vae: ["1", 2] } },
    10: { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["8", 0], negative: ["8", 1], latent_image: ["9", 0], seed: 7, steps: 20, cfg: 6, sampler_name: "dpmpp_2m", scheduler: "karras", denoise: 0.35 } },
    11: { class_type: "VAEDecode", inputs: { samples: ["10", 0], vae: ["1", 2] } },
    12: { class_type: "SaveImage", inputs: { images: ["11", 0], filename_prefix: "fitroom_studio" } }
  }
  const queued = await fetch(`${LOCAL_STUDIO}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: graph }), signal }).then(r => r.json())
  if (!queued.prompt_id) throw new Error("The studio on this computer couldn't take that photo.")

  const began = Date.now()
  let result
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 2000))
    if (signal?.aborted) throw new DOMException("Stopped", "AbortError")
    const history = await fetch(`${LOCAL_STUDIO}/history/${queued.prompt_id}`, { signal }).then(r => r.json())
    const entry = history[queued.prompt_id]
    if (entry?.status?.status_str === "error") throw new Error("The studio on this computer couldn't finish that photo.")
    result = entry?.outputs?.["12"]?.images?.[0]
    if (result) break
    const seconds = Math.round((Date.now() - began) / 1000)
    onProgress(Math.min(seconds / 120, 0.95), `Finishing the photo on this computer… ${seconds}s (about 2 minutes)`)
  }
  const url = `${LOCAL_STUDIO}/view?${new URLSearchParams({ filename: result.filename, subfolder: result.subfolder ?? "", type: "output" })}`
  const painted = await loadImage(await fetch(url, { signal }).then(r => r.blob()))
  return keepDetails(image, painted)
}

// The photo's colours and prints, with the painted picture's light (broad) and texture (fine).
export function keepDetails(photo, painted) {
  const w = painted.width, h = painted.height
  const pixels = (img, blur = 0) => {
    const c = new OffscreenCanvas(w, h), g = c.getContext("2d")
    if (blur) g.filter = `blur(${blur}px)`
    g.drawImage(img, 0, 0, w, h)
    return g.getImageData(0, 0, w, h).data
  }
  const s = pixels(photo), s1 = pixels(photo, 1), s2 = pixels(photo, 2), s12 = pixels(photo, 12)
  const r = pixels(painted), r2 = pixels(painted, 2), r12 = pixels(painted, 12)
  const lum = (d, i) => (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255
  const out = new ImageData(w, h)
  for (let i = 0; i < out.data.length; i += 4) {
    const light = Math.min(Math.max((lum(r12, i) + 0.02) / (lum(s12, i) + 0.02), 0.6), 1.6)
    for (let c = 0; c < 3; c++) {
      out.data[i + c] = s1[i + c] * light + (r[i + c] - r2[i + c]) + 0.2 * (s[i + c] - s2[i + c])
    }
    out.data[i + 3] = 255
  }
  const canvas = new OffscreenCanvas(w, h)
  canvas.getContext("2d").putImageData(out, 0, 0)
  return canvas.convertToBlob({ type: "image/png" })
}

async function loadImage(blob) {
  return await createImageBitmap(blob)
}
