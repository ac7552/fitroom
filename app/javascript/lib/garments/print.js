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
    print = { image: out, coverage: found.print.coverage, tile: found.print.allOver ? allOverTile(found.print) : null }
  }
  return { color: found.color, print }
}

// An all-over print's cloth: a piece of the front clear of the collar, the buttons down the middle, the
// chest pocket and the hem (the photo's left side, the wearer's right), to repeat over the other pieces.
// Its size (across, down) and where it starts below the shoulders (from) are in front widths.
function allOverTile(print) {
  const { width: pw, height: ph, data } = print
  const x0 = Math.round(pw * 0.06), x1 = Math.round(pw * 0.44), y0 = Math.round(ph * 0.3), y1 = Math.round(ph * 0.92)
  const tile = document.createElement("canvas")
  tile.width = x1 - x0
  tile.height = y1 - y0
  const pixels = new ImageData(tile.width, tile.height)
  for (let y = 0; y < tile.height; y++) {
    for (let x = 0; x < tile.width; x++) {
      const from = 4 * ((y0 + y) * pw + x0 + x), to = 4 * (y * tile.width + x)
      pixels.data[to] = data[from]; pixels.data[to + 1] = data[from + 1]; pixels.data[to + 2] = data[from + 2]; pixels.data[to + 3] = 255
    }
  }
  tile.getContext("2d").putImageData(pixels, 0, 0)
  return { image: tile, across: (x1 - x0) / pw, down: (y1 - y0) / pw, from: y0 / pw }
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
  dropStreaks(alpha, pw, ph)
  const solid = boxBlur(alpha, pw, ph, 2)
  for (let k = 0; k < pw * ph; k++) alpha[k] *= smooth(solid[k], 0.3, 0.55)
  // A print is laid whole: its marks, and what's between them (a photo print's shadows, the gaps in its
  // lettering), with a soft edge. Cut out mark by mark, a photo print fading into a dark cloth falls apart
  // into specks.
  const whole = printAreas(alpha, gap, pw, ph)
  let covered = 0
  const out = new Uint8ClampedArray(4 * pw * ph)
  for (let k = 0; k < pw * ph; k++) {
    const a = Math.max(alpha[k], whole[k])
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
  const print = coverage > 0.01 ? { data: out, width: pw, height: ph, coverage, allOver: coverage > 0.25 } : null
  return { color, print, rect: [x0, top, x1, bottom] }
}

// The areas a print covers (0 to 1, soft at the edge): its marks joined up across small gaps (a closing:
// grown by a few per cent of the front's width, then shrunk back), leaving out what's background (gap).
// Specks far from any other mark stay specks, and are dropped.
function printAreas(alpha, gap, w, h) {
  const r = Math.max(2, Math.round(Math.max(w, h) * 0.035))
  const marks = Float32Array.from(alpha, a => (a > 0.3 ? 1 : 0))
  const grown = boxBlur(marks, w, h, r).map(v => (v > 0.001 ? 1 : 0))
  const closed = boxBlur(grown, w, h, r).map(v => (v > 0.999 ? 1 : 0))
  // Pieces of it too small to be a print on their own (a fleck, a stray highlight).
  const seen = new Uint8Array(w * h), stack = []
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || !closed[start]) continue
    const piece = [start]
    seen[start] = 1; stack.push(start)
    while (stack.length) {
      const k = stack.pop(), x = k % w
      for (const j of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, k - w, k + w]) {
        if (j < 0 || j >= w * h || seen[j] || !closed[j]) continue
        seen[j] = 1; stack.push(j); piece.push(j)
      }
    }
    if (piece.length < w * h * 0.002) for (const k of piece) closed[k] = 0
  }
  for (let k = 0; k < w * h; k++) if (gap[k]) closed[k] = 0
  const soft = boxBlur(closed, w, h, Math.max(1, Math.round(r / 3)))
  return soft.map((v, k) => (gap[k] ? 0 : smooth(v, 0.1, 0.9)))
}

// Long, thin marks aren't a print: a hem's fold catching the light runs across the front in a line, and the
// shadow between a sleeve and the body runs down its side. Each mark (8-connected) much longer than it is
// thick, across or down, is cleared. Several running the same way down most of the front are a striped
// cloth, though, and stay.
function dropStreaks(alpha, w, h) {
  const seen = new Uint8Array(w * h)
  const stack = [], streaks = []
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || alpha[start] <= 0.2) continue
    stack.push(start); seen[start] = 1
    const piece = []
    let x0 = w, x1 = -1, y0 = h, y1 = -1
    while (stack.length) {
      const k = stack.pop(), x = k % w, y = (k - x) / w
      piece.push(k)
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
        const j = yy * w + xx
        if (!seen[j] && alpha[j] > 0.2) { seen[j] = 1; stack.push(j) }
      }
    }
    const across = x1 - x0 + 1, down = y1 - y0 + 1
    // How thick it is: its area over its length (across and down, so a line that turns a corner counts too).
    const thick = piece.length / (across + down)
    const streak = (across >= w * 0.2 || down >= h * 0.15) && thick <= Math.max(2, 0.02 * Math.max(w, h))
    if (streak) streaks.push({ piece, stripe: down >= h * 0.4 && across <= w * 0.08 })
  }
  const stripes = streaks.filter(s => s.stripe).length >= 3
  for (const { piece, stripe } of streaks) if (!(stripes && stripe)) for (const k of piece) alpha[k] = 0
}

// Where to point a segmentation model at the garment in a photo (see segment.js): a few points well inside
// the garment as the backdrop cut finds it, in pixels. A top: down its middle, across the chest and the
// waist. Bottoms: the waistband's middle and each leg's middle, a third and two thirds down. Also the cut's
// mask and backdrop colour, for painting out what the model says isn't the garment. Null when no garment
// stands out from the backdrop.
export function promptPoints(data, w, h, kind = "top") {
  const cut = cutOut(data, w, h)
  if (!cut) return null
  const { mask } = cut.garment
  let top = h, bottom = -1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { top = Math.min(top, y); bottom = Math.max(bottom, y) }
  const tall = bottom - top
  // The middle of the garment's run of pixels nearest the given x along row y (or the row's widest run).
  const runAt = (y, near) => {
    const runs = []
    let start = -1
    for (let x = 0; x <= w; x++) {
      const on = x < w && mask[y * w + x]
      if (on && start < 0) start = x
      if (!on && start >= 0) { runs.push([start, x - 1]); start = -1 }
    }
    if (!runs.length) return null
    const pick = near === undefined ? runs.sort((a, b) => b[1] - b[0] - (a[1] - a[0]))[0]
      : runs.sort((a, b) => Math.abs((a[0] + a[1]) / 2 - near) - Math.abs((b[0] + b[1]) / 2 - near))[0]
    return [(pick[0] + pick[1]) / 2, pick[1] - pick[0]]
  }
  const points = []
  if (kind === "trousers") {
    const waist = runAt(Math.round(top + tall * 0.06))
    if (waist) points.push([waist[0], top + tall * 0.06])
    for (const t of [0.4, 0.75]) {
      const y = Math.round(top + tall * t)
      for (const side of [-1, 1]) {
        const run = runAt(y, (waist?.[0] ?? w / 2) + side * w * 0.12)
        if (run && run[1] > 4) points.push([run[0], y])
      }
    }
  } else {
    const middle = runAt(Math.round(top + tall * 0.45))
    const cx = middle?.[0] ?? w / 2
    for (const t of [0.25, 0.45, 0.7]) {
      const y = Math.round(top + tall * t)
      const run = runAt(y, cx)
      if (run && run[1] > 4) points.push([run[0], y])
    }
  }
  const bg = [0, 1, 2].map(c => {
    const edge = []
    for (let x = 0; x < w; x++) edge.push(data[4 * x + c], data[4 * ((h - 1) * w + x) + c])
    edge.sort((a, b) => a - b)
    return edge[edge.length >> 1]
  })
  return points.length ? { points, mask, bg } : null
}

// What the segmentation model kept (keep: 1 per pixel) and the backdrop cut didn't: everything of the
// garment's piece it left out (a hand, an arm, a bag, a hanger) painted the backdrop's colour, so reading
// the photo goes on as if they weren't there. Returns how much of the garment's piece was painted out
// (0 to 1), and changes data in place unless that's too much to trust (over `most`).
export function paintOut(data, w, h, mask, keep, bg, { most = 0.35 } = {}) {
  let inside = 0, out = 0
  for (let i = 0; i < w * h; i++) if (mask[i]) { inside++; if (!keep[i]) out++ }
  const share = inside ? out / inside : 1
  if (share > most) return share
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || keep[i]) continue
    data[4 * i] = bg[0]; data[4 * i + 1] = bg[1]; data[4 * i + 2] = bg[2]
  }
  return share
}

// A shoe's colours from its photo (a side view on a plain backdrop, as shops show them): its upper's (the
// commonest colour above the sole) and its sole's (the bottom tenth of the shoe). Null when no shoe stands out.
export async function readShoe(src) {
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
  return shoeColors(context.getImageData(0, 0, w, h).data, w, h)
}

export function shoeColors(data, w, h) {
  const cut = cutOut(data, w, h)
  if (!cut) return null
  const { mask } = cut.garment
  let top = h, bottom = -1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { top = Math.min(top, y); bottom = Math.max(bottom, y) }
  if (bottom <= top) return null
  const soleFrom = bottom - Math.max(2, Math.round((bottom - top) * 0.1))
  const commonest = (y0, y1) => {
    const bins = new Map()
    for (let y = y0; y <= y1; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (!mask[i]) continue
        const key = (data[4 * i] >> 4) << 8 | (data[4 * i + 1] >> 4) << 4 | (data[4 * i + 2] >> 4)
        const bin = bins.get(key) ?? [0, 0, 0, 0]
        bin[0] += data[4 * i]; bin[1] += data[4 * i + 1]; bin[2] += data[4 * i + 2]; bin[3]++
        bins.set(key, bin)
      }
    }
    const best = [...bins.values()].sort((p, q) => q[3] - p[3])[0]
    return best && "#" + best.slice(0, 3).map(v => Math.round(v / best[3]).toString(16).padStart(2, "0")).join("")
  }
  return { color: commonest(top, soleFrom - 1), sole: commonest(soleFrom, bottom) }
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

// Pants, shorts or a skirt's shape in a photo (see measureBottom), or null.
export async function readBottomShape(src) {
  const pixels = await loadPixels(src)
  return pixels && measureBottom(pixels.data, pixels.w, pixels.h)
}

// The garment's outline in a photo (or a render): { mask (1 where garment), w, h } or null.
export function garmentMask(data, w, h) {
  const cut = cutOut(data, w, h)
  return cut && { mask: cut.garment.mask, w, h }
}

// Pants, shorts or a skirt in a photo, as shares of the waist's width: { length: waist to hem, hips: the
// widest point in the top third, rise: waist to crotch over the length (null for a skirt), thigh: one
// leg's width just below the crotch, knee: one leg's width halfway down the leg, hem: one leg's width at
// the hem (a skirt's whole hem) }. Null when it can't be read.
export function measureBottom(data, w, h) {
  const cut = cutOut(data, w, h)
  return cut && measureBottomMask(belowHanger(cut.garment.mask, w, h).mask, w, h)
}

// Pants hung up for their photo: the hanger's hook above them is a thin line, far narrower than the
// waistband. Rows above where the garment gets a third as wide as it will are left out. hung: whether there
// was a hook.
function belowHanger(mask, w, h) {
  const span = new Int32Array(h)
  let widest = 0, first = -1
  for (let y = 0; y < h; y++) {
    let a = -1, b = -1
    for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (a < 0) a = x; b = x }
    span[y] = a < 0 ? 0 : b - a + 1
    if (a >= 0 && first < 0) first = y
    widest = Math.max(widest, span[y])
  }
  let top = Math.max(first, 0)
  while (top < h && span[top] < widest * 0.35) top++
  const hung = top - first > h * 0.02
  if (!hung) return { mask, hung }
  const out = Uint8Array.from(mask)
  out.fill(0, 0, top * w)
  return { mask: out, hung }
}

// Below a hook, the hanger's bar lies across the top of the waistband, with its clips: the last rows near
// the top that are hardly the cloth's colour at all (the clips' gap, or the bar's label) are where the
// cloth begins.
function belowHangerBar(mask, w, h, lab, cloth, top, bottom) {
  let start = -1
  for (let y = top; y < top + (bottom - top) * 0.1; y++) {
    let on = 0, like = 0
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!mask[i]) continue
      on++
      if (Math.hypot(lab[3 * i] - cloth[0], lab[3 * i + 1] - cloth[1], lab[3 * i + 2] - cloth[2]) < 30) like++
    }
    if (!on || like / on < 0.1) start = y + 1
  }
  if (start < 0) return mask
  const out = Uint8Array.from(mask)
  out.fill(0, 0, start * w)
  return out
}

export function measureBottomMask(mask, w, h) {
  const on = (x, y) => mask[y * w + x] === 1
  // The stretches of garment across a row (small gaps, a seam's shadow, don't split one).
  const gap = Math.max(2, Math.round(w * 0.01))
  const runs = y => {
    const out = []
    let start = -1, last = -1
    for (let x = 0; x < w; x++) {
      if (!on(x, y)) continue
      if (start < 0) start = x
      else if (x - last > gap) { out.push([start, last]); start = x }
      last = x
    }
    if (start >= 0) out.push([start, last])
    return out.filter(([a, b]) => b - a > w * 0.01)
  }
  let top = -1, bottom = -1
  for (let y = 0; y < h; y++) if (runs(y).length) { if (top < 0) top = y; bottom = y }
  if (top < 0) return null
  const tall = bottom - top + 1
  const row = f => Math.min(bottom, Math.round(top + tall * f))
  const span = y => { const r = runs(y); return r.length ? r[r.length - 1][1] - r[0][0] : 0 }
  const waist = median(Array.from({ length: Math.max(1, Math.round(tall * 0.03)) }, (_, k) => span(top + 1 + k)))
  if (waist < w * 0.08) return null
  let hips = 0
  for (let y = row(0.02); y <= row(0.33); y++) hips = Math.max(hips, span(y))
  // The crotch: the first row, a little way down, where the garment parts into two legs (and stays parted).
  let crotch = -1
  for (let y = row(0.12); y <= row(0.85) && crotch < 0; y++) {
    if (runs(y).length === 2 && [1, 2, 3].every(k => runs(Math.min(bottom, y + Math.round(tall * 0.02) * k)).length === 2)) crotch = y
  }
  const leg = y => { const r = runs(y); return r.length === 2 ? median([r[0][1] - r[0][0], r[1][1] - r[1][0]]) : null }
  const at = (y, n = 5) => median(Array.from({ length: n }, (_, k) => leg(Math.min(bottom, y + k))).filter(v => v != null)) / waist
  if (crotch < 0) {
    // A skirt: its hem's whole width.
    const hem = median([0.93, 0.95, 0.97].map(f => span(row(f))))
    return { length: tall / waist, hips: hips / waist, rise: null, thigh: null, knee: null, hem: hem / waist, skirt: true }
  }
  const legLength = bottom - crotch
  return {
    length: tall / waist, hips: hips / waist, rise: (crotch - top) / tall,
    thigh: at(crotch + Math.round(legLength * 0.05)), knee: at(crotch + Math.round(legLength * 0.5)),
    hem: at(bottom - Math.max(3, Math.round(legLength * 0.04)), 3), skirt: false
  }
}

// Pants, shorts or a skirt photographed flat from the front, read to be laid on the draped cloth (see
// photo_map.js): the cloth's colour, and the photo itself, with the backdrop round the garment painted over
// in its nearby colours (so cloth sampled at its very edge doesn't pick up the backdrop), and a softened
// copy (its colours and fading without the front's details, for the back, which isn't photographed).
// src: an image URL. Returns { color, image (canvas), soft (canvas), layout } or null.
export async function readBottomPhoto(src) {
  const image = new Image()
  image.src = src
  try { await loaded(image) } catch { return null }
  const scale = Math.min(1, PHOTO_SIZE / Math.max(image.naturalWidth, image.naturalHeight))
  const w = Math.max(8, Math.round(image.naturalWidth * scale)), h = Math.max(8, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement("canvas")
  canvas.width = w
  canvas.height = h
  const context = canvas.getContext("2d", { willReadFrequently: true })
  context.drawImage(image, 0, 0, w, h)
  const read = readBottom(context.getImageData(0, 0, w, h).data, w, h)
  if (!read) return null
  const toCanvas = pixels => {
    const out = document.createElement("canvas")
    out.width = w
    out.height = h
    out.getContext("2d").putImageData(new ImageData(pixels, w, h), 0, 0)
    return out
  }
  return { color: read.color, image: toCanvas(read.filled), soft: toCanvas(read.soft), layout: read.layout }
}

const PHOTO_SIZE = 768   // a bottoms photo is laid on the cloth at about this many pixels across

// The same on raw RGBA pixels. layout: { w, h, top, bottom, crotch (the row the legs part at, or null for a
// skirt), rows: for each row from top to bottom, [left, right, inner left, inner right] (the garment's
// outer edges, and where the two legs' inner edges are, or -1 above the crotch) }. Null when the photo
// doesn't show a bottoms garment laid flat from the front.
export function readBottom(data, w, h) {
  const cut = cutOut(data, w, h)
  if (!cut) return null
  const { lab, bg } = cut
  const hanger = belowHanger(cut.garment.mask, w, h)
  let mask = hanger.mask
  // Each row's stretches of garment, small gaps (a seam's shadow) closed.
  const gap = Math.max(2, Math.round(w * 0.01))
  const runs = y => {
    const out = []
    let start = -1, last = -1
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue
      if (start < 0) start = x
      else if (x - last > gap) { out.push([start, last]); start = x }
      last = x
    }
    if (start >= 0) out.push([start, last])
    return out.filter(([a, b]) => b - a > w * 0.01)
  }
  const extent = () => {
    let top = -1, bottom = -1
    for (let y = 0; y < h; y++) if (runs(y).length) { if (top < 0) top = y; bottom = y }
    return [top, bottom]
  }
  let [top, bottom] = extent()
  if (top < 0) return null

  // The cloth's colour: the commonest colour (with its near neighbours: a washed or mottled cloth spreads
  // over several) down the middle of each stretch, from a third of the way down to near the hem.
  const bins = new Map()
  for (let y = Math.round(top + (bottom - top) * 0.35); y <= top + (bottom - top) * 0.9; y++) {
    for (const [a, b] of runs(y)) {
      const inset = Math.round((b - a) * 0.2)
      for (let x = a + inset; x <= b - inset; x++) {
        const i = y * w + x
        if (!mask[i]) continue
        const key = (data[4 * i] >> 4) << 8 | (data[4 * i + 1] >> 4) << 4 | (data[4 * i + 2] >> 4)
        const bin = bins.get(key) ?? [0, 0, 0, 0]
        bin[0] += data[4 * i]; bin[1] += data[4 * i + 1]; bin[2] += data[4 * i + 2]; bin[3]++
        bins.set(key, bin)
      }
    }
  }
  if (!bins.size) return null
  const [best] = [...bins.entries()].sort((p, q) => q[1][3] - p[1][3])
  const near = (a, b) => Math.abs((a >> 8) - (b >> 8)) <= 1 && Math.abs(((a >> 4) & 15) - ((b >> 4) & 15)) <= 1 && Math.abs((a & 15) - (b & 15)) <= 1
  const sum = [0, 0, 0, 0]
  for (const [key, bin] of bins) if (near(key, best[0])) for (let c = 0; c < 4; c++) sum[c] += bin[c]
  const rgb = [0, 1, 2].map(c => sum[c] / sum[3])
  const color = "#" + rgb.map(v => Math.round(v).toString(16).padStart(2, "0")).join("")

  // The garment's outline again, more strictly where the cloth is unlike the backdrop: the shadowed sliver
  // between two legs laid touching isn't far enough from the backdrop to be cut away with it, but it's much
  // nearer the backdrop than the cloth.
  const clothLab = new Float32Array(3)
  toLab(rgb[0], rgb[1], rgb[2], clothLab, 0)
  const apart = Math.hypot(clothLab[0] - bg[0], clothLab[1] - bg[1], clothLab[2] - bg[2])
  if (apart > 20) {
    const strict = Uint8Array.from(mask, (on, i) => (on && Math.hypot(lab[3 * i] - bg[0], lab[3 * i + 1] - bg[1], lab[3 * i + 2] - bg[2]) > apart * 0.35 ? 1 : 0))
    mask = largestPiece(strict, w, h).mask
    ;[top, bottom] = extent()
  }
  if (hanger.hung) {
    mask = belowHangerBar(mask, w, h, lab, clothLab, top, bottom)
    ;[top, bottom] = extent()
  }
  const shape = measureBottomMask(mask, w, h)
  if (!shape || shape.length < 0.4) return null
  const tall = bottom - top + 1
  // Where the legs part in the photo (laid flat, wide legs often touch well below the crotch; above it,
  // each leg is taken to run from the middle out).
  const crotch = shape.skirt ? null : Math.round(top + shape.rise * tall)
  const rows = new Int16Array(4 * tall)
  for (let y = top; y <= bottom; y++) {
    const r = runs(y), k = 4 * (y - top)
    if (!r.length) { rows.set(rows.slice(k - 4, k), k); continue }
    rows[k] = r[0][0]; rows[k + 1] = r[r.length - 1][1]; rows[k + 2] = -1; rows[k + 3] = -1
    if (crotch !== null && y >= crotch) {
      if (r.length >= 2) {
        // The two legs: the gap between the first stretch and the last.
        rows[k + 2] = r[0][1]; rows[k + 3] = r[r.length - 1][0]
      } else {
        // Wide legs touching: they part at the middle.
        const mid = Math.round((r[0][0] + r[0][1]) / 2)
        rows[k + 2] = mid; rows[k + 3] = mid
      }
    }
  }

  // The backdrop painted over in the garment's nearby colours, and a softened copy. The garment's outermost
  // pixels go too: half backdrop, they'd leave a light rim round it.
  const rim = Math.max(1, Math.round(w * 0.003))
  const inner = boxBlur(Float32Array.from(mask), w, h, rim).map(v => (v > 0.999 ? 1 : 0))
  const filled = fillAround(evenLight(data, inner, w, h), inner, w, h, Math.max(4, Math.round(w * 0.03)))
  const soft = blurPixels(filled, inner, w, h, Math.max(3, Math.round(w * 0.025)))
  return { color, filled, soft, layout: { w, h, top, bottom, crotch, rows } }
}

// The photo's own creases and shadows, mostly taken out: on the 3D cloth they'd be painted on, as streaks
// down the leg, on top of the folds the cloth makes itself. Each pixel is lightened or darkened towards the
// cloth's average over a few centimetres round it, partly (a jean's broad fading, its wash, is its colour,
// and stays; a stripe or a print, finer than that, stays whole).
function evenLight(data, mask, w, h) {
  const lum = new Float32Array(w * h), on = new Float32Array(w * h)
  let sum = 0, count = 0
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) continue
    lum[i] = 0.299 * data[4 * i] + 0.587 * data[4 * i + 1] + 0.114 * data[4 * i + 2]
    on[i] = 1
    sum += lum[i]; count++
  }
  if (!count) return data
  const r = Math.max(3, Math.round(w * 0.025))
  const near = boxBlur(lum, w, h, r), weight = boxBlur(on, w, h, r)
  const out = Uint8ClampedArray.from(data)
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || weight[i] < 1e-3) continue
    const around = near[i] / weight[i]
    // Halfway towards even, and never by much: a deep shadow is lifted a little, not to full light. Far
    // lighter or darker than the cloth round it isn't a shadow but a print or a patch, and is left alone.
    const ratio = (sum / count + 1) / (around + 1)
    if (ratio < 0.6 || ratio > 1.7) continue
    const k = Math.min(Math.max(Math.pow(ratio, 0.6), 0.8), 1.25)
    out[4 * i] = data[4 * i] * k; out[4 * i + 1] = data[4 * i + 1] * k; out[4 * i + 2] = data[4 * i + 2] * k
  }
  return out
}

// The photo with what's round the garment (mask 0) painted in the garment's colours nearby, out to `reach`
// pixels; further out it's left as it was.
function fillAround(data, mask, w, h, reach) {
  const out = new Uint8ClampedArray(data)
  const sums = [0, 1, 2].map(c => boxBlur(Float32Array.from({ length: w * h }, (_, i) => (mask[i] ? data[4 * i + c] : 0)), w, h, reach))
  const weight = boxBlur(Float32Array.from(mask), w, h, reach)
  for (let i = 0; i < w * h; i++) {
    if (mask[i] || weight[i] < 1e-4) continue
    for (let c = 0; c < 3; c++) out[4 * i + c] = sums[c][i] / weight[i]
  }
  return out
}

// The garment's pixels blurred among themselves (a radius r box, twice), the rest filled as fillAround does.
function blurPixels(data, mask, w, h, r) {
  const weight = boxBlur(boxBlur(Float32Array.from(mask), w, h, r), w, h, r)
  const out = new Uint8ClampedArray(data)
  const channels = [0, 1, 2].map(c => boxBlur(boxBlur(Float32Array.from({ length: w * h }, (_, i) => (mask[i] ? data[4 * i + c] : 0)), w, h, r), w, h, r))
  for (let i = 0; i < w * h; i++) {
    if (weight[i] < 1e-4) continue
    for (let c = 0; c < 3; c++) out[4 * i + c] = channels[c][i] / weight[i]
  }
  return out
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

// Which of the model's guesses (count masks of `plane` pixels each, in bits) is the garment. The most
// confident guess is often the garment with the model's arm or legs still on it (a hand in a pocket), so:
// the tightest confident guess that still covers most of the garment as cut from the backdrop (not just
// its print, or one leg). Failing that, the most confident that covers enough of it. -1 when none does.
export function pickMask(bits, count, plane, cut, scores) {
  let inside = 0
  for (let i = 0; i < plane; i++) if (cut[i]) inside++
  const guesses = []
  for (let k = 0; k < count; k++) {
    let kept = 0, area = 0
    for (let i = 0; i < plane; i++) {
      if (!bits[k * plane + i]) continue
      area++
      if (cut[i]) kept++
    }
    guesses.push({ k, area, share: kept / Math.max(1, inside), score: scores[k] })
  }
  const tight = guesses.filter(g => g.share >= 0.8 && g.score >= 0.85).sort((a, b) => a.area - b.area)[0]
  if (tight) return tight.k
  const loose = guesses.filter(g => g.share >= 0.65).sort((a, b) => b.score - a.score)[0]
  return loose ? loose.k : -1
}
