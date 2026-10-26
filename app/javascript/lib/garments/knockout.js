// Takes the white (or near-white) background off a shop photo, so it can sit on a tile in the stage's own
// tone: the photo's corner colour is the backdrop, and every pixel near it in colour that touches the
// picture's edge (so a white print on the front stays) goes clear, with a soft edge a couple of pixels wide.

// imageData: { width, height, data } (an ImageData, or a plain object of the same shape; data is RGBA bytes).
// tolerance: how far from the corner colour a pixel may be and still count as backdrop (CIE76 ΔE; about 10
// takes a white sweep's shading and JPEG noise without eating a pale garment). feather: how wide the soft
// edge is, in pixels. Returns a new { width, height, data } with the backdrop's alpha at 0; the input is
// left as it was.
export function knockoutWhite(imageData, { tolerance = 10, feather = 2 } = {}) {
  const { width, height } = imageData
  const source = imageData.data
  const data = new Uint8ClampedArray(source)
  const out = { width, height, data }
  if (!width || !height) return out
  const key = cornerColor(imageData)
  // A backdrop only if it's pale: a photo on a dark or coloured ground is left whole.
  if (key.lab[0] < 70) return out

  // Which pixels are near the backdrop's colour, then only those joined to the picture's edge.
  const near = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    if (source[4 * i + 3] < 8) { near[i] = 1; continue }
    const lab = toLab(source[4 * i], source[4 * i + 1], source[4 * i + 2])
    if (deltaE(lab, key.lab) <= tolerance) near[i] = 1
  }
  const clear = floodFromEdge(near, width, height)

  // The soft edge: the kept mask, blurred a little, is the alpha.
  const keep = new Float32Array(width * height)
  for (let i = 0; i < keep.length; i++) keep[i] = clear[i] ? 0 : 1
  const alpha = feather > 0 ? boxBlur(keep, width, height, feather) : keep
  for (let i = 0; i < width * height; i++) data[4 * i + 3] = clear[i] ? 0 : Math.round(source[4 * i + 3] * alpha[i])
  return out
}

// The photo's backdrop colour: the average of small patches in its four corners, in Lab and sRGB.
export function cornerColor({ width, height, data }, patch = Math.max(1, Math.round(Math.min(width, height) * 0.02))) {
  let r = 0, g = 0, b = 0, n = 0
  for (const [x0, y0] of [[0, 0], [width - patch, 0], [0, height - patch], [width - patch, height - patch]]) {
    for (let y = y0; y < y0 + patch; y++) {
      for (let x = x0; x < x0 + patch; x++) {
        const i = 4 * (y * width + x)
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++
      }
    }
  }
  const rgb = [r / n, g / n, b / n]
  return { rgb, lab: toLab(...rgb) }
}

// sRGB bytes to CIE Lab (D65).
export function toLab(r, g, b) {
  const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  const R = lin(r), G = lin(g), B = lin(b)
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883
  const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const fx = f(x), fy = f(y), fz = f(z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

// CIE76 colour difference.
export function deltaE(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

// The pixels marked in `mask` that are joined (4-connected) to the picture's edge: 1 where so.
function floodFromEdge(mask, width, height) {
  const seen = new Uint8Array(width * height)
  const stack = []
  const push = i => { if (mask[i] && !seen[i]) { seen[i] = 1; stack.push(i) } }
  for (let x = 0; x < width; x++) { push(x); push((height - 1) * width + x) }
  for (let y = 0; y < height; y++) { push(y * width); push(y * width + width - 1) }
  while (stack.length) {
    const i = stack.pop()
    const x = i % width, y = (i - x) / width
    if (x > 0) push(i - 1)
    if (x < width - 1) push(i + 1)
    if (y > 0) push(i - width)
    if (y < height - 1) push(i + width)
  }
  return seen
}

// A separable box blur of radius `r` (pixels), edges clamped.
function boxBlur(values, width, height, r) {
  const pass = (src, w, h, stride, step) => {
    const dst = new Float32Array(src.length)
    for (let line = 0; line < h; line++) {
      for (let i = 0; i < w; i++) {
        let sum = 0
        for (let k = -r; k <= r; k++) {
          const j = Math.min(w - 1, Math.max(0, i + k))
          sum += src[line * stride + j * step]
        }
        dst[line * stride + i * step] = sum / (2 * r + 1)
      }
    }
    return dst
  }
  const across = pass(values, width, height, width, 1)
  return pass(across, height, width, 1, width)
}

// In the browser: the photo at `src` (a data: or blob: URL) with its backdrop knocked out, as a canvas, at
// most `size` pixels on its long side. Null if it can't be read.
export async function knockoutPhoto(src, { tolerance = 10, size = 320 } = {}) {
  try {
    const image = new Image()
    image.decoding = "async"
    image.src = src
    await image.decode()
    const scale = Math.min(1, size / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext("2d", { willReadFrequently: true })
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const cut = knockoutWhite(context.getImageData(0, 0, canvas.width, canvas.height), { tolerance })
    context.putImageData(new ImageData(cut.data, cut.width, cut.height), 0, 0)
    return canvas
  } catch {
    return null
  }
}
