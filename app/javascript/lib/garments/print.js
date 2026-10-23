// Reads a product photo for what the 3D view needs: the garment's own colour, and any print on its front (a
// graphic, a logo, lettering), cut out so it can be laid onto the draped cloth. Works on the usual shop
// photo: the garment, front on, on a plain background. Runs in the page; the photo goes nowhere.

const SIZE = 384   // the photo is read at about this many pixels across

// src: an image URL (a data: URL from the import, or a local blob). shape: the garment's length over its
// front's width (from its chart), to find its hem when something else (trousers, a stand) shows below it.
// Returns { color: "#rrggbb", print } or null when the photo can't be read. print is null, or { image (a
// canvas: the front of the garment, collar to hem, with everything but the print transparent), coverage
// (share of the front that's print) }.
export async function readPhoto(src, { shape = null } = {}) {
  const image = new Image()
  image.src = src
  try { await image.decode() } catch { return null }
  const scale = Math.min(1, SIZE / Math.max(image.naturalWidth, image.naturalHeight))
  const w = Math.max(8, Math.round(image.naturalWidth * scale)), h = Math.max(8, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement("canvas")
  canvas.width = w
  canvas.height = h
  const context = canvas.getContext("2d", { willReadFrequently: true })
  context.drawImage(image, 0, 0, w, h)
  const { data } = context.getImageData(0, 0, w, h)
  const found = findPrint(data, w, h, shape)
  if (!found) return null
  let print = null
  if (found.print) {
    const out = document.createElement("canvas")
    out.width = found.print.width
    out.height = found.print.height
    out.getContext("2d").putImageData(new ImageData(found.print.data, found.print.width, found.print.height), 0, 0)
    print = { image: out, coverage: found.print.coverage }
  }
  return { color: found.color, print }
}

// The same on raw RGBA pixels (so it can be tested without a browser). Returns { color, print: { data,
// width, height, coverage } | null } or null when no garment stands out from the background.
export function findPrint(data, w, h, shape = null) {
  const cut = cutOut(data, w, h)
  if (!cut) return null
  const { lab, bg, garment } = cut

  // Its rows from the collar to the hem, and the torso: as wide as the garment is near its hem (the sleeves
  // stick out higher up), centred where it is there.
  let top = h, bottom = -1, widest = 0
  const rowMin = new Int32Array(h).fill(w), rowMax = new Int32Array(h).fill(-1)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!garment.mask[y * w + x]) continue
      rowMin[y] = Math.min(rowMin[y], x); rowMax[y] = Math.max(rowMax[y], x)
      bottom = Math.max(bottom, y)
    }
    widest = Math.max(widest, rowMax[y] - rowMin[y])
  }
  // The shoulders: the first row nearly as wide as the garment gets (above it, a hanger, a stand's neck or
  // a mannequin's head).
  for (let y = 0; y < h && top === h; y++) if (rowMax[y] - rowMin[y] >= widest * 0.45) top = y
  let tall = bottom - top + 1
  // The torso: at chest height, the stretch of garment through the middle of the collar (sleeves sticking
  // out are part of it only where they touch; the median over many rows leaves them out).
  const collar = []
  for (let y = top; y <= top + tall * 0.05; y++) if (rowMax[y] >= rowMin[y]) collar.push((rowMin[y] + rowMax[y]) / 2)
  if (!collar.length) return null
  const centre = Math.round(median(collar))
  const runs = []
  for (let y = Math.round(top + widest * 0.3); y <= Math.min(bottom, top + widest * 0.6); y++) {
    // Small gaps (a zip's shine, a button) don't end the stretch.
    const gap = Math.max(2, Math.round(w * 0.03))
    const inside = x => { for (let k = 0; k <= gap; k++) if (garment.mask[y * w + Math.min(w - 1, Math.max(0, x + k * Math.sign(x - centre || 1)))]) return true; return false }
    let a = centre, b = centre
    while (a > 0 && inside(a - 1)) a--
    while (b < w - 1 && inside(b + 1)) b++
    runs.push([a, b])
  }
  if (runs.length < 3) return null
  let x0 = Math.round(median(runs.map(r => r[0]))), x1 = Math.round(median(runs.map(r => r[1])))
  if (x1 - x0 < w * 0.15) return null
  // The hem, from the garment's shape, when its chart gives one.
  // Something else showing below it (trousers on a mannequin) makes it look far too long for its chart.
  if (shape && bottom - top > (x1 - x0) * shape * 1.45) {
    bottom = Math.round(top + (x1 - x0) * shape)
    tall = bottom - top + 1
  } else if (shape && x1 - x0 > (tall / shape) * 1.12) {
    // Sleeves hanging against the body (a dropped shoulder) make it look far too wide for its chart:
    // the body is as wide as its chart says, about the collar's middle.
    const half = tall / shape / 2
    x0 = Math.max(0, Math.round(centre - half))
    x1 = Math.min(w - 1, Math.round(centre + half))
  }

  // The cloth's colour: the commonest colour over the middle of the torso.
  const bins = new Map()
  const inset = Math.round((x1 - x0) * 0.15)
  for (let y = Math.round(top + tall * 0.1); y <= bottom - tall * 0.1; y++) {
    for (let x = x0 + inset; x <= x1 - inset; x++) {
      const i = y * w + x
      if (!garment.mask[i]) continue
      const key = (data[4 * i] >> 4) << 8 | (data[4 * i + 1] >> 4) << 4 | (data[4 * i + 2] >> 4)
      const bin = bins.get(key) ?? [0, 0, 0, 0]
      bin[0] += data[4 * i]; bin[1] += data[4 * i + 1]; bin[2] += data[4 * i + 2]; bin[3]++
      bins.set(key, bin)
    }
  }
  const [r, g, b, n] = [...bins.values()].sort((p, q) => q[3] - p[3])[0]
  const base = [r / n, g / n, b / n]
  const baseLab = new Float32Array(3)
  toLab(base[0], base[1], base[2], baseLab, 0)
  const color = "#" + base.map(v => Math.round(v).toString(16).padStart(2, "0")).join("")

  // The print: torso pixels far from the cloth's colour (a fold's shadow changes lightness a little; a
  // print changes it a lot, or changes the colour).
  const pw = x1 - x0 + 1, ph = tall
  const alpha = new Float32Array(pw * ph)
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const i = (top + y) * w + x0 + x
      if (!garment.mask[i]) continue
      const dl = Math.abs(lab[3 * i] - baseLab[0]), dc = Math.hypot(lab[3 * i + 1] - baseLab[1], lab[3 * i + 2] - baseLab[2])
      alpha[y * pw + x] = Math.min(1, Math.max(smooth(dl, 22, 34), smooth(dc, 16, 26)))
    }
  }
  // Background showing between a sleeve and the body (cut off from the photo's edge, so not found above)
  // reaches the front's sides or hem: background-like there, it's background. A light print in the middle
  // of the front doesn't.
  const gap = new Uint8Array(pw * ph)
  const near = k => {
    const i = (top + Math.floor(k / pw)) * w + x0 + (k % pw)
    return Math.abs(lab[3 * i] - bg[0]) <= 18 && Math.hypot(lab[3 * i + 1] - bg[1], lab[3 * i + 2] - bg[2]) <= 12
  }
  const edgeStack = []
  for (let y = 0; y < ph; y++) for (const x of [0, pw - 1]) edgeStack.push(y * pw + x)
  for (let x = 0; x < pw; x++) edgeStack.push((ph - 1) * pw + x)
  for (const k of edgeStack) if (!gap[k] && near(k)) gap[k] = 1
  const flood = edgeStack.filter(k => gap[k])
  while (flood.length) {
    const k = flood.pop(), x = k % pw
    for (const j of [x > 0 ? k - 1 : -1, x < pw - 1 ? k + 1 : -1, k - pw, k + pw]) {
      if (j < 0 || j >= pw * ph || gap[j] || !near(j)) continue
      gap[j] = 1
      flood.push(j)
    }
  }
  // And the soft edge round it, and the hem's edge (its light rim is the photo's lighting, not a print).
  const grown = boxBlur(Float32Array.from(gap), pw, ph, 2)
  const hem = ph - Math.max(2, Math.round(ph * 0.03))
  for (let k = 0; k < pw * ph; k++) if (grown[k] > 0 || k >= hem * pw) { alpha[k] = 0; gap[k] = 1 }

  // Keep only solid areas: specks and the photo's own seams and folds are thin.
  const solid = boxBlur(alpha, pw, ph, 2)
  let covered = 0
  const out = new Uint8ClampedArray(4 * pw * ph)
  for (let k = 0; k < pw * ph; k++) {
    const a = alpha[k] * smooth(solid[k], 0.3, 0.55)
    const i = (top + Math.floor(k / pw)) * w + x0 + (k % pw)
    out[4 * k] = data[4 * i]; out[4 * k + 1] = data[4 * i + 1]; out[4 * k + 2] = data[4 * i + 2]
    out[4 * k + 3] = Math.round(a * 255)
    covered += a
  }
  const coverage = covered / (pw * ph)
  // An all-over print: the whole front, as photographed.
  if (coverage > 0.25) {
    for (let k = 0; k < pw * ph; k++) out[4 * k + 3] = !gap[k] && garment.mask[(top + Math.floor(k / pw)) * w + x0 + (k % pw)] ? 255 : 0
  }
  const print = coverage > 0.01 ? { data: out, width: pw, height: ph, coverage } : null
  return { color, print, rect: [x0, top, x1, bottom] }
}

// The garment in a photo: each pixel's Lab colour, the background's colour (the median round the photo's
// edge), and the garment as the largest piece of what isn't background joined to the edge (so a white print
// in the middle of the garment stays garment). Null when no garment stands out.
function cutOut(data, w, h) {
  const lab = new Float32Array(3 * w * h)
  for (let i = 0; i < w * h; i++) toLab(data[4 * i], data[4 * i + 1], data[4 * i + 2], lab, 3 * i)
  const edge = []
  for (let x = 0; x < w; x++) edge.push(x, (h - 1) * w + x)
  for (let y = 0; y < h; y++) edge.push(y * w, y * w + w - 1)
  const bg = [0, 1, 2].map(c => median(edge.map(i => lab[3 * i + c])))
  const like = i => Math.abs(lab[3 * i] - bg[0]) <= 6 && Math.hypot(lab[3 * i + 1] - bg[1], lab[3 * i + 2] - bg[2]) <= 7
  const mask = new Uint8Array(w * h).fill(1)
  const stack = []
  for (const i of edge) if (mask[i] && like(i)) { mask[i] = 0; stack.push(i) }
  while (stack.length) {
    const i = stack.pop(), x = i % w
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
      if (j < 0 || j >= w * h || !mask[j] || !like(j)) continue
      mask[j] = 0
      stack.push(j)
    }
  }
  const garment = largestPiece(mask, w, h)
  if (garment.count < w * h * 0.05) return null
  return { lab, bg, garment }
}

// What a photo of one piece of clothing shows, from its outline: { kind: "top", "jacket" or "trousers",
// style (a top's "tee", "longsleeve", "sweatshirt", "hoodie", "dress" or "dress_long"; a jacket's "zip") }, or null when it can't
// be read. For the usual shop photo or a picture of clothes laid flat or on a hanger, on a plain background.
export async function readGarment(src) {
  const pixels = await loadPixels(src)
  return pixels && guessGarment(pixels.data, pixels.w, pixels.h)
}

export function guessGarment(data, w, h) {
  const cut = cutOut(data, w, h)
  if (!cut) return null
  const { lab, garment } = cut
  const on = (x, y) => garment.mask[y * w + x] === 1
  let top = -1, bottom = -1, widest = 0
  const rowMin = new Int32Array(h).fill(w), rowMax = new Int32Array(h).fill(-1), pieces = new Int32Array(h)
  const gap = Math.max(2, Math.round(w * 0.03))
  for (let y = 0; y < h; y++) {
    let run = 0, off = gap
    for (let x = 0; x < w; x++) {
      if (on(x, y)) {
        if (off >= gap) run++
        off = 0
        rowMin[y] = Math.min(rowMin[y], x); rowMax[y] = Math.max(rowMax[y], x)
      } else off++
    }
    pieces[y] = run
    if (run) { if (top < 0) top = y; bottom = y }
    widest = Math.max(widest, rowMax[y] - rowMin[y])
  }
  const tall = bottom - top + 1
  if (tall < h * 0.2) return null
  const share = (from, to, test) => {
    let n = 0, all = 0
    for (let y = Math.round(top + tall * from); y <= Math.round(top + tall * to); y++) { all++; if (test(y)) n++ }
    return all ? n / all : 0
  }

  // Pants: two legs below, one piece at the waist, and nothing sticking out at the sides up top.
  if (share(0.65, 0.95, y => pieces[y] === 2) > 0.6 && share(0.0, 0.2, y => pieces[y] === 1) > 0.8) {
    const waist = median(Array.from({ length: Math.max(1, Math.round(tall * 0.1)) }, (_, k) => rowMax[top + k] - rowMin[top + k]))
    if (waist < widest * 0.9 || share(0.0, 0.3, y => rowMax[y] - rowMin[y] > waist * 1.25) < 0.2) return { kind: "trousers", style: null }
  }

  // A top or jacket. Its shoulders: the first row nearly as wide as it gets (above, a hanger or a hood).
  let shoulders = top
  while (shoulders < bottom && rowMax[shoulders] - rowMin[shoulders] < widest * 0.45) shoulders++
  const body = bottom - shoulders + 1
  // The torso, at chest height, through the middle of the collar.
  const centre = Math.round(median(Array.from({ length: Math.max(1, Math.round(body * 0.05)) }, (_, k) => (rowMin[shoulders + k] + rowMax[shoulders + k]) / 2)))
  const runs = []
  for (let y = Math.round(shoulders + body * 0.25); y <= Math.round(shoulders + body * 0.5); y++) {
    let a = centre, b = centre
    while (a > 0 && on(a - 1, y)) a--
    while (b < w - 1 && on(b + 1, y)) b++
    runs.push([a, b])
  }
  const x0 = median(runs.map(r => r[0])), x1 = median(runs.map(r => r[1])), torso = x1 - x0
  // Sleeves: what's beside the torso, and how far down it reaches.
  const margin = Math.max(2, Math.round(torso * 0.04))
  let cuff = -1
  for (let y = shoulders; y <= bottom; y++) if (rowMin[y] < x0 - margin || rowMax[y] > x1 + margin) cuff = y
  const sleeves = cuff < 0 ? 0 : (cuff - shoulders) / body
  // A hood: something about as wide as a head above the shoulders (a hanger's hook is much thinner).
  const hood = shoulders - top > body * 0.08 &&
    share(0, (shoulders - top) / tall * 0.8, y => rowMax[y] - rowMin[y] > torso * 0.22 && rowMax[y] - rowMin[y] < torso * 0.8) > 0.6
  // An opening down the front (a zip or buttons): a thin line at the middle, different from the cloth, top to bottom.
  const base = [0, 1, 2].map(c => median(runs.flatMap(([a, b], k) => {
    const y = Math.round(shoulders + body * 0.25) + k, out = []
    for (let x = Math.round(a + (b - a) * 0.15); x < b - (b - a) * 0.15; x += 3) out.push(lab[3 * (y * w + x) + c])
    return out
  })))
  const strip = Math.max(1, Math.round(torso * 0.02))
  const opening = share(0.12, 0.9, y => {
    const yy = Math.round(y)
    for (let x = centre - strip; x <= centre + strip; x++) {
      const i = 3 * (yy * w + x)
      if (Math.abs(lab[i] - base[0]) > 14 || Math.hypot(lab[i + 1] - base[1], lab[i + 2] - base[2]) > 12) return true
    }
    return false
  }) > 0.85
  // A dress: far longer than it is wide, its sleeves (if any) long when they reach past the waist.
  if (body > torso * 1.75) return { kind: "top", style: cuff - shoulders > torso * 1.05 ? "dress_long" : "dress" }
  if (opening && sleeves > 0.5) return { kind: "jacket", style: "zip" }
  if (hood) return { kind: "top", style: "hoodie" }
  if (sleeves > 0 && sleeves < 0.45) return { kind: "top", style: "tee" }
  // Long sleeves: a sweatshirt's hem is gathered by its rib, narrower than its body.
  const hem = median(Array.from({ length: Math.max(1, Math.round(body * 0.03)) }, (_, k) => {
    const y = bottom - k
    let a = centre, b = centre
    while (a > 0 && on(a - 1, y)) a--
    while (b < w - 1 && on(b + 1, y)) b++
    return b - a
  }))
  return { kind: "top", style: hem < torso * 0.94 ? "sweatshirt" : "longsleeve" }
}

async function loadPixels(src) {
  const image = new Image()
  image.src = src
  try { await image.decode() } catch { return null }
  const scale = Math.min(1, SIZE / Math.max(image.naturalWidth, image.naturalHeight))
  const w = Math.max(8, Math.round(image.naturalWidth * scale)), h = Math.max(8, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement("canvas")
  canvas.width = w
  canvas.height = h
  const context = canvas.getContext("2d", { willReadFrequently: true })
  context.drawImage(image, 0, 0, w, h)
  return { data: context.getImageData(0, 0, w, h).data, w, h }
}

function smooth(value, from, to) {
  const t = Math.min(Math.max((value - from) / (to - from), 0), 1)
  return t * t * (3 - 2 * t)
}

function median(values) {
  const sorted = Float64Array.from(values).sort()
  return sorted[sorted.length >> 1]
}

// sRGB (0–255) to CIE Lab, into out at offset.
function toLab(r, g, b, out, at) {
  const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  const R = lin(r), G = lin(g), B = lin(b)
  const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const X = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.9505), Y = f(R * 0.2126 + G * 0.7152 + B * 0.0722), Z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.089)
  out[at] = 116 * Y - 16
  out[at + 1] = 500 * (X - Y)
  out[at + 2] = 200 * (Y - Z)
}

// The largest 4-connected piece of a mask: { mask, count }.
function largestPiece(mask, w, h) {
  const label = new Int32Array(w * h)
  const stack = new Int32Array(w * h)
  let best = 0, bestCount = 0, next = 0
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || label[start]) continue
    next++
    let count = 0, top = 0
    stack[top++] = start
    label[start] = next
    while (top) {
      const i = stack[--top]
      count++
      const x = i % w
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= w * h || !mask[j] || label[j]) continue
        label[j] = next
        stack[top++] = j
      }
    }
    if (count > bestCount) { bestCount = count; best = next }
  }
  return { mask: Uint8Array.from(label, l => (l === best ? 1 : 0)), count: bestCount }
}

function boxBlur(values, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0
      for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < w) { s += values[y * w + xx]; n++ } }
      tmp[y * w + x] = s / n
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0
      for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < h) { s += tmp[yy * w + x]; n++ } }
      out[y * w + x] = s / n
    }
  }
  return out
}
