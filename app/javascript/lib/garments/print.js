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

// Where this server passes a shop's photo through when the shop's image server doesn't let a browser read
// its pixels (see Api::V1::GarmentImportsController#image).
export const IMAGE_PROXY = "/api/v1/garment_imports/image?url="

// Loads an image whose pixels can be read back (a canvas drawn from another site's image is sealed unless
// the image was asked for with CORS). A photo on another site that won't allow that is fetched through this
// server instead. Rejects when it can't be loaded either way.
export function loadImage(src) {
  const load = address => new Promise((resolve, reject) => {
    const image = new Image()
    if (!/^(data|blob):/i.test(address)) image.crossOrigin = "anonymous"
    image.addEventListener("load", () => resolve(image), { once: true })
    image.addEventListener("error", reject, { once: true })
    image.src = address
  })
  return load(src).catch(error => {
    let elsewhere = false
    try { elsewhere = /^https?:$/.test(new URL(src, location.href).protocol) && new URL(src, location.href).origin !== location.origin } catch {}
    if (!elsewhere) throw error
    return load(IMAGE_PROXY + encodeURIComponent(src))
  })
}

// src: an image URL (a data: URL from the import, or a local blob). shape: the garment's length over its
// front's width (from its chart), to find its hem when something else (trousers, a stand) shows below it.
// Returns { color: "#rrggbb", print } or null when the photo can't be read. print is null, or { image (a
// canvas: the front of the garment, collar to hem, with everything but the print transparent), coverage
// (share of the front that's print), tile (an all-over print's cloth, see allOverTile), stripes (true for
// stripes right across the front or down it), vertical (true for stripes down it), strip (then a canvas a few
// pixels wide: the cloth's colour at each row from the shoulders to the hem and on down any sleeves hanging
// below it, laid on the sleeves and back by height; or, for vertical stripes, a few pixels tall: its colour
// at each column across the front, laid on every piece by how far across it is), stripSpan (a horizontal
// strip's height over the front's, 1 or more), stripAcross (a vertical strip's { from, span }: where it starts
// across the front and how much of it it spans, as shares of the front's width) }.
// guesses: { hood, patterns, sleeves } (all true by default): whether to look for a hood standing above the
// shoulders, stripes or an all-over print, and graphics on the sleeves. The 3D view's check (look_check.js)
// turns them off one by one when a reading doesn't match the photo.
export async function readPhoto(src, { shape = null, hood = true, patterns = true, sleeves: sleeveGuess = true } = {}) {
  const image = await loadImage(src).catch(() => null)
  if (!image) return null
  const read = (sx, sy, sw, sh) => {
    const scale = Math.min(1, PRINT_SIZE / Math.max(sw, sh))
    const w = Math.max(8, Math.round(sw * scale)), h = Math.max(8, Math.round(sh * scale))
    const canvas = document.createElement("canvas")
    canvas.width = w
    canvas.height = h
    const context = canvas.getContext("2d", { willReadFrequently: true })
    context.drawImage(image, sx, sy, sw, sh, 0, 0, w, h)
    const found = findPrint(context.getImageData(0, 0, w, h).data, w, h, shape, { hood, patterns, sleeves: sleeveGuess })
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
    const strip = found.print.strip
    print = {
      image: out, coverage: found.print.coverage, tile: found.print.allOver ? allOverTile(found.print) : null, stripes: found.print.stripes,
      strip: strip ? stripCanvas(strip) : null, vertical: Boolean(strip?.vertical),
      stripSpan: strip && !strip.vertical ? strip.span : 1, stripAcross: strip?.vertical ? { from: strip.from, span: strip.span } : null
    }
  }
  // The sleeves' graphics, by the wearer's side: a photo of the front shows the right sleeve on its left.
  const canvas = part => {
    if (!part) return null
    const c = document.createElement("canvas")
    c.width = part.width
    c.height = part.height
    c.getContext("2d").putImageData(new ImageData(part.data, part.width, part.height), 0, 0)
    return c
  }
  const sleeves = found.sleeves && (found.sleeves.left || found.sleeves.right) ? { left: canvas(found.sleeves.left), right: canvas(found.sleeves.right) } : null
  return { color: found.color, print, sleeves, look: found.look }
}

// A striped front's colours row by row, as a texture a few pixels wide (the same column repeated); a
// vertically striped one's column by column, a few pixels tall (the same row repeated).
function stripCanvas(strip) {
  const repeat = 4
  const canvas = document.createElement("canvas")
  canvas.width = strip.vertical ? strip.width : repeat
  canvas.height = strip.vertical ? repeat : strip.height
  const pixels = new ImageData(canvas.width, canvas.height)
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const k = strip.vertical ? x : y
      pixels.data.set(strip.data.subarray(4 * k, 4 * k + 4), 4 * (y * canvas.width + x))
    }
  }
  canvas.getContext("2d").putImageData(pixels, 0, 0)
  return canvas
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
// width, height, coverage, allOver, stripes, strip } | null } or null when no garment stands out from the
// background. stripes: the front is horizontal stripes right across; strip is then one column of pixels, the
// cloth's colour at each row from the shoulders to the hem (to lay on the sleeves and back by height, so
// the stripes meet at the seams).
export function findPrint(data, w, h, shape = null, { hood: hoodGuess = true, patterns = true, sleeves: sleeveGuess = true } = {}) {
  const cut = cutOut(data, w, h)
  if (!cut) return null
  const { lab, bg, garment, far } = cut

  // Its rows from the shoulders to the hem (not a hood standing up above them, nor sleeves hanging below
  // it), and the torso: as wide as the garment is near its hem (the sleeves stick out higher up), centred
  // where it is there.
  const rows = garmentRows(garment.mask, w, h, { hood: hoodGuess })
  if (!rows) return null
  let { top, bottom, widest, rowMin, rowMax, centre, hood } = rows
  let tall = bottom - top + 1
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
  // Under a hood standing up in the photo, the neck opening: the hood's inside and its drawcords show there,
  // not the front's cloth. Nothing of it goes on the body.
  if (hood) {
    const halfWide = Math.min(hood.width / 2, pw * 0.3), deep = halfWide * 0.7, cx = centre - x0
    for (let y = 0; y < Math.ceil(deep); y++) {
      const reach = halfWide * Math.sqrt(Math.max(0, 1 - (y / deep) ** 2))
      for (let x = Math.max(0, Math.floor(cx - reach)); x <= Math.min(pw - 1, Math.ceil(cx + reach)); x++) { alpha[y * pw + x] = 0; gap[y * pw + x] = 1 }
    }
  }

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
  if (coverage > 0.25 && patterns) {
    for (let k = 0; k < pw * ph; k++) out[4 * k + 3] = !gap[k] && garment.mask[(top + Math.floor(k / pw)) * w + x0 + (k % pw)] ? 255 : 0
  }
  // Stripes: horizontal ones right across (a striped knit), or vertical ones down the front (a striped
  // button-up). Both at once is a check: that's laid as the photo's print, not as stripes. Faint stripes (pale
  // blue on white) are read too, though they're too close to the cloth's colour to count as print above.
  const strong = coverage > 0.25
  // Stripes run right across, to the side seams (or right down, to the hem); a big chest graphic (a logo's
  // bold letters over a line of text) has rows of its own colours too, but plain cloth either side of it.
  let down = patterns ? stripeStrip(data, lab, garment.mask, w, x0 + inset, x1 - inset, top, bottom, rows.last, strong) : null
  let across = patterns ? stripeColumns(data, lab, garment.mask, w, x0, x1, top, bottom, strong) : null
  // (Both ways at once is a check, which is laid whole anyway.)
  if (down && !across && !reachesEdges(lab, garment.mask, w, x0, x1, top, bottom, "rows")) down = null
  if (across && !down && !reachesEdges(lab, garment.mask, w, x0, x1, top, bottom, "columns")) across = null
  const strip = down && across ? null : down ?? across
  // A striped or checked front is laid whole, as photographed (the placket, the pocket and the collar's
  // shadow with it); a check's cloth repeats over the other pieces as an all-over print's does.
  const patterned = Boolean(down || across)
  if (patterned && !strong) for (let k = 0; k < pw * ph; k++) out[4 * k + 3] = !gap[k] && garment.mask[(top + Math.floor(k / pw)) * w + x0 + (k % pw)] ? 255 : 0
  const allOver = (strong && patterns) || patterned
  const print = coverage > 0.01 || patterned ? { data: out, width: pw, height: ph, coverage, allOver, stripes: Boolean(strip), strip } : null
  // A graphic on a sleeve (an all-over print or stripes already cover them).
  const sleeves = allOver || !sleeveGuess ? { left: null, right: null } : {
    left: sleevePrint(data, lab, garment.mask, w, h, { x0, x1, top, bottom }, rows, baseLab, -1),
    right: sleevePrint(data, lab, garment.mask, w, h, { x0, x1, top, bottom }, rows, baseLab, 1)
  }
  return { color, print, rect: [x0, top, x1, bottom], sleeves, look: lookOf(out, pw, ph, coverage, allOver, color) }
}

// What a reading says the garment looks like, in numbers a render read the same way can be held to (see
// look_check.js): its colour, how much of the front is graphic (and whether it's an all-over print or stripes),
// and where the graphic sits on the front, as shares of its width and length (left, right, top, bottom), or
// null when there's none. The collar's top band is left out: a label in the neck, or the cloth's inside seen
// through the neck of a render, isn't the graphic.
export function lookOf(out, pw, ph, coverage, allOver, color) {
  // The graphic's extent: its marks grown a little so a word's letters join up, then the pieces that are only
  // specks (a fold's shadow, a crease by the hem) left out. Thin lettering stays; it's part of a word.
  const on = new Uint8Array(pw * ph), y0 = Math.round(ph * 0.08)
  let total = 0
  for (let y = y0; y < ph; y++) for (let x = 0; x < pw; x++) if (out[4 * (y * pw + x) + 3] >= 128) { on[y * pw + x] = 1; total++ }
  let box = null
  if (!allOver && total > pw * ph * 0.004) {
    const reach = Math.max(2, Math.round(Math.min(pw, ph) * 0.02))
    const grown = boxBlur(Float32Array.from(on), pw, ph, reach)
    const label = new Int32Array(pw * ph).fill(-1), pieces = []
    for (let k = 0; k < pw * ph; k++) {
      if (grown[k] <= 0 || label[k] >= 0) continue
      const piece = { marks: 0, left: pw, right: -1, top: ph, bottom: -1 }, stack = [k]
      label[k] = pieces.length
      while (stack.length) {
        const i = stack.pop(), x = i % pw, y = (i - x) / pw
        if (on[i]) {
          piece.marks++
          if (x < piece.left) piece.left = x
          if (x > piece.right) piece.right = x
          if (y < piece.top) piece.top = y
          if (y > piece.bottom) piece.bottom = y
        }
        for (const j of [x > 0 ? i - 1 : -1, x < pw - 1 ? i + 1 : -1, i - pw, i + pw]) {
          if (j < 0 || j >= pw * ph || label[j] >= 0 || grown[j] <= 0) continue
          label[j] = pieces.length
          stack.push(j)
        }
      }
      pieces.push(piece)
    }
    const kept = pieces.filter(piece => piece.marks >= total * 0.03)
    if (kept.length) {
      const left = Math.min(...kept.map(q => q.left)), right = Math.max(...kept.map(q => q.right))
      const top = Math.min(...kept.map(q => q.top)), bottom = Math.max(...kept.map(q => q.bottom))
      box = { left: left / pw, right: (right + 1) / pw, top: top / ph, bottom: (bottom + 1) / ph }
      // Its shape (width over height, in pixels), which doesn't depend on how wide the front was taken to be.
      box.shape = (right + 1 - left) / Math.max(1, bottom + 1 - top)
    }
  }
  return { color, coverage: allOver ? 1 : coverage, allOver, box }
}

// A graphic on one sleeve of a photo (`way` -1: the photo's left one, +1 its right), as a strip of pixels
// SLEEVE_ACROSS wide and SLEEVE_ALONG long: down it from the shoulder to the cuff, across it from its outer
// edge (the top of the arm, where its sewn top line runs) to its inner edge (the underarm seam), plain cloth
// transparent as on the front. Null when the sleeve can't be told from the body (folded over it, or short and
// hidden) or nothing is printed on it. Returns { data, width, height, coverage }.
// A long sleeve laid down beside the body, touching it (most flat-lays), is found by its cuff: below the hem
// only the sleeves are left. Its axis runs from the shoulder point to the cuff's middle, and it's measured in
// from its outer edge by the cuff's width (a little more up the arm). A sleeve standing clear of the body is
// found as the cloth beside the front.
export const SLEEVE_ACROSS = 48, SLEEVE_ALONG = 192
export function sleevePrint(data, lab, mask, w, h, front, rows, baseLab, way) {
  const line = hangingSleeve(mask, w, h, front, rows, way) ?? clearSleeve(mask, w, h, front, way)
  if (!line) return null
  const { start, end, wide, inside } = line
  const length = Math.hypot(end[0] - start[0], end[1] - start[1])
  const d = [(end[0] - start[0]) / length, (end[1] - start[1]) / length]
  let o = [-d[1], d[0]]
  if (Math.sign(o[0]) !== way) o = [-o[0], -o[1]]   // across it, outwards: towards its outer edge
  const out = new Uint8ClampedArray(4 * SLEEVE_ACROSS * SLEEVE_ALONG), alpha = new Float32Array(SLEEVE_ACROSS * SLEEVE_ALONG)
  let lines = 0
  for (let j = 0; j < SLEEVE_ALONG; j++) {
    const t = (j + 0.5) / SLEEVE_ALONG
    const cx = start[0] + d[0] * length * t, cy = start[1] + d[1] * length * t
    // Its outer edge on this line, then in by the sleeve's width there.
    let outer = null
    for (let k = -Math.round(wide[0]); k <= Math.round(wide[0] * 1.5); k++) {
      if (inside(Math.round(cx + o[0] * k), Math.round(cy + o[1] * k))) outer = k
    }
    if (outer === null) continue
    const across = wide[0] + (wide[1] - wide[0]) * t
    lines++
    for (let i = 0; i < SLEEVE_ACROSS; i++) {
      const k = outer - ((i + 0.5) / SLEEVE_ACROSS) * across
      const x = Math.round(cx + o[0] * k), y = Math.round(cy + o[1] * k)
      if (!inside(x, y)) continue
      const at = y * w + x, q = j * SLEEVE_ACROSS + i
      out[4 * q] = data[4 * at]; out[4 * q + 1] = data[4 * at + 1]; out[4 * q + 2] = data[4 * at + 2]
      const dl = Math.abs(lab[3 * at] - baseLab[0]), dc = Math.hypot(lab[3 * at + 1] - baseLab[1], lab[3 * at + 2] - baseLab[2])
      alpha[q] = Math.min(1, Math.max(smooth(dl, 22, 34), smooth(dc, 16, 26)))
    }
  }
  if (lines < SLEEVE_ALONG * 0.6) return null
  // A line down the sleeve by its edges is the photo's light on its rim, or the seam where it meets the body,
  // not a graphic: a graphic is a patch, not marked down most of the sleeve.
  for (let i = 0; i < SLEEVE_ACROSS; i++) {
    if (i >= 8 && i < SLEEVE_ACROSS - 8) continue
    let marked = 0
    for (let j = 0; j < SLEEVE_ALONG; j++) if (alpha[j * SLEEVE_ACROSS + i] > 0.3) marked++
    if (marked > SLEEVE_ALONG * 0.3) for (let j = 0; j < SLEEVE_ALONG; j++) alpha[j * SLEEVE_ACROSS + i] = 0
  }
  // Specks and the photo's own folds and seams are thin; a graphic is solid. The cuff's rib and the line where
  // the sleeve meets the body are left out.
  const solid = boxBlur(alpha, SLEEVE_ACROSS, SLEEVE_ALONG, 1)
  let covered = 0
  for (let q = 0; q < alpha.length; q++) {
    const j = Math.floor(q / SLEEVE_ACROSS), i = q % SLEEVE_ACROSS
    const keep = smooth(solid[q], 0.3, 0.55) * smooth(SLEEVE_ALONG - j, 4, 12) * smooth(SLEEVE_ACROSS - i, 2, 5) * smooth(i, 1, 3)
    const a = alpha[q] * keep
    out[4 * q + 3] = Math.round(a * 255)
    covered += a
  }
  const coverage = covered / alpha.length
  return coverage > 0.01 ? { data: out, width: SLEEVE_ACROSS, height: SLEEVE_ALONG, coverage } : null
}

// A long sleeve hanging below the hem on its side: { start (the shoulder point, its axis's top), end (the
// cuff's middle), wide: [its width at the top, at the cuff] (px), inside(x, y) } or null.
function hangingSleeve(mask, w, h, front, rows, way) {
  const { top, bottom } = front, { rowMin, rowMax, last, centre } = rows
  // Below the hem, the cloth on this side of the middle: the sleeve's end.
  const ends = []
  for (let y = bottom + 3; y <= last; y++) {
    let a = -1, b = -1
    for (let x = way < 0 ? 0 : centre; way < 0 ? x < centre : x < w; x++) if (mask[y * w + x]) { if (a < 0) a = x; b = x }
    if (a >= 0 && b - a >= 3) ends.push([y, a, b])
  }
  if (ends.length < 3) return null
  // The cuff: its last few rows, short of the rounded tip.
  const cuff = ends.slice(Math.max(0, ends.length - 8), Math.max(1, ends.length - 2))
  const cy = median(cuff.map(e => e[0])), cx = median(cuff.map(e => (e[1] + e[2]) / 2)), cw = median(cuff.map(e => e[2] - e[1] + 1))
  // A sleeve is long and narrow; a skirt or the other sleeve's tip isn't this.
  if (cw > (front.x1 - front.x0) * 0.4 || cw < 3) return null
  const shoulderY = top + 2, outerX = way < 0 ? rowMin[shoulderY] : rowMax[shoulderY]
  if (outerX < 0 || outerX >= w) return null
  const topWide = cw * 1.35
  const start = [outerX - way * topWide / 2, shoulderY]
  if (Math.hypot(cx - start[0], cy - start[1]) < cw * 4) return null
  return { start, end: [cx, cy], wide: [topWide, cw], inside: (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1 }
}

// A sleeve standing clear of the body: the cloth beside the front, along its long axis.
function clearSleeve(mask, w, h, front, way) {
  const { x0, x1, top } = front
  const clear = Math.max(2, Math.round((x1 - x0) * 0.02))
  const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1 && y >= top &&
    (way < 0 ? x < x0 - clear : x > x1 + clear)
  let n = 0, mx = 0, my = 0
  for (let y = top; y < h; y++) for (let x = 0; x < w; x++) if (inside(x, y)) { n++; mx += x; my += y }
  if (n < (x1 - x0) * (x1 - x0) * 0.06) return null
  mx /= n; my /= n
  let sxx = 0, syy = 0, sxy = 0
  for (let y = top; y < h; y++) for (let x = 0; x < w; x++) if (inside(x, y)) { const dx = x - mx, dy = y - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  let d = [Math.cos(angle), Math.sin(angle)]
  if (d[1] < 0) d = [-d[0], -d[1]]
  if (d[1] < 0.5) return null   // held out sideways, or not a sleeve
  let t0 = Infinity, t1 = -Infinity
  for (let y = top; y < h; y++) for (let x = 0; x < w; x++) if (inside(x, y)) { const t = (x - mx) * d[0] + (y - my) * d[1]; t0 = Math.min(t0, t); t1 = Math.max(t1, t) }
  // Its width: n pixels over its length.
  const wide = n / Math.max(1, t1 - t0)
  if (t1 - t0 < wide * 2.2) return null
  return { start: [mx + d[0] * t0, my + d[1] * t0], end: [mx + d[0] * t1, my + d[1] * t1], wide: [wide, wide], inside }
}

// A top's rows in a photo, from its outline (mask): { top: the shoulder line, bottom: the hem, centre (x),
// widest (the widest row), rowMin, rowMax, hood: { bottom, width } when a hood (or a stand's neck) stands up
// above the shoulders, else null }. Null when there's no garment.
// The shoulders are the first row nearly as wide as the garment gets (above it, a hanger's hook). A hood
// worn up is wider than a hook, about half the body, for a good way above the shoulders, in one piece (a
// dress's two straps aren't): the shoulder line is then where the body reaches its full width below it.
// The hem is where the body (the middle of the garment) ends; sleeves may hang on below it.
export function garmentRows(mask, w, h, { hood: hoodGuess = true } = {}) {
  let first = -1, last = -1, widest = 0
  const rowMin = new Int32Array(h).fill(w), rowMax = new Int32Array(h).fill(-1)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) if (mask[y * w + x]) { rowMin[y] = Math.min(rowMin[y], x); rowMax[y] = Math.max(rowMax[y], x) }
    if (rowMax[y] >= 0) { if (first < 0) first = y; last = y }
    widest = Math.max(widest, rowMax[y] - rowMin[y])
  }
  if (first < 0) return null
  const width = y => rowMax[y] - rowMin[y]
  let top = first
  while (top < last && width(top) < widest * 0.45) top++
  // The body's full width: what the garment holds for a while below the shoulders.
  const held = []
  for (let y = Math.round(top + (last - top) * 0.1); y <= Math.round(top + (last - top) * 0.35); y++) held.push(width(y))
  const full = held.length ? median(held) : widest
  // Below whatever stands above the shoulders: the first row of the body's full width.
  let shoulders = top
  if (width(top) < full * 0.8) while (shoulders < last && width(shoulders) < full * 0.88) shoulders++
  // A hood (or a stand's neck) above the shoulders: wider than a hook, narrower than the body, in one piece,
  // for a good way up. Then the neck opening below it isn't the front's cloth.
  let hood = null
  const above = []
  for (let y = first; y < shoulders; y++) if (width(y) > 0) above.push(y)
  const middle = above.slice(Math.round(above.length * 0.2), Math.round(above.length * 0.8))
  const onePiece = y => {
    let gaps = 0, on = false
    for (let x = rowMin[y]; x <= rowMax[y]; x++) { const here = mask[y * w + x] === 1; if (here && !on && x > rowMin[y]) gaps++; on = here }
    return gaps === 0
  }
  const wide = middle.filter(y => width(y) > full * 0.22 && width(y) < full * 0.8 && onePiece(y)).length
  // And it narrows again at the neck, below its widest: a T-shirt's shoulders, sloping out from the collar
  // to sleeves held out sideways, only ever widen.
  const widestAbove = above.reduce((best, y) => width(y) > width(best) ? y : best, above[0])
  const belowCrown = above.filter(y => y > widestAbove)
  const pinched = belowCrown.length > 0 && Math.min(...belowCrown.map(width)) < width(widestAbove) * 0.92
  if (hoodGuess && above.length > (last - shoulders) * 0.08 && middle.length && wide > middle.length * 0.6 && pinched) {
    // Dropped shoulders slope on out below the shoulder line, so the body's full width comes a good way
    // down it: the shoulders are where the outline leaps out from the hood's narrow neck instead.
    const lower = above.slice(Math.round(above.length * 0.5))
    if (lower.length) {
      const neck = lower.reduce((best, y) => width(y) < width(best) ? y : best, lower[0])
      let leap = neck
      while (leap < shoulders && width(leap) <= width(neck) * 1.25) leap++
      if (leap < shoulders) shoulders = leap
    }
    hood = { bottom: shoulders - 1, width: median(middle.map(width)) }
  }
  if (hood) top = shoulders
  // The middle of the collar.
  const collar = []
  for (let y = top; y <= Math.min(last, top + (last - top) * 0.05); y++) if (rowMax[y] >= rowMin[y]) collar.push((rowMin[y] + rowMax[y]) / 2)
  const centre = Math.round(median(collar))
  // The hem: the last row with cloth across the middle of the body.
  const half = Math.max(2, Math.round(full * 0.12))
  let bottom = top
  for (let y = top; y <= last; y++) {
    let on = 0
    for (let x = Math.max(0, centre - half); x <= Math.min(w - 1, centre + half); x++) on += mask[y * w + x]
    if (on >= half) bottom = y
  }
  if (bottom - top < (last - top) * 0.3) bottom = last
  return { top, bottom, last, widest, rowMin, rowMax, centre, hood }
}

// Whether stripes found across the middle of a front (`rows`: horizontal ones; `columns`: vertical ones)
// carry on out to its edges: down a narrow band by either side seam, or along a band just above the hem. A
// striped knit's do; a chest graphic's rows of colour stop short, with plain cloth beyond them. One side is
// enough (the other may be under a sleeve laid over it).
export function reachesEdges(lab, mask, w, x0, x1, top, bottom, way = "rows") {
  const pw = x1 - x0 + 1, ph = bottom - top + 1
  const bands = way === "rows"
    ? [[x0 + Math.round(pw * 0.02), x0 + Math.round(pw * 0.1)], [x1 - Math.round(pw * 0.1), x1 - Math.round(pw * 0.02)]]
    : [[top + Math.round(ph * 0.84), top + Math.round(ph * 0.92)]]
  return bands.some(([from, to]) => {
    const lines = [], within = []
    const count = way === "rows" ? ph : pw
    for (let k = 0; k < count; k++) {
      const L = [], A = [], B = []
      for (let j = from; j <= to; j++) {
        const i = way === "rows" ? (top + k) * w + j : j * w + x0 + k
        if (!mask[i]) continue
        L.push(lab[3 * i]); A.push(lab[3 * i + 1]); B.push(lab[3 * i + 2])
      }
      if (L.length < (to - from + 1) * 0.5) continue
      const line = [median(L), median(A), median(B)]
      lines.push(line)
      within.push(median(L.map((l, n) => Math.abs(l - line[0]) + 0.6 * Math.hypot(A[n] - line[1], B[n] - line[2]))))
    }
    return striped(lines, within, count, false)
  })
}

// Horizontal stripes right across a front: each row is much the same colour along it, and the rows differ
// a lot from one another. Returns one column of pixels (the cloth's colour row by row, from the shoulders to
// the hem, and on down the sleeves where they hang below it, to `last`) when the front is striped, else
// null; its `span` is its height over the body's (shoulders to hem). x0..x1: the middle of the body; the
// zip, a drawcord or a small logo in a row is left out by taking each row's middle value.
export function stripeStrip(data, lab, mask, w, x0, x1, top, bottom, last = bottom, strong = true) {
  const ph = bottom - top + 1, tall = Math.max(ph, last - top + 1)
  const rowsLab = [], within = [], strip = new Uint8ClampedArray(4 * tall), filled = new Uint8Array(tall)
  for (let y = 0; y < tall; y++) {
    const L = [], A = [], B = [], R = [], G = [], Bl = []
    // Below the hem, whatever cloth there is on the row (the sleeves).
    const from = y < ph ? x0 : 0, to = y < ph ? x1 : w - 1
    for (let x = from; x <= to; x++) {
      const i = (top + y) * w + x
      if (!mask[i]) continue
      L.push(lab[3 * i]); A.push(lab[3 * i + 1]); B.push(lab[3 * i + 2])
      R.push(data[4 * i]); G.push(data[4 * i + 1]); Bl.push(data[4 * i + 2])
    }
    if (L.length < (y < ph ? (x1 - x0) * 0.4 : 4)) continue
    const row = [median(L), median(A), median(B)]
    strip.set([Math.round(median(R)), Math.round(median(G)), Math.round(median(Bl)), 255], 4 * y)
    filled[y] = 1
    if (y >= ph) continue
    rowsLab.push(row)
    within.push(median(L.map((l, k) => Math.abs(l - row[0]) + 0.6 * Math.hypot(A[k] - row[1], B[k] - row[2]))))
  }
  if (!striped(rowsLab, within, ph, strong)) return null
  // Rows with no cloth across the middle (none, or the neck opening) take the nearest row's colour.
  let lastFilled = -1
  for (let y = 0; y < tall; y++) {
    if (filled[y]) { lastFilled = y; continue }
    let next = y
    while (next < tall && !filled[next]) next++
    const from = next < tall && (lastFilled < 0 || next - y < y - lastFilled) ? next : lastFilled
    if (from >= 0) strip.set(strip.subarray(4 * from, 4 * from + 4), 4 * y)
  }
  return { data: strip, width: 1, height: tall, span: tall / ph }
}

// Whether lines of a front (its rows' or columns' middle colours, in Lab, in order; within: how much each
// varies along itself) are stripes: neighbouring lines differ a lot more than each line varies along itself.
// Bold stripes need only that, when strong (the front reads as print all over); faint ones (or any, when the
// front hardly reads as print) must also come and go again and again, at least three times across: a fold's
// shadow, a placket or a pocket does once.
export function striped(lines, within, length, strong = true) {
  if (lines.length < 12) return false
  // How much the lines differ: each from the one a little way on (the lines at a stripe's edge). How far on
  // is tried a few ways: narrow stripes have few lines at their edges a whole step apart.
  const base = Math.max(1, Math.round(length * 0.01))
  let changes = 0
  for (let step = 1; step <= Math.max(4, 3 * base); step++) {
    const between = []
    for (let k = 0; k + step < lines.length; k++) {
      const a = lines[k], b = lines[k + step]
      between.push(Math.abs(a[0] - b[0]) + 0.6 * Math.hypot(a[1] - b[1], a[2] - b[2]))
    }
    between.sort((p, q) => p - q)
    if (between.length) changes = Math.max(changes, between[Math.round((between.length - 1) * 0.8)])
  }
  const spread = median(within)
  if (!(changes > 2.5 * spread)) return false
  if (strong && changes > 10) return true
  return changes > 4 && crossings(lines, Math.max(1.5, changes * 0.3)) >= 6
}

// How many times lines' colours swing from one side of their local average to the other (by more than
// `margin` each way), along the direction they vary most (lightness for pale blue on white; hue for red on
// green of the same lightness).
function crossings(lines, margin) {
  const n = lines.length, r = Math.max(3, Math.round(n * 0.06))
  const weighted = lines.map(([l, a, b]) => [l, 0.6 * a, 0.6 * b])
  const off = weighted.map((line, k) => {
    const mean = [0, 0, 0]
    let count = 0
    for (let j = Math.max(0, k - r); j <= Math.min(n - 1, k + r); j++) { for (let c = 0; c < 3; c++) mean[c] += weighted[j][c]; count++ }
    return line.map((v, c) => v - mean[c] / count)
  })
  // The direction they vary most: a few rounds of the power method on their spread.
  const cov = [0, 1, 2].map(i => [0, 1, 2].map(j => off.reduce((sum, d) => sum + d[i] * d[j], 0)))
  let dir = [1, 0.3, 0.3]
  for (let k = 0; k < 20; k++) {
    const next = cov.map(row => row[0] * dir[0] + row[1] * dir[1] + row[2] * dir[2])
    const size = Math.hypot(...next) || 1
    dir = next.map(v => v / size)
  }
  let side = 0, count = 0
  for (const d of off) {
    const s = d[0] * dir[0] + d[1] * dir[1] + d[2] * dir[2]
    const now = s > margin ? 1 : s < -margin ? -1 : 0
    if (now && now !== side) { if (side) count++; side = now }
  }
  return count
}

// Vertical stripes down a front (a striped button-up): each column is much the same colour down it, and the
// columns differ from one another again and again across. The mirror of stripeStrip, over the front's rows
// below the collar and above the hem; x0..x1: the front's width. A button, the pocket or a fold's shadow is
// left out by taking each column's middle value. Returns one row of pixels (the cloth's colour column by
// column across the middle of the front, its sides' shade left off) when it's striped, else null: { data,
// width, height: 1, vertical: true, from, span } (from: where it starts across the front, and span: how much
// of the front it spans, as shares of the front's width).
export function stripeColumns(data, lab, mask, w, x0, x1, top, bottom, strong = true) {
  const pw = x1 - x0 + 1, ph = bottom - top + 1
  const trim = Math.round(pw * 0.06), a = x0 + trim, b = x1 - trim, wide = b - a + 1
  const y0 = top + Math.round(ph * 0.22), y1 = bottom - Math.round(ph * 0.06)
  if (wide < 12 || y1 - y0 < 8) return null
  const colsLab = [], within = [], row = new Uint8ClampedArray(4 * wide), filled = new Uint8Array(wide)
  for (let c = 0; c < wide; c++) {
    const L = [], A = [], B = [], R = [], G = [], Bl = []
    for (let y = y0; y <= y1; y++) {
      const i = y * w + a + c
      if (!mask[i]) continue
      L.push(lab[3 * i]); A.push(lab[3 * i + 1]); B.push(lab[3 * i + 2])
      R.push(data[4 * i]); G.push(data[4 * i + 1]); Bl.push(data[4 * i + 2])
    }
    if (L.length < (y1 - y0 + 1) * 0.4) continue
    const col = [median(L), median(A), median(B)]
    row.set([Math.round(median(R)), Math.round(median(G)), Math.round(median(Bl)), 255], 4 * c)
    filled[c] = 1
    colsLab.push(col)
    within.push(median(L.map((l, k) => Math.abs(l - col[0]) + 0.6 * Math.hypot(A[k] - col[1], B[k] - col[2]))))
  }
  if (colsLab.length < wide * 0.7 || !striped(colsLab, within, pw, strong)) return null
  // Columns with too little cloth down them take the nearest column's colour.
  let lastFilled = -1
  for (let c = 0; c < wide; c++) {
    if (filled[c]) { lastFilled = c; continue }
    let next = c
    while (next < wide && !filled[next]) next++
    const from = next < wide && (lastFilled < 0 || next - c < c - lastFilled) ? next : lastFilled
    if (from >= 0) row.set(row.subarray(4 * from, 4 * from + 4), 4 * c)
  }
  return { data: row, width: wide, height: 1, vertical: true, from: trim / pw, span: wide / pw }
}

// The areas a print covers (0 to 1, soft at the edge): its marks joined up across small gaps (a closing:
// grown by a few per cent of the front's width, then shrunk back), leaving out what's background (gap).
// Specks far from any other mark stay specks, and are dropped (a piece under `least` of the picture).
function printAreas(alpha, gap, w, h, least = 0.002) {
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
    if (piece.length < w * h * least) for (const k of piece) closed[k] = 0
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

// What a segmentation model left out of a garment that's really something else in the photo: a model's
// hand or arm, which reaches in from the garment's outline and is skin, of any tone. Any other part it left
// out (a print, a logo down a seam, a drawstring, which it often takes for something separate) is put back:
// keep is set to 1 there. data: the photo's RGBA pixels. Returns keep.
export function keepInside(mask, keep, w, h, data = null, rim = Math.max(3, Math.round(w * 0.008))) {
  // The garment a few pixels in from its outline: a model's mask often shaves the outline itself, and
  // that thin rim would join a print to the edge.
  let inner = Uint8Array.from(mask)
  for (let pass = 0; pass < rim; pass++) {
    const next = Uint8Array.from(inner)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (inner[i] && (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !inner[i - 1] || !inner[i + 1] || !inner[i - w] || !inner[i + w])) next[i] = 0
    }
    inner = next
  }
  // On the rim itself, only skin goes (a print or logo can reach the very edge).
  if (data) for (let i = 0; i < w * h; i++) if (mask[i] && !inner[i] && !keep[i] && !isSkin(data[4 * i], data[4 * i + 1], data[4 * i + 2])) keep[i] = 1
  mask = inner
  const left = i => mask[i] && !keep[i]
  const seen = new Uint8Array(w * h), stack = []
  for (let start = 0; start < w * h; start++) {
    if (!left(start) || seen[start]) continue
    // One left-out patch, and whether it touches the outline (a pixel next to it outside the cut-out).
    const part = []
    let edge = false
    seen[start] = 1
    stack.push(start)
    while (stack.length) {
      const i = stack.pop()
      part.push(i)
      const x = i % w, y = (i - x) / w
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) { edge = true; continue }
        const j = ny * w + nx
        if (!mask[j]) { edge = true; continue }
        if (left(j) && !seen[j]) { seen[j] = 1; stack.push(j) }
      }
    }
    let skin = 0
    if (data) for (const i of part) if (isSkin(data[4 * i], data[4 * i + 1], data[4 * i + 2])) skin++
    if (!edge || !data || skin < part.length * 0.35) for (const i of part) keep[i] = 1
  }
  return keep
}

// Whether a colour could be skin, light to deep (in YCbCr's usual skin box, and neither near grey nor
// nearly black).
function isSkin(r, g, b) {
  const y = 0.299 * r + 0.587 * g + 0.114 * b
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
  return y > 35 && cb >= 77 && cb <= 127 && cr >= 137 && cr <= 173 && r > b
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
  const image = await loadImage(src).catch(() => null)
  if (!image) return null
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
  const { lab } = cut
  let top = h, bottom = -1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { top = Math.min(top, y); bottom = Math.max(bottom, y) }
  if (bottom <= top) return null
  const soleFrom = bottom - Math.max(2, Math.round((bottom - top) * 0.1))
  // How flat the photo is at each pixel: a panel of leather is flat; a seam, stitching, an edge in shadow
  // and the grain of a lug sole aren't. Flat pixels say what colour a thing is.
  const L = Float32Array.from({ length: w * h }, (_, i) => lab[3 * i])
  const near = boxBlur(L, w, h, 2)
  const flat = Float32Array.from(L, (l, i) => (mask[i] ? 1 - smooth(Math.abs(l - near[i]), 1.5, 6) : 0))
  const hex = c => "#" + c.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")
  // The colour of the largest even patch in a band of rows: the heaviest cell of a coarse Lab histogram
  // (weighted by flatness), then the median colour of the pixels near that cell. Not the mean of the band:
  // on a shoe shot at an angle, the shadowed side and the warm bounce light under it pull a tan mean to
  // orange. Pixels like `not` (within apart) are left out when enough is left without them.
  const patch = (y0, y1, { not = null, apart = 14 } = {}) => {
    const cells = new Map(), picked = []
    for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (!mask[i]) continue
        if (not && Math.hypot(lab[3 * i] - not[0], lab[3 * i + 1] - not[1], lab[3 * i + 2] - not[2]) < apart) continue
        picked.push(i)
        const key = `${Math.round(lab[3 * i] / 8)},${Math.round(lab[3 * i + 1] / 8)},${Math.round(lab[3 * i + 2] / 8)}`
        cells.set(key, (cells.get(key) ?? 0) + 0.15 + flat[i])
      }
    }
    if (!picked.length) return null
    const centre = [...cells.entries()].sort((p, q) => q[1] - p[1])[0][0].split(",").map(v => v * 8)
    const inside = picked.filter(i => Math.hypot(lab[3 * i] - centre[0], lab[3 * i + 1] - centre[1], lab[3 * i + 2] - centre[2]) < 12)
    const from = inside.length >= 8 ? inside : picked
    const colour = [0, 1, 2].map(c => median(from.map(i => data[4 * i + c])))
    return { hex: hex(colour), lab: [0, 1, 2].map(c => median(from.map(i => lab[3 * i + c]))), count: from.length, of: picked.length }
  }
  const upper = patch(top, soleFrom - 1)
  if (!upper) return null
  // The sole: the bottom band of the shoe, in a colour that isn't the upper's when it has one (a sole the
  // same colour as the upper reads as the upper's).
  const soleBand = [soleFrom, bottom]
  let sole = patch(...soleBand, { not: upper.lab })
  const all = patch(...soleBand)
  if (!sole || sole.of < all.of * 0.2) sole = all
  // The band round the top (a boot's padded collar), when it's mostly one colour that isn't the upper's.
  const band = patch(top, top + Math.max(1, Math.round((bottom - top) * 0.07)))
  const apart = band ? Math.hypot(...band.lab.map((v, i) => v - upper.lab[i])) : 0
  const side = shoeSide(data, w, h)
  if (side) delete side.mask
  return { color: upper.hex, sole: sole.hex, collar: apart > 16 && band.count >= band.of * 0.6 ? band.hex : null, side }
}

// A shoe's side photo made ready to wrap round the 3D shoe: the photo with the backdrop round the shoe filled in
// from the shoe's own edge (so no white seeps in where the shoe's outline and the 3D one differ), and where the
// shoe is in it: { canvas, side: { left, right, toeRight, top, bottom } }, the shoe's outline as shares of the
// photo's width and height (top and bottom: the outline's top and bottom edge, heel to toe, in SIDE_BINS steps).
// Null when no shoe stands out.
export async function shoeTexture(src, size = 1024) {
  const image = await loadImage(src).catch(() => null)
  if (!image) return null
  const scale = Math.min(1, size / Math.max(image.naturalWidth, image.naturalHeight))
  const w = Math.max(8, Math.round(image.naturalWidth * scale)), h = Math.max(8, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement("canvas")
  canvas.width = w
  canvas.height = h
  const context = canvas.getContext("2d", { willReadFrequently: true })
  context.drawImage(image, 0, 0, w, h)
  const pixels = context.getImageData(0, 0, w, h)
  // The outline is read on a smaller copy (as the colours are), the texture kept sharp.
  const small = Math.min(1, SIZE / Math.max(w, h))
  const sw = Math.max(8, Math.round(w * small)), sh = Math.max(8, Math.round(h * small))
  const reader = document.createElement("canvas")
  reader.width = sw
  reader.height = sh
  const rc = reader.getContext("2d", { willReadFrequently: true })
  rc.drawImage(canvas, 0, 0, sw, sh)
  const side = shoeSide(rc.getImageData(0, 0, sw, sh).data, sw, sh)
  if (!side) return null
  bleed(pixels.data, w, h, side.mask, sw, sh)
  context.putImageData(pixels, 0, 0)
  delete side.mask
  return { canvas, side }
}

// One of the shop's other photos of a shoe made ready to lay on it (see shoeView): the backdrop round the shoes
// filled in from their edges. A canvas, or null.
export async function viewTexture(src, size = 1024) {
  const image = await loadImage(src).catch(() => null)
  if (!image) return null
  const scale = Math.min(1, size / Math.max(image.naturalWidth, image.naturalHeight))
  const w = Math.max(8, Math.round(image.naturalWidth * scale)), h = Math.max(8, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement("canvas")
  canvas.width = w
  canvas.height = h
  const context = canvas.getContext("2d", { willReadFrequently: true })
  context.drawImage(image, 0, 0, w, h)
  const pixels = context.getImageData(0, 0, w, h)
  const small = Math.min(1, SIZE / Math.max(w, h))
  const sw = Math.max(8, Math.round(w * small)), sh = Math.max(8, Math.round(h * small))
  const reader = document.createElement("canvas")
  reader.width = sw
  reader.height = sh
  const rc = reader.getContext("2d", { willReadFrequently: true })
  rc.drawImage(canvas, 0, 0, sw, sh)
  const cut = cutOut(rc.getImageData(0, 0, sw, sh).data, sw, sh)
  if (!cut) return null
  bleed(pixels.data, w, h, cut.all, sw, sh)
  context.putImageData(pixels, 0, 0)
  return canvas
}

export const SIDE_BINS = 64

// Where the shoe is in a side photo (see shoeTexture), with its mask at the photo's size.
export function shoeSide(data, w, h) {
  const cut = cutOut(data, w, h)
  if (!cut) return null
  const mask = cut.garment.mask.slice()
  // The backdrop seen through the shoe (between the laces, under a pulled-up loop) isn't the shoe: small
  // backdrop-coloured holes in it are taken out. A white shoe's own big white panels stay.
  const { lab, bg, far } = cut
  const backdrop = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) backdrop[i] = mask[i] && Math.abs(lab[3 * i] - bg[0]) <= far[0] && Math.hypot(lab[3 * i + 1] - bg[1], lab[3 * i + 2] - bg[2]) <= far[1] ? 1 : 0
  for (const hole of pieces(backdrop, w, h)) if (hole.length < cut.garment.count * 0.06) for (const i of hole) mask[i] = 0
  let left = w, right = -1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { left = Math.min(left, x); right = Math.max(right, x) }
  if (right - left < w * 0.15) return null
  let high = h, low = -1
  for (let y = 0; y < h; y++) for (let x = left; x <= right; x++) if (mask[y * w + x]) { high = Math.min(high, y); low = Math.max(low, y) }
  // A side view: a shoe stands one to five times as long as it's tall (a front or top view doesn't).
  const long = (right - left + 1) / (low - high + 1)
  if (long < 1 || long > 5) return null
  const top = new Float64Array(SIDE_BINS).fill(Infinity), bottom = new Float64Array(SIDE_BINS).fill(-Infinity)
  for (let x = left; x <= right; x++) {
    const bin = Math.min(SIDE_BINS - 1, Math.floor(((x - left) / (right - left + 1)) * SIDE_BINS))
    for (let y = 0; y < h; y++) {
      if (!mask[y * w + x]) continue
      top[bin] = Math.min(top[bin], y)
      bottom[bin] = Math.max(bottom[bin], y + 1)
    }
  }
  // Gaps (a bin with no column) take their neighbour's.
  for (let b = 1; b < SIDE_BINS; b++) if (!Number.isFinite(top[b])) { top[b] = top[b - 1]; bottom[b] = bottom[b - 1] }
  for (let b = SIDE_BINS - 2; b >= 0; b--) if (!Number.isFinite(top[b])) { top[b] = top[b + 1]; bottom[b] = bottom[b + 1] }
  // The toe is the low end: a shoe stands taller at the heel.
  const quarter = Math.round(SIDE_BINS / 4)
  const tall = (from, to) => { let sum = 0; for (let b = from; b < to; b++) sum += bottom[b] - top[b]; return sum / (to - from) }
  const toeRight = tall(SIDE_BINS - quarter, SIDE_BINS) < tall(0, quarter)
  // How thick the sole is: up from the bottom, as far as the colour stays the sole's (the bottom few rows'),
  // in most columns. Sole and upper the same colour: a usual sole, a seventh of the shoe's height.
  const soleThick = soleThickness(lab, mask, w, h, left, right, top, bottom) ?? (low - high) / 7
  // The outline's front and back at each height (shares of its length, heel 0 to toe 1), from the floor up in
  // SIDE_BINS steps to its top: how blunt the toe is, how the heel curves, how wide the shaft stands.
  const ends = { front: new Array(SIDE_BINS).fill(null), back: new Array(SIDE_BINS).fill(null) }
  for (let r = 0; r < SIDE_BINS; r++) {
    const y = Math.round(low - ((r + 0.5) / SIDE_BINS) * (low - high))
    let first = -1, last = -1
    for (let x = left; x <= right; x++) if (mask[y * w + x]) { if (first < 0) first = x; last = x }
    if (first < 0) continue
    const share = x => (x - left) / (right - left + 1)
    ends.front[r] = toeRight ? share(last + 1) : 1 - share(first)
    ends.back[r] = toeRight ? share(first) : 1 - share(last + 1)
  }
  for (const list of [ends.front, ends.back]) {
    for (let r = 1; r < SIDE_BINS; r++) if (list[r] === null) list[r] = list[r - 1]
    for (let r = SIDE_BINS - 2; r >= 0; r--) if (list[r] === null) list[r] = list[r + 1]
  }
  // A pixel in from the edge, so the outline's own soft edge isn't wrapped on.
  const inset = Math.max(2, h * 0.008)
  const order = toeRight ? b => b : b => SIDE_BINS - 1 - b
  return {
    left: left / w, right: (right + 1) / w, toeRight, aspect: h / w,
    top: Array.from({ length: SIDE_BINS }, (_, b) => (top[order(b)] + inset) / h),
    bottom: Array.from({ length: SIDE_BINS }, (_, b) => (bottom[order(b)] - inset) / h),
    sole: Array.from({ length: SIDE_BINS }, (_, b) => Math.max(top[order(b)] + inset, bottom[order(b)] - soleThick) / h),
    front: ends.front, back: ends.back, height: (low - high + 1) / h,
    // Its colours, for telling the shop's other photos apart (see shoeView): the upper's and the sole's,
    // and up its heel's and its toe's ends (Lab, in VIEW_BANDS from the floor up).
    colours: shoeColours(lab, mask, w, h, { left, right, high, low, toeRight, soleThick }),
    mask, w, h
  }
}

const VIEW_BANDS = 8

function shoeColours(lab, mask, w, h, { left, right, high, low, toeRight, soleThick }) {
  const at = (x0, x1, y0, y1) => {
    const values = [[], [], []]
    for (let y = Math.max(0, Math.round(y0)); y <= Math.min(h - 1, Math.round(y1)); y++) {
      for (let x = Math.max(0, Math.round(x0)); x <= Math.min(w - 1, Math.round(x1)); x++) {
        const i = y * w + x
        if (mask[i]) for (let c = 0; c < 3; c++) values[c].push(lab[3 * i + c])
      }
    }
    return values[0].length ? values.map(median) : null
  }
  const long = right - left, tall = low - high
  const strip = share => {
    const x = toeRight ? left + share * long : right - share * long
    // Up from the floor: each band's colour, a few pixels in from that end.
    return Array.from({ length: VIEW_BANDS }, (_, b) => at(x - long * 0.03, x + long * 0.03, low - ((b + 1) / VIEW_BANDS) * tall, low - (b / VIEW_BANDS) * tall))
  }
  return {
    upper: at(left + long * 0.3, right - long * 0.3, high + tall * 0.4, low - soleThick - tall * 0.05),
    sole: at(left + long * 0.2, right - long * 0.2, low - soleThick * 0.8, low - soleThick * 0.2),
    heel: strip(0.06), toe: strip(0.94)
  }
}

// What one of the shop's other photos of a shoe shows, read against its side photo (side: shoeSide's): a
// view from above ("top"), from behind ("back") or in front ("front"), each one shoe or a pair standing
// apart; or null (a sole, a close-up, a pair at an angle, which can't be laid on the 3D shoe). Each shoe in
// it: its box (shares of the photo) and its outline across in VIEW_ROWS rows (top to bottom), and for a top
// view whether its toe is up. Shops photograph these square on, which is what's used.
// The same for a photo's address (see shoeView), with the photo itself: { ...view, photo: src }, or null.
export async function readShoeView(src, side) {
  const image = await loadImage(src).catch(() => null)
  if (!image) return null
  const scale = Math.min(1, SIZE / Math.max(image.naturalWidth, image.naturalHeight))
  const w = Math.max(8, Math.round(image.naturalWidth * scale)), h = Math.max(8, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement("canvas")
  canvas.width = w
  canvas.height = h
  const context = canvas.getContext("2d", { willReadFrequently: true })
  context.drawImage(image, 0, 0, w, h)
  const view = shoeView(context.getImageData(0, 0, w, h).data, w, h, side)
  return view && { ...view, photo: src }
}

export const VIEW_ROWS = 48
export function shoeView(data, w, h, side) {
  // A pair lying touching (seen from above, side by side) is tried split in two when it isn't one shoe.
  return viewOf(data, w, h, side, false) ?? viewOf(data, w, h, side, true)
}

function viewOf(data, w, h, side, pair) {
  if (!side?.colours?.upper) return null
  const cut = cutOut(data, w, h)
  if (!cut) return null
  const { lab } = cut
  const all = pieces(cut.all, w, h).sort((a, b) => b.length - a.length)
  if (!all.length) return null
  // The shoes: the big pieces, a pair touching split where the columns between them are nearly empty.
  const big = all.filter(p => p.length > all[0].length * 0.35)
  if (big.length > 2) return null
  const split = piece => {
    let x0 = w, x1 = -1
    for (const i of piece) { const x = i % w; x0 = Math.min(x0, x); x1 = Math.max(x1, x) }
    const columns = new Float64Array(w)
    for (const i of piece) columns[i % w]++
    const most = Math.max(...columns)
    let cut = -1, least = Infinity
    for (let x = Math.round(x0 + (x1 - x0) * 0.3); x <= Math.round(x0 + (x1 - x0) * 0.7); x++) if (columns[x] < least) { least = columns[x]; cut = x }
    if (cut < 0 || least > most * (pair ? 0.75 : 0.35)) return [piece]
    return [piece.filter(i => i % w < cut), piece.filter(i => i % w >= cut)]
  }
  const shoes = big.length === 1 ? split(big[0]) : big
  const boxes = shoes.map(piece => {
    let x0 = w, x1 = -1, y0 = h, y1 = -1
    for (const i of piece) { const x = i % w, y = (i - x) / w; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
    const inside = new Uint8Array(w * h)
    for (const i of piece) inside[i] = 1
    return { piece, inside, x0, x1, y0, y1, fill: piece.length / ((x1 - x0 + 1) * (y1 - y0 + 1)) }
  }).sort((a, b) => a.x0 - b.x0)
  // A close-up runs off the photo's edge.
  if (boxes.some(b => b.x0 <= 1 || b.y0 <= 1 || b.x1 >= w - 2 || b.y1 >= h - 2)) return null
  // A pair: side by side, the same size.
  if (boxes.length === 2) {
    const [a, b] = boxes
    if (a.x1 > b.x0 + 1 || Math.abs((a.y1 - a.y0) / (b.y1 - b.y0) - 1) > 0.25) return null
  }
  const distance = (p, q) => p && q ? Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) : Infinity
  const colourOf = (box, y0, y1, x0 = box.x0, x1 = box.x1) => {
    const values = [[], [], []]
    for (let y = Math.max(0, Math.round(y0)); y <= Math.min(h - 1, Math.round(y1)); y++) {
      for (let x = Math.max(0, Math.round(x0)); x <= Math.min(w - 1, Math.round(x1)); x++) {
        const i = y * w + x
        if (box.inside[i]) for (let c = 0; c < 3; c++) values[c].push(lab[3 * i + c])
      }
    }
    return values[0].length ? values.map(median) : null
  }
  const box = boxes[0], bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1
  const rows = b => Array.from({ length: VIEW_ROWS }, (_, r) => {
    const y = Math.min(h - 1, Math.round(b.y0 + ((r + 0.5) / VIEW_ROWS) * (b.y1 - b.y0)))
    let first = -1, last = -1
    for (let x = b.x0; x <= b.x1; x++) if (b.inside[y * w + x]) { if (first < 0) first = x; last = x }
    return first < 0 ? null : [first / w, (last + 1) / w]
  })
  const fill = list => {
    for (let r = 1; r < list.length; r++) list[r] ??= list[r - 1]
    for (let r = list.length - 2; r >= 0; r--) list[r] ??= list[r + 1]
    return list
  }
  const shoeOf = (b, extra = {}) => ({ left: b.x0 / w, right: (b.x1 + 1) / w, top: b.y0 / h, bottom: (b.y1 + 1) / h, rows: fill(rows(b)), ...extra })
  const tall = bh / bw
  // How far its outline's middle wanders from row to row, as a share of its width: little for a shoe seen
  // square on from behind, in front or above; a lot for a pair at an angle.
  const across = rows(box).filter(Boolean).map(([l, r]) => ((l + r) / 2) * w)
  const centre = across.reduce((a, b) => a + b, 0) / across.length
  const wander = across.reduce((sum, c) => sum + Math.abs(c - centre), 0) / across.length / bw
  // Seen from above, a shoe is round at both ends; from behind or in front it stands on its sole, full width.
  const widths = rows(box).map(r => (r ? r[1] - r[0] : 0)), widest = Math.max(...widths)
  const ends = [widths[2], widths[VIEW_ROWS - 3]].map(v => v / widest)
  const stands = ends[1] > 0.75
  if (tall > 1.9 && tall < 4.5 && box.fill > 0.45 && wander < 0.09 && Math.max(...ends) < 0.75) {
    // From above, not below: the opening (the lining, the insole) shows in the heel's half, unlike the
    // shoe's edge; a sole is one colour all over.
    const toeUpGuess = (() => { const widths = rows(box).map(r => (r ? r[1] - r[0] : 0)); return widths.indexOf(Math.max(...widths)) / VIEW_ROWS < 0.5 })()
    const heelY = toeUpGuess ? box.y0 + bh * 0.8 : box.y0 + bh * 0.2
    const opening = colourOf(box, heelY - bh * 0.06, heelY + bh * 0.06, box.x0 + bw * 0.4, box.x1 - bw * 0.4)
    const rim = colourOf(box, box.y0 + bh * 0.45, box.y0 + bh * 0.55, box.x0, box.x0 + bw * 0.15)
    if (distance(opening, rim) < 10) return null
    // The toe is the end nearer the shoe's widest point (the ball of the foot).
    const widths = rows(box).map(r => (r ? r[1] - r[0] : 0))
    const widest = widths.indexOf(Math.max(...widths)) / VIEW_ROWS
    const toeUp = widest < 0.5
    return { kind: "top", aspect: h / w, shoes: boxes.map(b => shoeOf(b, { toeUp })) }
  }
  if (tall > 0.7 && tall < 3.2 && box.fill > 0.5 && wander < 0.04 && stands) {
    // From behind or in front: which end of the side photo its middle, floor to top, looks like.
    const strip = Array.from({ length: VIEW_BANDS }, (_, band) => colourOf(box, box.y1 - ((band + 1) / VIEW_BANDS) * bh, box.y1 - (band / VIEW_BANDS) * bh, box.x0 + bw * 0.4, box.x1 - bw * 0.4))
    const gap = ends => strip.reduce((sum, c, band) => sum + Math.min(40, distance(c, ends[band])), 0)
    const heel = gap(side.colours.heel), toe = gap(side.colours.toe)
    if (Math.abs(heel - toe) < VIEW_BANDS * 1.5) return null
    // Its bottom is level (the sole standing on the floor), not a pair at an angle.
    return { kind: heel < toe ? "back" : "front", aspect: h / w, shoes: boxes.map(b => shoeOf(b)) }
  }
  return null
}

// A shoe's sole's thickness in a side photo (pixels), or null when the sole isn't told apart from the upper.
function soleThickness(lab, mask, w, h, left, right, top, bottom) {
  const bins = top.length, middle = []
  for (let b = Math.round(bins * 0.15); b < Math.round(bins * 0.85); b++) middle.push(b)
  const columnsOf = b => [Math.round(left + ((b + 0.5) / bins) * (right - left + 1))]
  // The sole's colour: the bottom rows'; the upper's: halfway up.
  const near = (rowOf) => {
    const values = [[], [], []]
    for (const b of middle) for (const x of columnsOf(b)) {
      const y = Math.round(rowOf(b)), i = y * w + x
      if (y >= 0 && y < h && mask[i]) for (let c = 0; c < 3; c++) values[c].push(lab[3 * i + c])
    }
    return values[0].length ? values.map(median) : null
  }
  const sole = near(b => bottom[b] - 2 - (bottom[b] - top[b]) * 0.02), upper = near(b => (top[b] + bottom[b]) / 2)
  if (!sole || !upper) return null
  const gap = Math.hypot(sole[0] - upper[0], sole[1] - upper[1], sole[2] - upper[2])
  if (gap < 8) return null
  const thick = []
  for (const b of middle) {
    for (const x of columnsOf(b)) {
      let run = 0, y = bottom[b] - 1
      for (; y > top[b]; y--) {
        const i = y * w + x
        const d = Math.hypot(lab[3 * i] - sole[0], lab[3 * i + 1] - sole[1], lab[3 * i + 2] - sole[2])
        run = d > gap / 2 ? run + 1 : 0
        if (run >= 3) break
      }
      thick.push(bottom[b] - (y + 3))
    }
  }
  const t = median(thick), tall = median(middle.map(b => bottom[b] - top[b]))
  return t > tall * 0.05 && t < tall * 0.45 ? t : null
}

// Fills the photo's pixels outside the shoe (mask, sw x sh) with the nearest shoe pixel's colour, a ring at a time.
function bleed(data, w, h, mask, sw, sh) {
  // In from the mask's edge (its soft, backdrop-tinted rim is filled over too).
  const rim = Math.max(2, Math.round(Math.max(sw, sh) * 0.008))
  const core = new Uint8Array(sw * sh)
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let all = 1
      for (let dy = -rim; dy <= rim && all; dy++) for (let dx = -rim; dx <= rim; dx++) {
        const yy = y + dy, xx = x + dx
        if (yy < 0 || yy >= sh || xx < 0 || xx >= sw || !mask[yy * sw + xx]) { all = 0; break }
      }
      core[y * sw + x] = all
    }
  }
  const inside = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const my = Math.min(sh - 1, Math.floor((y / h) * sh))
    for (let x = 0; x < w; x++) inside[y * w + x] = core[my * sw + Math.min(sw - 1, Math.floor((x / w) * sw))]
  }
  let front = []
  for (let i = 0; i < w * h; i++) if (inside[i]) front.push(i)
  const rings = Math.round(Math.max(w, h) * 0.12)
  for (let r = 0; r < rings && front.length; r++) {
    const next = []
    for (const i of front) {
      const x = i % w
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= w * h || inside[j]) continue
        inside[j] = 1
        data[4 * j] = data[4 * i]; data[4 * j + 1] = data[4 * i + 1]; data[4 * j + 2] = data[4 * i + 2]
        next.push(j)
      }
    }
    front = next
  }
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
  return { lab, bg, garment, far, all: mask }
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
  const rows = garmentRows(cut.garment.mask, w, h)
  if (!rows) return null
  // From the shoulder line (below a hood worn up) to the hem (sleeves may hang on below it).
  const { top: shoulders, bottom, rowMin, rowMax, centre } = rows
  const body = bottom - shoulders + 1
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
  for (let y = shoulders; y < h; y++) if (full(y) > chest * 1.08) { cuff = y; outer = Math.max(outer, (full(y) - chest) / 2) }
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
  // The crotch: the first row, a little way down, where the garment parts into two legs and stays parted
  // (nearly every row for the next 15% of its length: a drawstring's gap or a pocket's below the waistband
  // closes again).
  let crotch = -1
  const parted = y => runs(Math.min(bottom, y)).length >= 2
  for (let y = row(0.12); y <= row(0.95) && crotch < 0; y++) {
    if (runs(y).length !== 2) continue
    const span15 = Math.max(4, Math.min(Math.round(tall * 0.15), bottom - y))
    let apart = 0
    for (let k = 0; k < span15; k++) if (parted(y + k)) apart++
    if (apart >= span15 * 0.9) crotch = y
  }
  // Long pants whose wide legs lie touching for most of their length part only near the hem: the crotch is
  // about a third of the way down, as on most pants.
  // And long pants don't part higher than about 28% of the way down (waist to crotch is 25 to 35 cm of 90 to
  // 110): a parting above that is the shadow along the front seam, with the legs lying touching below it.
  if (crotch >= 0 && tall / waist > 1.8 && ((crotch - top) / tall > 0.55 || (crotch - top) / tall < 0.27)) crotch = Math.round(top + tall * 0.33)
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
  const image = await loadImage(src).catch(() => null)
  if (!image) return null
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
    // Only down the middle, between the legs: a light logo down a leg's outer seam, as near the backdrop's
    // colour as that sliver, stays.
    const middle = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) {
      let a = -1, b = -1
      for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (a < 0) a = x; b = x }
      if (a < 0) continue
      const from = Math.round(a + (b - a) * 0.3), to = Math.round(b - (b - a) * 0.3)
      for (let x = from; x <= to; x++) middle[y * w + x] = 1
    }
    const strict = Uint8Array.from(mask, (on, i) => (on && (!middle[i] || Math.hypot(lab[3 * i] - bg[0], lab[3 * i + 1] - bg[1], lab[3 * i + 2] - bg[2]) > apart * 0.35) ? 1 : 0))
    mask = largestPiece(strict, w, h).mask
    ;[top, bottom] = extent()
  }
  if (hanger.hung) {
    mask = belowHangerBar(mask, w, h, lab, clothLab, top, bottom)
    ;[top, bottom] = extent()
  }
  // The backdrop seen through the garment (inside a drawcord's loop, between a pocket and the leg) isn't
  // cloth: small backdrop-coloured holes are painted over like the backdrop round it, rather than laid on
  // the 3D cloth as white specks. Not a white print's: one far from the backdrop's colour stays.
  {
    const backdrop = new Uint8Array(w * h)
    for (let i = 0; i < w * h; i++) backdrop[i] = mask[i] && Math.hypot(lab[3 * i] - bg[0], lab[3 * i + 1] - bg[1], lab[3 * i + 2] - bg[2]) < Math.max(4, apart * 0.25) ? 1 : 0
    let area = 0
    for (let i = 0; i < w * h; i++) area += mask[i]
    mask = Uint8Array.from(mask)
    for (const hole of pieces(backdrop, w, h)) if (hole.length < area * 0.01) for (const i of hole) mask[i] = 0
  }
  // Something thin hanging below the hem (a drawcord's end, a tag, lettering running off the leg) isn't the
  // garment: the rows at the bottom far narrower than the legs above them go.
  {
    const span = y => runs(y).reduce((sum, [a, b]) => sum + (b - a + 1), 0)
    let widest = 0
    for (let y = Math.round(bottom - (bottom - top) * 0.3); y <= bottom; y++) widest = Math.max(widest, span(y))
    let y = bottom
    while (y > top && span(y) < widest * 0.3) y--
    if (y < bottom) {
      mask = Uint8Array.from(mask)
      mask.fill(0, (y + 1) * w)
      ;[top, bottom] = extent()
    }
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
  // pixels go too: half backdrop, and lit along the cloth's rounded edge as it lies flat, they'd leave a light
  // rim round it, which on the draped cloth runs down the side seams as a pale band.
  const rim = Math.max(1, Math.round(w * 0.012))
  const inner = boxBlur(Float32Array.from(mask), w, h, rim).map(v => (v > 0.999 ? 1 : 0))
  // Out to well past the garment too (in coarser colours), so cloth laid a little outside the photo's
  // outline (a hip rounder than it lay flat) never shows the backdrop.
  const lit = evenLight(data, inner, w, h)
  const fillIn = keep => {
    const painted = fillAround(lit, keep, w, h, Math.max(4, Math.round(w * 0.03)))
    const reached = Uint8Array.from({ length: w * h }, (_, i) => (keep[i] || painted[4 * i + 3] === 254 ? 1 : 0))
    return fillAround(painted, reached, w, h, Math.max(8, Math.round(w * 0.12)))
  }
  const filled = fillIn(inner)
  // The back isn't photographed, and takes the softened copy: a print on the front (lettering down a leg, a
  // hip logo, a contrast pocket) would show on it as a mirrored smear, so it's painted over in the cloth
  // round it there, like the backdrop is. The cloth's wash and fading, its seams and its bands stay.
  const print = bottomsPrint(lab, clothLab, inner, w, h, runs)
  const plain = print.some(Boolean) ? fillIn(Uint8Array.from(inner, (on, i) => (on && !print[i] ? 1 : 0))) : filled
  const soft = blurPixels(plain, inner, w, h, Math.max(3, Math.round(w * 0.025)))
  return { color, filled, soft, print, layout: { w, h, top, bottom, crotch, rows } }
}

// Where a print lies on a bottoms photo (1 per pixel): the garment's pixels far from the cloth's colour, in
// solid areas joined up as a print is (see printAreas). Not a band running right across the garment or a
// leg (a contrast waistband, a stripe round the hem: those go round the back too), nor a broad patch most
// of a leg's size (a heavy fade, a two-tone cloth, which the back shares).
function bottomsPrint(lab, cloth, mask, w, h, runs) {
  const alpha = new Float32Array(w * h)
  let area = 0
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) continue
    area++
    const dl = Math.abs(lab[3 * i] - cloth[0]), dc = Math.hypot(lab[3 * i + 1] - cloth[1], lab[3 * i + 2] - cloth[2])
    alpha[i] = Math.min(1, Math.max(smooth(dl, 22, 34), smooth(dc, 16, 26)))
  }
  const solid = boxBlur(alpha, w, h, 2)
  for (let i = 0; i < w * h; i++) alpha[i] *= smooth(solid[i], 0.3, 0.55)
  const gap = Uint8Array.from(mask, on => (on ? 0 : 1))
  const whole = printAreas(alpha, gap, w, h, 0.0004)
  const print = Uint8Array.from(whole, v => (v > 0.5 ? 1 : 0))
  for (const piece of pieces(print, w, h)) {
    let drop = piece.length > area * 0.3
    if (!drop) {
      // A band: on most of its rows it spans nearly all of the stretch of garment it lies on.
      const byRow = new Map()
      for (const i of piece) {
        const x = i % w, y = (i - x) / w
        const span = byRow.get(y) ?? [x, x]
        span[0] = Math.min(span[0], x); span[1] = Math.max(span[1], x)
        byRow.set(y, span)
      }
      let banded = 0
      for (const [y, [a, b]] of byRow) {
        const run = runs(y).find(([p, q]) => a >= p - 2 && b <= q + 2)
        if (!run) continue
        // The stretch as far as the garment's pixels go (its rim is left out of mask).
        let p = run[0], q = run[1]
        while (p < q && !mask[y * w + p]) p++
        while (q > p && !mask[y * w + q]) q--
        if (b - a >= (q - p) * 0.85) banded++
      }
      drop = banded >= byRow.size * 0.6
    }
    if (drop) for (const i of piece) print[i] = 0
  }
  return print
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
    // (Marked as painted, for a second, wider pass.)
    out[4 * i + 3] = 254
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
  const image = await loadImage(src).catch(() => null)
  if (!image) return null
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
// Each joined piece of a mask: a list of its pixels' indexes.
function pieces(mask, w, h) {
  const seen = new Uint8Array(w * h), out = []
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || seen[start]) continue
    const piece = [start]
    seen[start] = 1
    for (let k = 0; k < piece.length; k++) {
      const i = piece[k], x = i % w
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= w * h || !mask[j] || seen[j]) continue
        seen[j] = 1
        piece.push(j)
      }
    }
    out.push(piece)
  }
  return out
}

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

// A box blur of radius r (the mean over the 2r+1 square, cut off at the picture's edge), as a running sum
// along each row, then each column.
function boxBlur(values, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h)
  const run = (get, set, length, stride, start) => {
    let s = 0
    for (let k = 0; k <= Math.min(r, length - 1); k++) s += get(start + k * stride)
    for (let i = 0; i < length; i++) {
      const lo = Math.max(0, i - r), hi = Math.min(length - 1, i + r)
      set(start + i * stride, s / (hi - lo + 1))
      if (i + r + 1 < length) s += get(start + (i + r + 1) * stride)
      if (i - r >= 0) s -= get(start + (i - r) * stride)
    }
  }
  for (let y = 0; y < h; y++) run(i => values[i], (i, v) => { tmp[i] = v }, w, 1, y * w)
  for (let x = 0; x < w; x++) run(i => tmp[i], (i, v) => { out[i] = v }, h, w, x)
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
