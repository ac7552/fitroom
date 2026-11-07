// For render.mjs --script: the depth model on a shoe's side photo. ?photo=URL. Returns the model's timing and a
// small PNG of the depth (data URL) beside the cut-out, to look at.
export default async function () {
  const P = new URL(import.meta.url).searchParams
  const photo = P.get("photo") ?? "/tmp/kith/ugg1178990/ugg1178990-1.jpg"
  const { readDepth } = await import("lib/garments/depth")
  const print = window.print
  const image = await print.loadImage(photo)
  const w = 518, h = Math.round((image.naturalHeight / image.naturalWidth) * 518 / 14) * 14
  const canvas = document.createElement("canvas")
  canvas.width = w; canvas.height = h
  canvas.getContext("2d").drawImage(image, 0, 0, w, h)
  const t0 = performance.now()
  const depth = await readDepth(canvas)
  const ms = Math.round(performance.now() - t0)
  if (!depth) return { ms, depth: null }
  const t1 = performance.now()
  const again = await readDepth(canvas)
  const ms2 = Math.round(performance.now() - t1)
  // A picture of it: the photo on the left, the depth on the right.
  const out = document.createElement("canvas")
  out.width = w * 2; out.height = h
  const c = out.getContext("2d")
  c.drawImage(canvas, 0, 0)
  const img = c.createImageData(depth.w, depth.h)
  for (let i = 0; i < depth.w * depth.h; i++) { const v = Math.round(depth.data[i] * 255); img.data[4 * i] = v; img.data[4 * i + 1] = v; img.data[4 * i + 2] = v; img.data[4 * i + 3] = 255 }
  const tmp = document.createElement("canvas"); tmp.width = depth.w; tmp.height = depth.h; tmp.getContext("2d").putImageData(img, 0, 0)
  c.drawImage(tmp, w, 0, w, h)
  return { ms, ms2, size: [depth.w, depth.h], again: Boolean(again), png: out.toDataURL("image/png") }
}
