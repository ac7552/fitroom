// The shop's close-up of the cloth as the fabric itself. A close-up shows the real yarn, the heather's
// speckle, a denim's wash; laid on the cloth it has to repeat, and a repeated photo shows its seams and its
// grid. So it's laid on by tiling and blending (Burley 2019, after Heitz and Neyret 2018): each point of the
// cloth lies in a triangle of a lattice of offsets, and takes the photo three times, once per corner, each
// time shifted by a random offset for that corner, blended with weights whose squares sum to one about the
// mean colour, so the blend keeps the photo's contrast (a plain average would wash it out to grey where the
// three taps disagree). A photo prepared this way shows no repeat at any scale.
//
// What's prepared here: the close-up with its lighting evened out (a close-up is lit from one side, and its
// cloth lies in soft folds: divided by a blur of itself, so only the cloth's own texture is left, about the
// photo's mean), its mean colour, and its scale: the yarn pitch by autocorrelation (the first peak beyond the
// centre), which gives the photo's size in cm on the cloth from the fabric's known yarn pitch; with no clear
// peak, a default.
import * as THREE from "three"
import { yarnPitch } from "lib/garments/yarn"
export { yarnPitch }

// Yarn pitch per surface (mm): how far apart the knit's wales or the weave's threads are, which sets the
// close-up's scale when its own pitch can be read.
const YARN_MM = { jersey: 0.9, fleece: 1.1, rib: 1.4, twill: 0.7, denim: 0.8, plain: 0.5, fine: 0.4, knit: 2.2, grain: 1, ripstop: 1.2, felt: 1, smooth: 0.5 }
// The photo's width on the cloth when its pitch can't be read (cm): Kith's close-ups are about 8 to 12 cm.
const DEFAULT_WIDTH_CM = 10
// The close-up's working size (texels square).
const SIZE = 512

// src: the close-up (a URL or data URL); surface: fabric.js's surface name. Resolves to { texture (a
// CanvasTexture of the evened cloth, repeating), mean ([r, g, b], 0 to 1, sRGB), widthCm }, or null when the
// photo can't be read.
export async function prepareCloseup(src, surface = "jersey") {
  const image = await new Promise((resolve, reject) => { const img = new Image(); img.crossOrigin = "anonymous"; img.onload = () => resolve(img); img.onerror = reject; img.src = src }).catch(() => null)
  if (!image) return null
  // The middle square of the photo, at the working size.
  const side = Math.min(image.naturalWidth, image.naturalHeight)
  const sx = (image.naturalWidth - side) / 2, sy = (image.naturalHeight - side) / 2
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = SIZE
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  ctx.drawImage(image, sx, sy, side, side, 0, 0, SIZE, SIZE)
  const pixels = ctx.getImageData(0, 0, SIZE, SIZE)
  const { data } = pixels
  // Lighting evened: each channel divided by its blur (a box blur, three passes, of a thirty-second of the
  // photo: wider than the yarn and the heather's speckle, which stay; narrow enough to follow a fold's
  // shading, which a wider one leaves in as bands across the cloth: Kith's Armani close-up's soft folds stayed
  // at two-thirds of their contrast at a twelfth), scaled back to the photo's mean.
  const n = SIZE * SIZE
  const mean = [0, 0, 0]
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) mean[c] += data[4 * i + c]
  for (let c = 0; c < 3; c++) mean[c] /= n
  const radius = Math.round(SIZE / 32)
  for (let c = 0; c < 3; c++) {
    const channel = new Float32Array(n)
    for (let i = 0; i < n; i++) channel[i] = data[4 * i + c]
    const blurred = boxBlur3(channel, SIZE, SIZE, radius)
    for (let i = 0; i < n; i++) data[4 * i + c] = Math.max(0, Math.min(255, Math.round((channel[i] / Math.max(1, blurred[i])) * mean[c])))
  }
  ctx.putImageData(pixels, 0, 0)
  // The mean of the evened photo (what the shader divides by): close to the photo's, not the same.
  mean.fill(0)
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) mean[c] += data[4 * i + c]
  for (let c = 0; c < 3; c++) mean[c] /= n
  // The yarn pitch (pixels) along x, by autocorrelation of the luminance over the middle rows.
  const pitchPx = yarnPitch(data, SIZE)
  const yarnMm = YARN_MM[surface] ?? 1
  // The photo's width on the cloth: its pixels per yarn times the yarn's size; held within reason.
  let widthCm = pitchPx ? (SIZE / pitchPx) * yarnMm / 10 : DEFAULT_WIDTH_CM
  widthCm = Math.min(30, Math.max(4, widthCm))
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.anisotropy = 8
  // The mean in linear light, as the shader reads the texture (sRGB textures are converted on sampling):
  // the mean of the converted values, not the converted mean.
  const linear = [0, 0, 0]
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) linear[c] += toLinear(data[4 * i + c] / 255)
  return { texture, mean: linear.map(v => v / n), widthCm, pitchPx }
}

// Three passes of a box blur (about a Gaussian), in place of a new array.
function boxBlur3(src, w, h, r) {
  let a = Float32Array.from(src), b = new Float32Array(src.length)
  for (let pass = 0; pass < 3; pass++) {
    // Across.
    for (let y = 0; y < h; y++) {
      let sum = 0
      for (let x = -r; x <= r; x++) sum += a[y * w + Math.min(w - 1, Math.max(0, x))]
      for (let x = 0; x < w; x++) {
        b[y * w + x] = sum / (2 * r + 1)
        sum += a[y * w + Math.min(w - 1, x + r + 1)] - a[y * w + Math.max(0, x - r)]
      }
    }
    // Down.
    for (let x = 0; x < w; x++) {
      let sum = 0
      for (let y = -r; y <= r; y++) sum += b[Math.min(h - 1, Math.max(0, y)) * w + x]
      for (let y = 0; y < h; y++) {
        a[y * w + x] = sum / (2 * r + 1)
        sum += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x]
      }
    }
  }
  return a
}

function toLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
