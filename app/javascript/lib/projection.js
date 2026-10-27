// Laying a picture back onto the 3D clothes from the camera that took it (see stage.js#wearPhoto): the AI
// paints the stores' clothes onto the page's photo of the mannequin, and that photo is then projected onto
// the draped garments, so turning the figure shows the AI's knit, print and zip on the front, blending back to
// the page's own fabric where the photo can't see. These are the pure parts of that, shared by the shader
// (the same formulas in GLSL, fabric.js's PROJECTION) and the page: where a point lands in the picture, how
// much of the picture a point gets (facing the camera, inside the frame, not hidden behind something nearer)
// and the picture's overall colour shift against the page's own photo, for tinting the back.

// The soft border inside the picture's edge (share of its width) where the picture fades out.
export const BORDER = 0.02
// How squarely a point must face the capture camera (cosine) to take the picture: none below `from`, all
// above `to`.
export const FACING = { from: 0.1, to: 0.45 }
// How far (m) behind what the capture camera saw a point may be and still count as seen: a cloth drawn a
// hair off its surface, and the depth picture's own steps.
export const DEPTH_BIAS = 0.012

// Taking the page's light out of the picture (the formulation the cloth uses, fabric.js's mode 2): the light at
// a point is the page's photo there over the cloth's own colour, per channel, or from the brightness alone where
// a channel is darker than `dark` (too little to divide by); it's kept between `min` and `max`.
export const LIGHT = { dark: 0.02, min: 0.15, max: 4 }
const LUMA = [0.2126, 0.7152, 0.0722]

// The cloth's colour from the picture at a point: picture, page (the page's own photo there) and albedo (the
// cloth's own colour), each linear RGB 0..1. Where the picture is the page's photo, the cloth's own colour.
export function pictureAlbedo(picture, page, albedo) {
  const a = albedo.map(c => Math.max(c, 0.002))
  const dot = v => v[0] * LUMA[0] + v[1] * LUMA[1] + v[2] * LUMA[2]
  const luma = dot(page) / Math.max(dot(a), 0.002)
  return picture.map((p, c) => {
    const w = smoothstep(LIGHT.dark, 2.5 * LIGHT.dark, a[c])
    const light = Math.min(LIGHT.max, Math.max(LIGHT.min, luma + (page[c] / a[c] - luma) * w))
    return Math.min(1, Math.max(0, p / light))
  })
}

// A world point through a view-projection matrix (16 numbers, column major as THREE.Matrix4.elements): its
// place in the picture (uv, 0..1 from the bottom left, as a texture is read), its depth (0 at the near
// plane, 1 at the far, as a depth buffer stores it) and whether it's in front of the camera.
export function projectPoint(vp, [x, y, z]) {
  const m = vp
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12]
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13]
  const cz = m[2] * x + m[6] * y + m[10] * z + m[14]
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15]
  if (cw <= 1e-9) return { uv: [0, 0], depth: 1, inFront: false }
  const ndc = [cx / cw, cy / cw, cz / cw]
  return { uv: ndcToUv(ndc), depth: ndc[2] * 0.5 + 0.5, inFront: true }
}

// Clip space (-1..1, y up) to texture space (0..1, from the bottom left).
export function ndcToUv([x, y]) {
  return [x * 0.5 + 0.5, y * 0.5 + 0.5]
}

// A depth buffer's value (0..1) as a distance from the camera (m), for a perspective camera's near and far.
export function linearDepth(depth, near, far) {
  return (2 * near * far) / (far + near - (2 * depth - 1) * (far - near))
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

// How much a point facing the camera by `cosine` (its normal against the direction back to the camera) takes
// the picture: 0 edge-on or facing away, 1 facing it squarely.
export function facingWeight(cosine) {
  return smoothstep(FACING.from, FACING.to, cosine)
}

// How much the fallback (the page's own cloth, where the picture doesn't reach) is tinted toward the
// picture's colour, so there's no line where the picture stops: full where the picture begins to take, fading
// out a little way round the side.
export function tintWeight(cosine) {
  return smoothstep(FACING.from - 0.25, FACING.from, cosine)
}

// How much a point at `uv` is inside the picture: 1 well inside, fading to 0 over the border at each edge.
export function insideWeight([u, v], border = BORDER) {
  return smoothstep(0, border, u) * smoothstep(0, border, 1 - u) * smoothstep(0, border, v) * smoothstep(0, border, 1 - v)
}

// How much a point `fragment` m from the camera is in view, when the camera saw `stored` m along that line:
// 1 when it's what the camera saw (within the bias), 0 when it's behind something nearer.
export function unoccludedWeight(fragment, stored, bias = DEPTH_BIAS) {
  return 1 - smoothstep(bias, 2 * bias, fragment - stored)
}

// The picture's colour against the page's own photo of the same view, over the figure (mask: 255 where it
// is): the mean of each over the figure, as a ratio per channel, clamped. Pixels are RGBA bytes, all the same
// size. Where the AI painted the clothes darker, the page's cloth where the picture can't reach is darkened
// the same, so the front and back agree.
export function meanRatio(picture, page, mask = null) {
  const sum = [0, 0, 0], base = [0, 0, 0]
  let count = 0
  for (let i = 0; i < picture.length; i += 4) {
    if (mask && mask[i] < 128) continue
    for (let c = 0; c < 3; c++) { sum[c] += picture[i + c]; base[c] += page[i + c] }
    count++
  }
  if (!count) return [1, 1, 1]
  return sum.map((s, c) => Math.min(2, Math.max(0.5, (s + 1) / (base[c] + 1))))
}

// The weight the picture gets at a point, from its parts.
export function pictureWeight({ facing, inside, unoccluded, on = 1 }) {
  return facing * inside * unoccluded * on
}
