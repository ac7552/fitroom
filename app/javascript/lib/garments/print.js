// Reads a product photo for what the 3D view needs: the garment's own colour, and any print on its front (a
// graphic, a logo, lettering), cut out so it can be laid onto the draped cloth. Works on the usual shop
// photo: the garment, front on, on a plain background. Runs in the page; the photo goes nowhere.

const SIZE = 384   // the photo is read at about this many pixels across
const PRINT_SIZE = 720   // and its print at about this many (thin lettering is only a few pixels wide)

// Waits for an image to load. (Not image.decode(), which never settles while the tab is in the background.)
export function loaded(image) {
  return new Promise((resolve, reject) => {
    if (image.complete && image.naturalWidth) return resolve(image)
    image.addEventListener("load", () => resolve(image), { once: true })
    image.addEventListener("error", reject, { once: true })
  })
}

// src: an image URL (a data: URL from the import, or a local blob). shape: the garment's length over its
// front's width (from its chart), to find its hem when something else (trousers, a stand) shows below it.
// Returns { color: "#rrggbb", print } or null when the photo can't be read. print is null, or { image (a
// canvas: the front of the garment, collar to hem, with everything but the print transparent), coverage
// (share of the front that's print) }.
export async function readPhoto(src, { shape = null } = {}) {
  const image = new Image()
  image.src = src
  try { await loaded(image) } catch { return null }
  const read = (sx, sy, sw, sh) => {
    const scale = Math.min(1, PRINT_SIZE / Math.max(sw, sh))
    const w = Math.max(8, Math.round(sw * scale)), h = Math.max(8, Math.round(sh * scale))
    const canvas = document.createElement("canvas")
    canvas.width = w
    canvas.height = h
    const context = canvas.getContext("2d", { willReadFrequently: true })
    context.drawImage(image, sx, sy, sw, sh, 0, 0, w, h)
    const found = findPrint(context.getImageData(0, 0, w, h).data, w, h, shape)
    return found && { ...found, scale }
  }
  const W = image.naturalWidth, H = image.naturalHeight
  let found = read(0, 0, W, H)
  if (!found) return null
  // A garment shot small in a big frame: read again, closer, so a print's thin lettering isn't lost as specks.
  // The crop keeps a margin of backdrop all round (the reading needs it).
  const [x0, y0, x1, y1] = found.rect.map(v => v / found.scale)
  const across = (x1 - x0) * 2.4, cx = (x0 + x1) / 2, down = (y1 - y0) * 1.3
  if (across < W * 0.7 && Math.max(across, down) > PRINT_SIZE * 1.2) {
    const sx = Math.max(0, cx - across / 2), sy = Math.max(0, y0 - (y1 - y0) * 0.2)
    const closer = read(sx, sy, Math.min(W - sx, across), Math.min(H - sy, down))
    if (closer) found = closer
  }
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
  const { lab, bg, garment, far } = cut

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
    // Only what's nearer the backdrop's colour than the cloth's: an off-white cloth isn't backdrop, a soft
    // shadow round a black one is.
    const dl = Math.abs(lab[3 * i] - bg[0]), dc = Math.hypot(lab[3 * i + 1] - bg[1], lab[3 * i + 2] - bg[2])
    const toCloth = Math.hypot(lab[3 * i] - baseLab[0], lab[3 * i + 1] - baseLab[1], lab[3 * i + 2] - baseLab[2])
    return dl <= 18 && dc <= 12 && Math.hypot(dl, dc) < toCloth
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
  // Marks running off the front's sides or hem are its edge in the light (a sleeve's rim, the hem's fold),
  // not a print: a chest print sits inside the front. (An all-over print, which does reach them, is kept
  // whole below.)
  const before = alpha.reduce((sum, a) => sum + a, 0)
  const kept = Float32Array.from(alpha)
  const edgeMarks = []
  for (let y = 0; y < ph; y++) for (const x of [0, 1, pw - 2, pw - 1]) edgeMarks.push(y * pw + x)
  for (let x = 0; x < pw; x++) edgeMarks.push((ph - 1) * pw + x, (ph - 2) * pw + x)
  const seen = new Uint8Array(pw * ph)
  const marks = edgeMarks.filter(k => kept[k] > 0.2 && !seen[k] && (seen[k] = 1))
  while (marks.length) {
    const k = marks.pop(), x = k % pw
    kept[k] = 0
    for (const j of [x > 0 ? k - 1 : -1, x < pw - 1 ? k + 1 : -1, k - pw, k + pw]) {
      if (j < 0 || j >= pw * ph || seen[j] || kept[j] <= 0.2) continue
      seen[j] = 1
      marks.push(j)
    }
  }
  if (kept.reduce((sum, a) => sum + a, 0) > before * 0.4) alpha.set(kept)
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
  // How much the backdrop itself varies (its grain, a soft gradient): a flat studio backdrop is read
  // closely, so a white or cream garment on a light grey one isn't taken for backdrop.
  const spread = median(edge.map(i => Math.abs(lab[3 * i] - bg[0]) + Math.hypot(lab[3 * i + 1] - bg[1], lab[3 * i + 2] - bg[2])))
  const flat = spread < 0.6
  const far = flat ? [2.2, 2.6] : [6, 7]
  const like = i => Math.abs(lab[3 * i] - bg[0]) <= far[0] && Math.hypot(lab[3 * i + 1] - bg[1], lab[3 * i + 2] - bg[2]) <= far[1]
  // On a flat backdrop each step out also has to look like the pixel it came from, so the fill stops at the
  // garment's soft edge rather than seeping in.
  const step = (i, j) => !flat || Math.abs(lab[3 * i] - lab[3 * j]) <= 1.6 && Math.hypot(lab[3 * i + 1] - lab[3 * j + 1], lab[3 * i + 2] - lab[3 * j + 2]) <= 1.8
  const mask = new Uint8Array(w * h).fill(1)
  const stack = []
  for (const i of edge) if (mask[i] && like(i)) { mask[i] = 0; stack.push(i) }
  while (stack.length) {
    const i = stack.pop(), x = i % w
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
      if (j < 0 || j >= w * h || !mask[j] || !like(j) || !step(i, j)) continue
      mask[j] = 0
      stack.push(j)
    }
  }
  const garment = largestPiece(mask, w, h)
  if (garment.count < w * h * 0.05) return null
  return { lab, bg, garment, far }
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

// A top's shape in its photo, as shares of its front's width at the chest (so no size is needed):
// { length: shoulders to hem, waist: its width at the waist, hem: its width at the hem, sleeve: how far
// a sleeve reaches past the shoulder seam, along the arm }. Null when it can't be read. A shop that gives
// no chart still shows the garment: a baby tee is narrow at the waist and short in the sleeve, a boxy tee
// straight, whatever its listing's words say.
export async function readTopShape(src) {
  const pixels = await loadPixels(src)
  return pixels && measureTop(pixels.data, pixels.w, pixels.h)
}

export function measureTop(data, w, h) {
  const cut = cutOut(data, w, h)
  if (!cut) return null
  const on = (x, y) => cut.garment.mask[y * w + x] === 1
  let top = -1, bottom = -1, widest = 0
  const rowMin = new Int32Array(h).fill(w), rowMax = new Int32Array(h).fill(-1)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) if (on(x, y)) { rowMin[y] = Math.min(rowMin[y], x); rowMax[y] = Math.max(rowMax[y], x) }
    if (rowMax[y] >= 0) { if (top < 0) top = y; bottom = y }
    widest = Math.max(widest, rowMax[y] - rowMin[y])
  }
  if (top < 0) return null
  let shoulders = top
  while (shoulders < bottom && rowMax[shoulders] - rowMin[shoulders] < widest * 0.45) shoulders++
  const body = bottom - shoulders + 1
  const centre = Math.round(median(Array.from({ length: Math.max(1, Math.round(body * 0.05)) }, (_, k) => (rowMin[shoulders + k] + rowMax[shoulders + k]) / 2)))
  // The front's width through the middle at a height: it stops at a gap, so a sleeve hanging apart from
  // the body is left out (one sewn on beside it, a tee's, isn't).
  const across = y => {
    let a = centre, b = centre
    while (a > 0 && on(a - 1, y)) a--
    while (b < w - 1 && on(b + 1, y)) b++
    return b - a
  }
  const row = f => Math.min(bottom, Math.round(shoulders + body * f))
  const widthAt = (from, to) => median(Array.from({ length: row(to) - row(from) + 1 }, (_, k) => across(row(from) + k)))
  // The armpit: where the width drops most (the sleeves end there, or part from the body). The chest is
  // the width just below it.
  const step = Math.max(2, Math.round(body * 0.03))
  let armpit = -1, sharpest = 0
  for (let y = row(0.08); y <= row(0.6); y++) {
    const fall = across(y - step) - across(y + step)
    if (fall > sharpest) { sharpest = fall; armpit = y }
  }
  const chest = armpit >= 0 && sharpest > across(armpit + step) * 0.08
    ? median(Array.from({ length: Math.max(1, Math.round(body * 0.08)) }, (_, k) => across(Math.min(bottom, armpit + step + k))))
    : widthAt(0.3, 0.45)
  if (chest < w * 0.12) return null
  // A sleeve: the last row (down from the shoulders) wider than the chest, and how far out it reaches.
  const full = y => rowMax[y] - rowMin[y]
  let cuff = -1, outer = 0
  for (let y = shoulders; y <= bottom; y++) if (full(y) > chest * 1.08) { cuff = y; outer = Math.max(outer, (full(y) - chest) / 2) }
  const drop = cuff < 0 ? 0 : cuff - shoulders
  const at = f => across(row(f)) / chest
  return {
    length: body / chest, waist: median([0.6, 0.63, 0.66, 0.7].map(at)), hem: median([0.93, 0.95, 0.97].map(at)),
    sleeve: Math.hypot(drop, outer) / chest, sleeveDown: drop / body, armpit: armpit < 0 ? null : (armpit - shoulders) / body
  }
}

async function loadPixels(src) {
  const image = new Image()
  image.src = src
  try { await loaded(image) } catch { return null }
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
