// Graphics on pants' legs (lettering down a side seam, a logo on a thigh), laid on the 3D legs as one piece
// each, by measurement, rather than with the rest of the photo.
//
// The photo of a pair of pants is laid on its legs row by row (photo_map.js, and redrape.js after the drape),
// each row's share of the way across the photo's leg carried to the same share across the cloth's. That suits
// a wash or a fade, but tears a word: each row is shifted its own way, and lettering down the outside of a leg
// sits where a flat photo squeezes the leg most (its fold) and where the photo of the back shows the same
// lettering again. Kith's Essentials MLB Lounge Sweatpant came out as torn, doubled letters.
//
// So each graphic is found in the photo (findLegPrints: marks far from the cloth's colour, joined into words),
// painted out of the photo the legs take (cleanPixels, so the torn copy isn't drawn under it), and laid on by
// measurement (legPrintUV): as far down the leg as it is below the waistband in the photo, and as far in from
// the side seam as it is in from the leg's outer edge, at one scale both ways (the photo's pixels per cm), so
// it can't be sheared or stretched. A graphic the photo of the back shows again (the same leg, the same
// height, at its outer edge: the side seam's lettering seen from behind) is laid once, from the front.
import { legSpan, onPhoto } from "lib/garments/photo_map"

// How far from the cloth's colour (RGB) a mark is.
const MARK_GAP = 70
// Marks within this share of the garment's width of each other are one graphic (letters of a word).
const JOIN = 0.015
// A graphic is at least this share of the garment (smaller is a speck or a seam's glint) and at least this
// share of its height or width long.
const LEAST_AREA = 0.0015, LEAST_SPAN = 0.03

function median(values) {
  const v = values.slice().sort((a, b) => a - b)
  return v[v.length >> 1] ?? 0
}

// The row's garment span [left, right] and, below the crotch, the legs' inner edges ([-1, -1] above it).
function rowOf(layout, y) {
  const k = 4 * (y - layout.top)
  const r = layout.rows
  return { left: r[k], right: r[k + 1], innerLeft: r[k + 2], innerRight: r[k + 3] }
}

// Whether pixel (x, y) is on the garment by its layout, and how far in from its nearest outline edge.
function onGarment(layout, x, y) {
  if (y < layout.top || y > layout.bottom) return -1
  const row = rowOf(layout, y)
  if (!(row.right > row.left) || x < row.left || x > row.right) return -1
  if (row.innerLeft >= 0 && x > row.innerLeft && x < row.innerRight) return -1
  let edge = Math.min(x - row.left, row.right - x)
  if (row.innerLeft >= 0) edge = Math.min(edge, Math.abs(x - row.innerLeft), Math.abs(x - row.innerRight))
  return edge
}

// A mask grown by r pixels (a square): two passes of a running count.
export function dilate(mask, w, h, r) {
  if (r <= 0) return Uint8Array.from(mask)
  const across = new Uint8Array(w * h), out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    let count = 0
    for (let x = -r; x < w; x++) {
      const add = x + r, drop = x - r - 1
      if (add < w && mask[y * w + add]) count++
      if (drop >= 0 && mask[y * w + drop]) count--
      if (x >= 0) across[y * w + x] = count > 0 ? 1 : 0
    }
  }
  for (let x = 0; x < w; x++) {
    let count = 0
    for (let y = -r; y < h; y++) {
      const add = y + r, drop = y - r - 1
      if (add < h && across[add * w + x]) count++
      if (drop >= 0 && across[drop * w + x]) count--
      if (y >= 0) out[y * w + x] = count > 0 ? 1 : 0
    }
  }
  return out
}

// How far a pixel's colour is from every blend of the backdrop's and the cloth's (RGB): an outline's soft
// edge is such a blend, a graphic's colour isn't (cream lettering against a pale grey backdrop and black
// cloth is 25 or so off the grey between them).
const BLEND_GAP = 16
function offBlend(data, i, a, b) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], p = [data[i] - a[0], data[i + 1] - a[1], data[i + 2] - a[2]]
  const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
  const t = dd ? Math.min(1, Math.max(0, (p[0] * d[0] + p[1] * d[1] + p[2] * d[2]) / dd)) : 0
  return Math.hypot(p[0] - t * d[0], p[1] - t * d[1], p[2] - t * d[2])
}

// The backdrop's colour: the median of the photo's top and bottom rows.
function backdropOf(data, w, h) {
  const s = [[], [], []]
  for (let x = 0; x < w; x += 3) for (const y of [0, h - 1]) { const i = 4 * (y * w + x); s[0].push(data[i]); s[1].push(data[i + 1]); s[2].push(data[i + 2]) }
  return s.map(median)
}

// The cloth's colour: the median of the garment's pixels.
function clothColour(data, w, layout) {
  const s = [[], [], []]
  for (let y = layout.top; y <= layout.bottom; y += 3) for (let x = 0; x < w; x += 3) {
    if (onGarment(layout, x, y) < 0) continue
    const i = 4 * (y * w + x)
    s[0].push(data[i]); s[1].push(data[i + 1]); s[2].push(data[i + 2])
  }
  return s.map(median)
}

// The graphics in a pants photo (RGBA data, w by h, with print.js's readBottom layout): { cloth: [r, g, b],
// prints: [{ box: [x0, y0, x1, y1] (pixels, inclusive), side: "L" | "R" (the wearer's leg), behind, edge:
// [a, b] (the leg's outer edge, x = a + b y, over the graphic's rows) }], mask: the graphics' pixels, grown a
// little (what cleanPixels paints out) }. behind: the photo is of the back (the wearer's left on its left).
export function findLegPrints(data, w, h, layout, { behind = false } = {}) {
  const none = { cloth: null, prints: [], mask: new Uint8Array(w * h) }
  if (!layout?.rows || layout.crotch == null) return none
  const cloth = clothColour(data, w, layout)
  const tall = layout.bottom - layout.top
  let widest = 0
  for (let y = layout.top; y <= layout.bottom; y++) { const r = rowOf(layout, y); widest = Math.max(widest, r.right - r.left) }
  if (widest < 20 || tall < 20) return none
  // The marks: far from the cloth's colour, on the garment, not right at its outline (where flat-laid cloth
  // turns away and catches the light in a pale rim).
  const rim = Math.max(2, Math.round(widest * 0.006))
  // Lettering at the leg's very edge, in a colour near the backdrop's (cream on a pale grey), is cut off the
  // garment's outline as backdrop: just outside the outline, what isn't the backdrop's colour is graphic too.
  const bg = backdropOf(data, w, h)
  const beyond = Math.max(3, Math.round(widest * 0.1))
  const marks = new Uint8Array(w * h)
  let area = 0, count = 0
  for (let y = layout.top; y <= layout.bottom; y++) {
    const row = rowOf(layout, y)
    for (let x = 0; x < w; x++) {
      const i = 4 * (y * w + x)
      const far = Math.hypot(data[i] - cloth[0], data[i + 1] - cloth[1], data[i + 2] - cloth[2]) > MARK_GAP
      const edge = onGarment(layout, x, y)
      if (edge < 0) {
        const outside = row.right > row.left && ((x < row.left && row.left - x <= beyond) || (x > row.right && x - row.right <= beyond))
        if (outside && far && offBlend(data, i, bg, cloth) > BLEND_GAP) { marks[y * w + x] = 1; count++ }
        continue
      }
      area++
      if (edge >= rim && far) { marks[y * w + x] = 1; count++ }
    }
  }
  if (!count || count > area * 0.4) return none
  // Joined into graphics, then each one's pixels.
  const joined = dilate(marks, w, h, Math.max(1, Math.round(widest * JOIN)))
  const label = new Int32Array(w * h).fill(-1)
  const found = []
  for (let start = 0; start < w * h; start++) {
    if (!joined[start] || label[start] >= 0) continue
    const stack = [start]
    label[start] = found.length
    const piece = { x0: w, y0: h, x1: -1, y1: -1, count: 0, cells: [] }
    while (stack.length) {
      const k = stack.pop(), x = k % w, y = (k - x) / w
      piece.cells.push(k)
      if (marks[k]) { piece.count++; piece.x0 = Math.min(piece.x0, x); piece.x1 = Math.max(piece.x1, x); piece.y0 = Math.min(piece.y0, y); piece.y1 = Math.max(piece.y1, y) }
      for (const j of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, y > 0 ? k - w : -1, y < h - 1 ? k + w : -1]) {
        if (j < 0 || !joined[j] || label[j] >= 0) continue
        label[j] = found.length
        stack.push(j)
      }
    }
    found.push(piece)
  }
  // Pieces in line down (or across) a leg with a short gap between them are one graphic: a word whose
  // letters are spaced wider than JOIN, the words of a line.
  const marked = found.filter(p => p.count > 0)
  for (let merged = true; merged;) {
    merged = false
    for (let a = 0; a < marked.length && !merged; a++) for (let b = a + 1; b < marked.length && !merged; b++) {
      const p = marked[a], q = marked[b]
      const gapY = Math.max(p.y0, q.y0) - Math.min(p.y1, q.y1), gapX = Math.max(p.x0, q.x0) - Math.min(p.x1, q.x1)
      const inColumn = gapX < 0 && gapY < tall * 0.06, inRow = gapY < 0 && gapX < widest * 0.06
      if (!inColumn && !inRow) continue
      p.x0 = Math.min(p.x0, q.x0); p.y0 = Math.min(p.y0, q.y0); p.x1 = Math.max(p.x1, q.x1); p.y1 = Math.max(p.y1, q.y1)
      p.count += q.count
      for (const k of q.cells) p.cells.push(k)
      marked.splice(b, 1)
      merged = true
    }
  }
  const mid = (layout.rows[0] + layout.rows[1]) / 2
  const mask = new Uint8Array(w * h)
  const prints = []
  for (const piece of marked) {
    if (piece.count < LEAST_AREA * area) continue
    const pw = piece.x1 - piece.x0 + 1, ph = piece.y1 - piece.y0 + 1
    if (Math.max(pw, ph) < LEAST_SPAN * tall) continue
    // Not a wash, a fade or a print all over (a jeans' whiskering, an acid wash): those spread wide and stay
    // with the photo, which lays them as photographed.
    if (pw * ph > 0.2 * area) continue
    const cx = (piece.x0 + piece.x1) / 2, cy = (piece.y0 + piece.y1) / 2
    // On the garment (marks just outside it are only kept as part of a graphic on it).
    if (!piece.cells.some(k => marks[k] && onGarment(layout, k % w, (k - (k % w)) / w) >= 0)) continue
    // Not a glint down the inseam or the crotch: a graphic sits on a leg, not at its inner edge.
    const inner = rowOf(layout, Math.round(cy))
    if (inner.innerLeft >= 0 && Math.min(Math.abs(cx - inner.innerLeft), Math.abs(cx - inner.innerRight)) < widest * 0.04 && pw < widest * 0.06) continue
    // Not the drawcord and the label at the middle of the waistband: they hang from it, and are the photo's.
    if (Math.abs(cx - mid) < widest * 0.18 && cy < layout.top + tall * 0.3) continue
    // The wearer's leg: a photo of the front shows their right leg on its left.
    const side = (cx > mid) !== behind ? "L" : "R"
    // The leg's outer edge over the graphic's rows, as a line (its fold in the photo: the side seam).
    const right = cx > mid
    let n = 0, sy = 0, sx = 0, syy = 0, sxy = 0
    // (Out to the graphic's own marks where they run past the outline: see above.)
    const reach = new Map()
    for (const k of piece.cells) if (marks[k]) { const x = k % w, y = (k - x) / w; reach.set(y, right ? Math.max(reach.get(y) ?? -Infinity, x) : Math.min(reach.get(y) ?? Infinity, x)) }
    for (let y = piece.y0; y <= piece.y1; y++) {
      const row = rowOf(layout, y)
      if (!(row.right > row.left)) continue
      const own = reach.get(y)
      const x = right ? Math.max(row.right, own ?? -Infinity) : Math.min(row.left, own ?? Infinity)
      n++; sy += y; sx += x; syy += y * y; sxy += x * y
    }
    if (n < 2) continue
    const slope = n * syy - sy * sy ? (n * sxy - sx * sy) / (n * syy - sy * sy) : 0
    const edge = [(sx - slope * sy) / n, slope]
    for (const k of piece.cells) if (marks[k]) mask[k] = 1
    prints.push({ box: [piece.x0, piece.y0, piece.x1, piece.y1], side, behind, edge })
  }
  return { cloth, bg, prints, mask: dilate(mask, w, h, Math.max(4, Math.round(widest * 0.012))) }
}

// The photo with the graphics painted out (in place), each masked run of a row filled between the cloth on
// either side of it (only the side that's cloth, at the garment's edge), so the folds' shading carries on.
// scale: the data's pixels per the layout's (a bigger copy of the same photo); mask is the layout's size.
export function cleanPixels(data, w, h, mask, mw, mh, layout, cloth) {
  const scale = w / mw, toLayout = w / layout.w
  const masked = (x, y) => mask[Math.min(mh - 1, Math.floor(y / scale)) * mw + Math.min(mw - 1, Math.floor(x / scale))]
  const isCloth = (x, y) => onGarment(layout, Math.floor(x / toLayout), Math.floor(y / toLayout)) >= 0
  // What was graphic just outside the outline was the garment too: filled like the rest.
  // (A letter's soft edge against the backdrop is a blend of the two, so anything there not the backdrop's own colour.)
  const fill = (x, y, i) => isCloth(x, y) || Math.hypot(data[i] - bg[0], data[i + 1] - bg[1], data[i + 2] - bg[2]) > 14
  const bg = backdropOf(data, w, h)
  for (let y = 0; y < h; y++) {
    let x = 0
    while (x < w) {
      if (!masked(x, y)) { x++; continue }
      let end = x
      while (end + 1 < w && masked(end + 1, y)) end++
      // The cloth either side, a few pixels clear of the graphic (its soft edge), and only where it's the
      // cloth's own colour (not a letter's soft edge past the mask, nor the outline's pale rim).
      const plain = k => { const i = 4 * (y * w + k); return isCloth(k, y) && Math.hypot(data[i] - cloth[0], data[i + 1] - cloth[1], data[i + 2] - cloth[2]) < MARK_GAP * 0.5 }
      let a = x - 1, b = end + 1
      for (let step = 0; step < 4 && a >= 0 && !plain(a); step++) a--
      for (let step = 0; step < 4 && b < w && !plain(b); step++) b++
      const left = a >= 0 && plain(a) ? 4 * (y * w + a) : -1, right = b < w && plain(b) ? 4 * (y * w + b) : -1
      for (let k = Math.max(0, a + 1); k <= Math.min(w - 1, b - 1); k++) {
        const t = (k - a) / (b - a), i = 4 * (y * w + k)
        if (!fill(k, y, i)) continue
        for (let c = 0; c < 3; c++) {
          const l = left >= 0 ? data[left + c] : null, r = right >= 0 ? data[right + c] : null
          data[i + c] = l !== null && r !== null ? l + (r - l) * t : l ?? r ?? cloth[c]
        }
      }
      x = end + 1
    }
  }
  return data
}

// The same graphic seen from the front and from behind (the side seam's lettering): the same leg, much the
// same height down it (cm), both at the leg's outer edge.
function seenTwice(a, b, frontOn, backOn) {
  if (a.side !== b.side) return false
  const down = (p, on) => [(p.box[1] - on.top) / on.scale, (p.box[3] - on.top) / on.scale]
  const [a0, a1] = down(a, frontOn), [b0, b1] = down(b, backOn)
  const overlap = Math.min(a1, b1) - Math.max(a0, b0)
  const atEdge = (p, on) => {
    const y = (p.box[1] + p.box[3]) / 2, x = p.edge[0] + p.edge[1] * y
    return Math.min(Math.abs(p.box[0] - x), Math.abs(p.box[2] - x)) < 4 * on.scale
  }
  return overlap > 0.5 * Math.min(a1 - a0, b1 - b0) && atEdge(a, frontOn) && atEdge(b, backOn)
}

// Each cloth point's place in a graphic: legs = { front: { prints, layout }, back: { prints, layout } | null,
// atlas: legPrintAtlas's }. Returns { uv: a Float32Array of [u, v, k] per point, where (u, v) is its place in
// graphic k - 1's box (0 to 1 inside it, beyond it outside; v down) and k 0 for none, and rects: each
// graphic's place in the atlas texture, [u0, v0, du, dv] (v up, as textures run) }. Every point of a leg
// piece that has a graphic is placed, inside its box or not, so a triangle across the graphic's edge is
// clipped cleanly in the shader rather than blended with a point that has no place.
export const LEG_PRINTS_MAX = 4
export function legPrintUV(cloth, pattern, legs) {
  const m = pattern.measures
  const uv = new Float32Array(3 * cloth.points.length)
  const frontOn = onPhoto(legs.front.layout, m)
  const backOn = legs.back ? onPhoto(legs.back.layout, m, true) : null
  const { width: AW, height: AH, at } = legs.atlas
  const laid = [
    ...legs.front.prints.map((p, k) => ({ p, on: frontOn, part: "front", slot: k })),
    ...(legs.back?.prints ?? []).map((p, k) => ({ p, on: backOn, part: "back", slot: legs.front.prints.length + k }))
      .filter(({ p }) => !legs.front.prints.some(f => seenTwice(f, p, frontOn, backOn)))
  ].slice(0, LEG_PRINTS_MAX)
  const rects = laid.map(({ p, slot }) => {
    const k = p.scale ?? legs.atlas.scale, [x0, y0, x1, y1] = p.box
    const [ax, ay] = at[slot], bw = (x1 - x0 + 1) * k, bh = (y1 - y0 + 1) * k
    return [ax / AW, 1 - (ay + bh) / AH, bw / AW, bh / AH]
  })
  if (!laid.length) return { uv, rects }
  const spans = new Map()
  for (let i = 0; i < cloth.points.length; i++) {
    const panel = pattern.panels[cloth.panels[cloth.panel[i]]]
    const place = panel.place
    if (place.at !== "leg") continue
    if (!spans.has(cloth.panel[i])) spans.set(cloth.panel[i], legSpan(panel.edges, m))
    const [px, py] = cloth.points[i]
    const [, outer] = spans.get(cloth.panel[i])(py)
    // How far in from the side seam (cm), and how far down from the waistband (as photo_map lays it).
    const dist = Math.abs(outer - px)
    // The leg's graphic nearest this height (a leg piece takes one: the one it's nearest).
    let best = null
    laid.forEach((entry, k) => {
      const { p, on, part } = entry
      if (part !== place.part || p.side !== place.side) return
      const y = on.top + (m.band - py) * on.scale
      const off = Math.max(p.box[1] - y, y - p.box[3], 0)
      if (!best || off < best.off) best = { off, k, y, entry }
    })
    if (!best) continue
    const { p } = best.entry, on = best.entry.on, y = best.y
    const right = (p.side === "L") !== p.behind
    const x = p.edge[0] + p.edge[1] * y + (right ? -1 : 1) * dist * on.scale
    const [x0, y0, x1, y1] = p.box
    uv[3 * i] = (x - x0) / (x1 - x0 + 1)
    uv[3 * i + 1] = (y - y0) / (y1 - y0 + 1)
    uv[3 * i + 2] = best.k + 1
  }
  return { uv, rects }
}

// In the browser: a pants photo's graphics (print.js's readBottomPhoto reading of it: its layout, at its
// size), each cut from the photo at full size (crisp letters) with its own edge, side by side in one canvas,
// and the photo with them painted out (a data: URL at full size, and a canvas at the reading's size, to read
// again). Null when it has none.
export async function readLegPrints(src, layout, { behind = false, size = 1600 } = {}) {
  const image = await new Promise((resolve, reject) => { const img = new Image(); img.crossOrigin = "anonymous"; img.onload = () => resolve(img); img.onerror = reject; img.src = src })
  const { w: mw, h: mh } = layout
  const small = document.createElement("canvas")
  small.width = mw; small.height = mh
  const sctx = small.getContext("2d", { willReadFrequently: true })
  sctx.drawImage(image, 0, 0, mw, mh)
  const found = findLegPrints(sctx.getImageData(0, 0, mw, mh).data, mw, mh, layout, { behind })
  if (!found.prints.length) return null
  // The photo at full size (to a limit).
  const scale = Math.max(1, Math.min(size / Math.max(image.naturalWidth, image.naturalHeight), image.naturalWidth / mw))
  const W = Math.round(mw * scale), H = Math.round(mh * scale)
  const big = document.createElement("canvas")
  big.width = W; big.height = H
  const bctx = big.getContext("2d", { willReadFrequently: true })
  bctx.drawImage(image, 0, 0, W, H)
  const full = bctx.getImageData(0, 0, W, H)
  // Each graphic cut out at full size: its pixels far from the cloth's colour, softened a pixel at the edge.
  const pieces = found.prints.map(p => {
    const [x0, y0, x1, y1] = p.box.map((v, k) => Math.round((k < 2 ? v - 1 : v + 2) * scale))
    const cw = Math.max(1, Math.min(W, x1) - Math.max(0, x0)), ch = Math.max(1, Math.min(H, y1) - Math.max(0, y0))
    const sx = Math.max(0, x0), sy = Math.max(0, y0)
    const mark = new Uint8Array(cw * ch)
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const i = 4 * ((sy + y) * W + sx + x)
      if (Math.hypot(full.data[i] - found.cloth[0], full.data[i + 1] - found.cloth[1], full.data[i + 2] - found.cloth[2]) <= MARK_GAP * 0.8) continue
      // Past the outline, only what isn't the backdrop (or its soft edge): the lettering running off it.
      if (onGarment(layout, Math.floor((sx + x) / scale), Math.floor((sy + y) / scale)) < 0 && offBlend(full.data, i, found.bg, found.cloth) <= BLEND_GAP) continue
      mark[y * cw + x] = 1
    }
    // What the graphic encloses is part of it (a white K on a black patch, near the cloth's own pale grey):
    // everything not reached from the cut's edge without crossing it.
    const outside = new Uint8Array(cw * ch), stack = []
    for (let x = 0; x < cw; x++) for (const y of [0, ch - 1]) stack.push(y * cw + x)
    for (let y = 0; y < ch; y++) for (const x of [0, cw - 1]) stack.push(y * cw + x)
    while (stack.length) {
      const k = stack.pop()
      if (outside[k] || mark[k]) continue
      outside[k] = 1
      const x = k % cw, y = (k - x) / cw
      if (x > 0) stack.push(k - 1)
      if (x < cw - 1) stack.push(k + 1)
      if (y > 0) stack.push(k - cw)
      if (y < ch - 1) stack.push(k + cw)
    }
    for (let k = 0; k < cw * ch; k++) if (!outside[k] && !mark[k]) mark[k] = 1
    const grown = dilate(mark, cw, ch, 1)
    const pixels = new ImageData(cw, ch)
    for (let k = 0; k < cw * ch; k++) {
      const i = 4 * ((sy + Math.floor(k / cw)) * W + sx + (k % cw))
      pixels.data[4 * k] = full.data[i]; pixels.data[4 * k + 1] = full.data[i + 1]; pixels.data[4 * k + 2] = full.data[i + 2]
      pixels.data[4 * k + 3] = mark[k] ? 255 : grown[k] ? 110 : 0
    }
    const canvas = document.createElement("canvas")
    canvas.width = cw; canvas.height = ch
    canvas.getContext("2d").putImageData(pixels, 0, 0)
    // Its box in the reading's pixels, as cut.
    return { ...p, box: [sx / scale, sy / scale, (sx + cw) / scale - 1, (sy + ch) / scale - 1], canvas, scale, mark }
  })
  cleanPixels(full.data, W, H, found.mask, mw, mh, layout, found.cloth)
  // Then each graphic's own pixels at full size, a little grown: thin strokes and soft edges a smaller copy
  // blurs away, which the legs' photo would otherwise keep as hairs of colour.
  const fine = new Uint8Array(W * H)
  for (const p of pieces) {
    const [sx, sy] = [Math.round(p.box[0] * scale), Math.round(p.box[1] * scale)]
    const grown = dilate(p.mark, p.canvas.width, p.canvas.height, 3)
    for (let y = 0; y < p.canvas.height; y++) for (let x = 0; x < p.canvas.width; x++) if (grown[y * p.canvas.width + x] && sy + y < H && sx + x < W) fine[(sy + y) * W + sx + x] = 1
  }
  cleanPixels(full.data, W, H, fine, W, H, layout, found.cloth)
  bctx.putImageData(full, 0, 0)
  sctx.drawImage(big, 0, 0, mw, mh)
  return { prints: pieces, scale, cleaned: big.toDataURL("image/jpeg", 0.92), cleanedSmall: small }
}

// The graphics of the front's and the back's photos side by side in one canvas (a pixel of gap), for
// legPrintUV: { canvas, width, height, scale (canvas pixels per reading pixel), at: [[x, y]] }.
export function legPrintAtlas(front, back = null) {
  const all = [...(front?.prints ?? []), ...(back?.prints ?? [])]
  if (!all.length) return null
  const scale = front?.scale ?? back.scale
  const width = all.reduce((sum, p) => sum + p.canvas.width + 2, 0), height = Math.max(...all.map(p => p.canvas.height))
  const canvas = document.createElement("canvas")
  canvas.width = width; canvas.height = height
  const ctx = canvas.getContext("2d")
  const at = []
  let x = 0
  for (const p of all) { ctx.drawImage(p.canvas, x, 0); at.push([x, 0]); x += p.canvas.width + 2 }
  return { canvas, width, height, scale, at }
}
