// The vision service (script/server/vision.mjs), when the server has one: the page's two AI models on store
// photos (SlimSAM's masks, DINOv2's summary) run there instead of in this browser, several times faster and
// with nothing to download here. Its address comes from the page (a <meta name="fitroom-vision">, set from
// FITROOM_VISION_URL); without one, or when it doesn't answer, the browser does the work itself as before.
// Only store photos go to it, never a picture of the person.

let address
export function visionUrl() {
  if (address !== undefined) return address
  const meta = typeof document !== "undefined" ? document.querySelector('meta[name="fitroom-vision"]') : null
  address = meta?.content?.trim() || null
  return address
}

// Marks the service as down for this page after a failure, so later photos don't wait on it.
let down = false
export function visionDown() { return down }

async function call(path, payload, timeout) {
  const base = visionUrl()
  if (!base || down) return null
  try {
    const response = await fetch(`${base.replace(/\/$/, "")}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeout)
    })
    if (response.status >= 500 || response.status === 404) { down = true; return null }
    if (!response.ok) return null
    return await response.json()
  } catch {
    down = true
    return null
  }
}

function base64Of(bytes) {
  let s = ""
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function bytesOf(base64) {
  const s = atob(base64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

// SlimSAM's three masks for a photo (RGBA pixels, width × height) prompted with points, as segment.js takes
// them from the model: { bits: Uint8Array (3 × width × height), count: 3, scores }, or null.
export async function remoteMasks(data, width, height, points, { timeout = 15000 } = {}) {
  const result = await call("/clean", { width, height, rgba: base64Of(data instanceof Uint8Array ? data : new Uint8Array(data.buffer ?? data)), points }, timeout)
  if (!result?.masks?.length) return null
  const plane = width * height
  const bits = new Uint8Array(result.masks.length * plane)
  result.masks.forEach((mask, k) => bits.set(bytesOf(mask), k * plane))
  return { bits, count: result.masks.length, scores: result.scores }
}

// DINOv2's summary of a picture ({ data, width, height } RGBA): 384 numbers, or null.
export async function remoteEmbedding(pixels, { timeout = 10000 } = {}) {
  const result = await call("/embed", { width: pixels.width, height: pixels.height, rgba: base64Of(new Uint8Array(pixels.data.buffer ?? pixels.data)) }, timeout)
  return result?.embedding ?? null
}
