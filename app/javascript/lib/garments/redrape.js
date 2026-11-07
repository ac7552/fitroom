// Photo re-draping: the store's photographs laid onto the draped garment, point for point, so what the cloth
// shows is the photograph itself (its weave, its plaid, a print on a sleeve, an embroidered logo, a pocket's
// stitching) at the visitor's proportions, rather than a colour and a cut-out print.
//
// Stores photograph a garment hanging or laid flat. The same garment (the same cloth, in the same size) is
// simulated hanging the same way here (hangerDrape: a top held at the shoulder seams and the neck, trousers
// at the waist, no body under it), which gives, for every point of the cloth, where it lies in such a photo.
// The hanging silhouette is then registered to the photo's: group by group (each sleeve or leg, the body),
// row by row, each point's share of the way across its group's run of cloth is carried to the same share
// across the photo's run on that row (registerPhoto). The front panels, the sleeves and the collar take the
// front photo; the back panels the back photo, mirrored. The result is a texture coordinate per cloth point
// for dress.js's photo map.
//
// The photo's mask is the cloth alone (clothMask): the backdrop's soft shadow under and beside the garment,
// and the hanger's hook, are left out, but anything inside the garment's outline (a pale print on dark
// cloth) is kept. Nothing here reads the body or the person.
import { boxBlur, garmentMask, isSkin, photoTraits } from "lib/garments/print"
import { wornGarmentMask } from "lib/garments/segment"
import { remoteParse, trimByParse } from "lib/garments/vision"

// Rows the hanging silhouette is read at.
const ROWS = 512

// The hanger drape lives in hanger.js, so a worker can run it without the photo code (drape_worker.js).
export { HangerDrape } from "lib/garments/hanger"

// The cloth in a store photo (1 per pixel): the garment's outline less the backdrop's shadow at its edges,
// found row by row as the stretch from the first pixel of the cloth's colour to the last in each run of the
// outline, so a print inside the garment stays in. A hanger is cut off: its hook (rows narrower than a third
// of the widest, above the garment), then the rows below that are mostly the hook's colour (its shoulders).
// Returns { mask, box: { left, right, top, bottom }, bg: the backdrop's colour, hung: whether there was a hook }
// or null.
export function clothMask(data, w, h) {
  const found = garmentMask(data, w, h)
  if (!found) return null
  const m = found.mask
  const median = values => { values.sort((a, b) => a - b); return values[values.length >> 1] }
  const bg = [0, 1, 2].map(c => { const e = []; for (let x = 0; x < w; x += 4) e.push(data[4 * x + c], data[4 * ((h - 1) * w + x) + c]); return median(e) })
  // The cloth's own colour: the middle of all the garment's pixels (a print in the middle of it is a part).
  const samples = [[], [], []]
  for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) if (m[y * w + x]) for (let c = 0; c < 3; c++) samples[c].push(data[4 * (y * w + x) + c])
  if (!samples[0].length) return null
  const cloth = samples.map(median)
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  const apart = dist(cloth, bg)
  // The shadow is told from the cloth by how far from the backdrop's colour a pixel is; a garment near the
  // backdrop's own colour (white on light grey) can't be, and keeps its outline whole.
  const isCloth = apart < 24 ? () => true : i => dist([data[4 * i], data[4 * i + 1], data[4 * i + 2]], bg) > apart * 0.45
  const out = new Uint8Array(w * h)
  const gap = Math.max(2, Math.round(w * 0.015))
  const widths = new Int32Array(h)
  for (let y = 0; y < h; y++) {
    const runs = []
    let start = -1, last = -1
    for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue
      if (start < 0) start = x
      else if (x - last > gap) { runs.push([start, last]); start = x }
      last = x
    }
    if (start >= 0) runs.push([start, last])
    let a0 = w, b0 = -1
    for (const [a, b] of runs) {
      let first = -1, lastCloth = -1
      for (let x = a; x <= b; x++) if (isCloth(y * w + x)) { if (first < 0) first = x; lastCloth = x }
      if (first < 0) continue
      out.fill(1, y * w + first, y * w + lastCloth + 1)
      a0 = Math.min(a0, first); b0 = Math.max(b0, lastCloth)
    }
    widths[y] = b0 >= a0 ? b0 - a0 + 1 : 0
  }
  const widest = Math.max(...widths)
  let top = -1, bottom = -1, left = w, right = 0
  // The hanger's hook: the rows at the top narrower than a third of the widest. Not a hood standing up (or a
  // high collar): that's broad for a hook, a tenth of the garment or more across.
  let first = -1, hookEnd = -1
  for (let y = 0; y < h; y++) {
    if (!widths[y]) continue
    if (first < 0) first = y
    if (widths[y] < widest * 0.3) hookEnd = y; else break
  }
  if (hookEnd >= 0) {
    const narrow = []
    for (let y = first; y <= hookEnd; y++) if (widths[y]) narrow.push(widths[y])
    // A hook is a wire or a hook of plastic, a few percent of the garment across; a hood's crown narrows to
    // nothing at its very top but is a fifth of the garment across a little below.
    const broad = median(narrow) >= widest * 0.1
    if (broad) hookEnd = -1
    else out.fill(0, first * w, (hookEnd + 1) * w)
  }
  top = hookEnd >= 0 ? hookEnd + 1 : first
  if (top < 0 || top >= h) return null
  // Below a hook, the hanger itself: its shoulders lie over the garment's, or stand above its neckline, in
  // the hook's colour (which isn't the cloth's). The rows at the top that are mostly that colour go too.
  if (hookEnd - first >= h * 0.02) {
    const hook = [0, 1, 2].map(c => { const e = []; for (let y = first; y <= hookEnd; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) e.push(data[4 * (y * w + x) + c]); return median(e) })
    if (dist(hook, cloth) > 40) {
      const near = i => dist([data[4 * i], data[4 * i + 1], data[4 * i + 2]], hook) < 32
      for (; top < h; top++) {
        let on = 0, like = 0
        for (let x = 0; x < w; x++) if (out[top * w + x]) { on++; if (near(top * w + x)) like++ }
        if (!on || like < on * 0.5) break
        out.fill(0, top * w, (top + 1) * w)
      }
    }
  }
  let seen = false
  for (let y = top; y < h; y++) {
    if (!widths[y]) continue
    let any = false
    for (let x = 0; x < w; x++) if (out[y * w + x]) { any = true; left = Math.min(left, x); right = Math.max(right, x) }
    if (!any) continue
    if (!seen) { top = y; seen = true }
    bottom = y
  }
  return seen ? { mask: out, box: { left, right, top, bottom, w, h }, bg, hung: hookEnd - first >= h * 0.02 } : null
}

// Which group of the hanging silhouette a panel belongs to: 0 the wearer's right sleeve (or a pair of
// trousers' right leg: the photo's left), 1 the body (front, back, collar, hem band; trousers' waistband),
// 2 the wearer's left sleeve or leg.
function groupOf(name) {
  return /_R$/.test(name) ? 0 : /_L$/.test(name) ? 2 : 1
}

// The runs of a mask along row y between x0 and x1 (gaps under 1.5% of the width closed), [[from, to]].
function runsOf(mask, w, y, x0, x1) {
  const out = []
  let start = -1, last = -1
  const gap = Math.max(2, Math.round((x1 - x0) * 0.015))
  for (let x = x0; x <= x1; x++) {
    if (!mask[y * w + x]) continue
    if (start < 0) start = x
    else if (x - last > gap) { out.push([start, last]); start = x }
    last = x
  }
  if (start >= 0) out.push([start, last])
  return out.filter(([a, b]) => b - a >= 3)
}

// A row-by-row series smoothed (a median over 5 rows against odd rows, then a mean over 9, so the edges of
// the cloth run smoothly down the photo and the silhouette, without the ripple that a weave's edge, a fold or
// a printed gap puts in one row); gaps (NaN) stay gaps.
function smoothRows(values, median = 5, mean = 9) {
  const n = values.length
  const pass = (input, half, fn) => {
    const out = new Float64Array(n).fill(NaN)
    const window = []
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(input[i])) continue
      window.length = 0
      for (let k = Math.max(0, i - half); k <= Math.min(n - 1, i + half); k++) if (!Number.isNaN(input[k])) window.push(input[k])
      out[i] = fn(window)
    }
    return out
  }
  const med = pass(values, median >> 1, w => { w.sort((a, b) => a - b); return w[w.length >> 1] })
  return pass(med, mean >> 1, w => w.reduce((s, v) => s + v, 0) / w.length)
}

// A gapped series filled: linear between known rows, held flat past the ends. Null when nothing is known.
function fillRows(values) {
  const n = values.length
  const out = new Float64Array(n)
  let prev = -1
  for (let i = 0; i < n; i++) if (!Number.isNaN(values[i])) { prev = i; break }
  if (prev < 0) return null
  for (let i = 0; i < prev; i++) out[i] = values[prev]
  for (let i = prev; i < n; i++) {
    if (Number.isNaN(values[i])) continue
    for (let k = prev; k <= i; k++) out[k] = values[prev] + (values[i] - values[prev]) * (i === prev ? 0 : (k - prev) / (i - prev))
    prev = i
  }
  for (let i = prev; i < n; i++) out[i] = values[prev]
  return out
}

// What a photo shows on each of its rows, as the three groups' runs: the body's (the run through the
// garment's middle), the wearer's right side's (the photo's left for a photo of the front; the right for the
// back, `mirror`) and the left's, each [from, to] in photo columns, NaN where that group has no run of its
// own on the row (merged into the body's run, or not there). The body's own edges where a side hangs apart
// from it are carried into the rows where it doesn't (extended), so a merged run can be split where the body
// ends and the sleeve begins. All edges smoothed down the rows.
export function layoutPhoto(photo, mirror) {
  const { box, mask } = photo
  const H = box.bottom - box.top + 1
  const series = () => new Float64Array(H).fill(NaN)
  const rows = []
  const centres = []
  for (let y = 0; y < H; y++) {
    const runs = runsOf(mask, box.w, box.top + y, box.left, box.right)
    rows.push(runs)
    if (runs.length) { const widest = runs.reduce((p, r) => (r[1] - r[0] > p[1] - p[0] ? r : p)); centres.push((widest[0] + widest[1]) / 2) }
  }
  centres.sort((a, b) => a - b)
  const cx = centres.length ? centres[centres.length >> 1] : (box.left + box.right) / 2
  const body = [series(), series()], left = [series(), series()], right = [series(), series()], all = [series(), series()]
  const gap = [series(), series()]   // a neck opening's two edges, on rows the body is split by one
  const sepL = series(), sepR = series()
  const W = box.right - box.left
  let seps = [0, 0]
  for (let y = 0; y < H; y++) {
    const runs = rows[y]
    if (!runs.length) continue
    all[0][y] = runs[0][0]; all[1][y] = runs[runs.length - 1][1]
    const k = runs.findIndex(([a, b]) => a <= cx && cx <= b)
    // The runs on the photo's left of the body (or of the middle, on a row with no body: the cuffs below a
    // hem) are the one side's, those on its right the other's; a side's run counts when it's a sleeve's or
    // leg's width at least, not a fold's.
    let before = k < 0 ? runs.filter(([, b]) => b < cx) : runs.slice(0, k), after = k < 0 ? runs.filter(([a]) => a > cx) : runs.slice(k + 1)
    if (k >= 0) { body[0][y] = runs[k][0]; body[1][y] = runs[k][1] }
    else {
      // No run through the middle, but a wide run close on each side of it: the body with its neck opening
      // (or a V) between the two halves, not two sleeves.
      const l = before[before.length - 1], r = after[0]
      if (l && r && l[1] - l[0] >= 0.12 * W && r[1] - r[0] >= 0.12 * W && r[0] - l[1] < 0.3 * W) {
        body[0][y] = l[0]; body[1][y] = r[1]
        gap[0][y] = l[1]; gap[1][y] = r[0]
        before = before.slice(0, -1); after = after.slice(1)
      }
    }
    if (before.length && before[before.length - 1][1] - before[0][0] >= 0.06 * W) { left[0][y] = before[0][0]; left[1][y] = before[before.length - 1][1] }
    if (after.length && after[after.length - 1][1] - after[0][0] >= 0.06 * W) { right[0][y] = after[0][0]; right[1][y] = after[after.length - 1][1] }
    // The body's own edge is known where a side hangs apart from a body of a body's width.
    if (k >= 0 && runs[k][1] - runs[k][0] >= 0.35 * W) {
      if (!Number.isNaN(left[0][y])) { sepL[y] = runs[k][0]; seps[0]++ }
      if (!Number.isNaN(right[0][y])) { sepR[y] = runs[k][1]; seps[1]++ }
    }
  }
  const smooth = pair => pair.map(v => smoothRows(v))
  const sides = [smooth(left), smooth(right)]
  // Extended only when enough rows show the edge (a sleeve laid along the body shows it nowhere).
  const extended = [seps[0] >= 0.04 * H ? fillRows(smoothRows(sepL)) : null, seps[1] >= 0.04 * H ? fillRows(smoothRows(sepR)) : null]
  // In the wearer's frame: the photo's left is the wearer's right on a photo of the front, their left on one
  // of the back.
  const [groupR, groupL] = mirror ? [sides[1], sides[0]] : sides
  const [extR, extL] = mirror ? [extended[1], extended[0]] : extended
  return { top: box.top, left: box.left, right: box.right, H, body: smooth(body), all: smooth(all), gap, sides: [groupR, null, groupL], extended: [extR, null, extL], mirror, width: box.right - box.left }
}

// The photo laid on the garment: texture coordinates ([u, v, which] per cloth point; which 1 the front photo,
// 3 the back photo) from the hanging positions (hangerDrape's) and the two photos' cloth masks (clothMask's;
// back may be null, then the back panels take the front photo mirrored). The hanging silhouette is drawn
// group by group (each sleeve or leg, the body) and each row's extent per group registered to the photo's run
// for that group on the matching row (layoutPhoto). Rows: one scale for the whole garment, the photo's
// pixels per unit of hanging height, from the body's top to its hem; a sleeve's own bottom is where the photo
// shows its sleeve end, when it hangs apart from the body (a sleeve laid at an angle is shorter down the
// photo than one hanging straight).
export function registerPhoto(top, hanging, front, back = null) {
  const { cloth } = top
  const map = top.drape.map
  const names = cloth.panels
  const n = cloth.points.length
  const bottoms = Boolean(top.bottoms)
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity
  for (let j = 0; j < hanging.length; j += 3) { minx = Math.min(minx, hanging[j]); maxx = Math.max(maxx, hanging[j]); miny = Math.min(miny, hanging[j + 1]); maxy = Math.max(maxy, hanging[j + 1]) }
  const HH = ROWS, HW = Math.max(8, Math.round(HH * (maxx - minx) / Math.max(1e-6, maxy - miny)))
  const px = x => (x - minx) / (maxx - minx) * (HW - 1), py = y => (maxy - y) / (maxy - miny) * (HH - 1)
  const rowOf = y => Math.round(Math.min(HH - 1, Math.max(0, py(y))))
  // Each group's silhouette on its own, for its extent on every row (smoothed down the rows).
  const ext = [0, 1, 2].map(g => {
    const canvas = document.createElement("canvas")
    canvas.width = HW; canvas.height = HH
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, HW, HH); ctx.fillStyle = "#fff"
    for (const [a, b, c] of cloth.triangles) {
      if (groupOf(names[cloth.panel[a]]) !== g) continue
      const A = map[a], B = map[b], C = map[c]
      ctx.beginPath()
      ctx.moveTo(px(hanging[3 * A]), py(hanging[3 * A + 1])); ctx.lineTo(px(hanging[3 * B]), py(hanging[3 * B + 1])); ctx.lineTo(px(hanging[3 * C]), py(hanging[3 * C + 1]))
      ctx.fill()
    }
    const d = ctx.getImageData(0, 0, HW, HH).data
    const lo = new Float64Array(HH).fill(NaN), hi = new Float64Array(HH).fill(NaN)
    for (let y = 0; y < HH; y++) {
      let a = -1, b = -1
      for (let x = 0; x < HW; x++) if (d[4 * (y * HW + x)] > 128) { if (a < 0) a = x; b = x }
      if (a >= 0) { lo[y] = minx + (a / (HW - 1)) * (maxx - minx); hi[y] = minx + (b / (HW - 1)) * (maxx - minx) }
    }
    return [smoothRows(lo), smoothRows(hi)]
  })
  const extAt = (g, r) => {
    for (let d = 0; d < 8; d++) for (const rr of [r - d, r + d]) if (rr >= 0 && rr < HH && !Number.isNaN(ext[g][0][rr])) return [ext[g][0][rr], ext[g][1][rr]]
    return null
  }
  // A hood isn't laid from the photo (trustPieces gives it plain cloth), and hangs down the back on the hanger
  // where a photo often shows it standing up: it's left out of the body's height on both.
  const hooded = names.some(name => /^hood/.test(name))
  const vext = [0, 1, 2].map(g => { let lo = Infinity, hi = -Infinity; for (let i = 0; i < n; i++) if (groupOf(names[cloth.panel[i]]) === g && !/^hood/.test(names[cloth.panel[i]])) { const Y = hanging[3 * map[i] + 1]; lo = Math.min(lo, Y); hi = Math.max(hi, Y) } return [lo, hi] })
  const layouts = { front: layoutPhoto(front, false), back: back ? layoutPhoto(back, true) : null }
  // Where a photo's body ends (its hem: the last row with a run wider than 40% of the garment), and where
  // each side's own run ends.
  const endsOf = layout => {
    let body = 0
    const sides = [0, 0, 0]
    for (let y = 0; y < layout.H; y++) {
      if (layout.body[1][y] - layout.body[0][y] > 0.4 * layout.width) body = y
      for (const g of [0, 2]) if (!Number.isNaN(layout.sides[g][0][y])) sides[g] = y
    }
    return { body, sides }
  }
  // Where the garment's shoulders are on a photo of a hooded top: the first row as wide as most of its
  // chest (a hood standing up above them is narrower); 0 for anything else.
  const shouldersOf = layout => {
    if (!hooded || bottoms) return 0
    const widths = []
    for (let y = 0; y < layout.H; y++) widths.push(Number.isNaN(layout.all[0][y]) ? 0 : layout.all[1][y] - layout.all[0][y])
    const chest = widths.slice(Math.round(0.25 * layout.H), Math.round(0.45 * layout.H)).sort((a, b) => a - b)
    const typical = chest[chest.length >> 1] ?? 0
    const y = widths.findIndex(v => v >= 0.6 * typical)
    return y > 0 && y < 0.4 * layout.H ? y : 0
  }
  const ends = { front: endsOf(layouts.front), back: layouts.back ? endsOf(layouts.back) : null }
  const tops = { front: shouldersOf(layouts.front), back: layouts.back ? shouldersOf(layouts.back) : 0 }
  // The photo's rows per unit of hanging height, and each group's hanging top and bottom as photo rows.
  const scaleOf = layout => {
    const end = layout === layouts.back ? ends.back : ends.front
    const start = layout === layouts.back ? tops.back : tops.front
    const [blo, bhi] = bottoms ? [miny, maxy] : vext[1]
    const scale = (bottoms ? layout.H - 1 : end.body - start) / Math.max(1e-6, bhi - blo)
    const rowsOf = [0, 1, 2].map(g => {
      const [glo, ghi] = vext[g]
      if (!Number.isFinite(glo)) return null
      const from = start + (bhi - ghi) * scale
      let to = start + (bhi - glo) * scale
      // A sleeve to where the photo's sleeve ends, when it hangs apart from the body there (and the end is
      // not just the body's hem, where a sleeve laid along the body stops being told apart).
      if (!bottoms && g !== 1 && end.sides[g] > from && end.sides[g] < end.body - 0.02 * layout.H) to = end.sides[g]
      return [from, Math.min(layout.H - 1, to)]
    })
    return { top: bhi, scale, rowsOf }
  }
  const scales = { front: scaleOf(layouts.front), back: layouts.back ? scaleOf(layouts.back) : null }
  const place = (X, Y, g, layout, scaleInfo) => {
    const r = rowOf(Y)
    const [glo, ghi] = vext[g]
    const [from, to] = scaleInfo.rowsOf[g]
    const v = Math.min(1, Math.max(0, (ghi - Y) / Math.max(1e-6, ghi - glo)))
    const y = Math.round(Math.min(layout.H - 1, Math.max(0, from + v * (to - from))))
    const own = extAt(g, r)
    const margin = 0.03 * layout.width
    // The group's run on this photo row: its own when it hangs apart; else its share of the body's run,
    // past the body's extended edge; else the whole row by the groups' hanging extents together.
    let range = null, lo = own?.[0], hi = own?.[1]
    const side = g !== 1 ? layout.sides[g] : null
    if (side && !Number.isNaN(side[0][y])) range = [side[0][y], side[1][y]]
    const bodyA = layout.body[0][y], bodyB = layout.body[1][y]
    if (!range && !Number.isNaN(bodyA)) {
      const extR = layout.extended[0]?.[y], extL = layout.extended[2]?.[y]
      const mergedR = Number.isNaN(layout.sides[0][0][y]) && extR != null && extR > bodyA + margin && extAt(0, r)
      const mergedL = Number.isNaN(layout.sides[2][0][y]) && extL != null && extL < bodyB - margin && extAt(2, r)
      if (g === 0 && mergedR) range = [bodyA, extR]
      else if (g === 2 && mergedL) range = [extL, bodyB]
      else if (g === 1) range = [mergedR ? extR : bodyA, mergedL ? extL : bodyB]
    }
    if (!range) {
      // Everything on the row together, by the hanging extents of every group on it.
      const es = [0, 1, 2].map(m => extAt(m, r)).filter(Boolean)
      if (es.length) { lo = Math.min(...es.map(e => e[0])); hi = Math.max(...es.map(e => e[1])) }
      range = Number.isNaN(layout.all[0][y]) ? [layout.left, layout.right] : [layout.all[0][y], layout.all[1][y]]
    }
    if (range[1] - range[0] < 2) {
      const es = [0, 1, 2].map(m => extAt(m, r)).filter(Boolean)
      if (es.length) { lo = Math.min(...es.map(e => e[0])); hi = Math.max(...es.map(e => e[1])) }
      range = Number.isNaN(layout.all[0][y]) ? [layout.left, layout.right] : [layout.all[0][y], layout.all[1][y]]
    }
    if (lo == null || hi == null) { lo = X; hi = X }
    let t = hi > lo ? Math.min(1, Math.max(0, (X - lo) / (hi - lo))) : 0.5
    if (layout.mirror) t = 1 - t
    const [a, b] = range
    const inset = Math.max(3, Math.round(layout.width * 0.004))
    const xPhoto = a + inset + t * Math.max(0, b - a - 2 * inset)
    return [xPhoto, layout.top + y]
  }
  const uv = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) {
    const j = map[i], X = hanging[3 * j], Y = hanging[3 * j + 1], name = names[cloth.panel[i]], g = groupOf(name)
    // The back panels, and the back halves of the collar and the bands, from the back photo.
    const behind = /^back(_|$)/.test(name) || ((name === "collar" || name === "waistband" || /^cuff/.test(name)) && hanging[3 * j + 2] < 0)
    const useBack = behind && layouts.back
    const photo = useBack ? back : front
    const [qx, qy] = place(X, Y, g, useBack ? layouts.back : layouts.front, useBack ? scales.back : scales.front)
    uv[3 * i] = qx / photo.box.w; uv[3 * i + 1] = 1 - qy / photo.box.h; uv[3 * i + 2] = useBack ? 3 : 1
  }
  return uv
}

// The colour of the cloth at the top of a photo (the collar's, on a shirt's photo): the middle of the cloth
// pixels in the top 6% of the garment, as a hex string. The folded collar drawn over a shirt (stage.js's
// wearCollars) takes it, since the collar itself isn't simulated cloth the photo can be laid on.
export function collarColour(photo) {
  const { canvas, mask, box } = photo
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  const to = Math.min(box.bottom, box.top + Math.max(4, Math.round(0.06 * (box.bottom - box.top))))
  const { data } = ctx.getImageData(0, box.top, canvas.width, to - box.top + 1)
  const w = canvas.width
  const samples = [[], [], []]
  for (let y = 0; y <= to - box.top; y++) for (let x = box.left; x <= box.right; x += 2) {
    if (!mask[(box.top + y) * w + x]) continue
    for (let c = 0; c < 3; c++) samples[c].push(data[4 * (y * w + x) + c])
  }
  if (samples[0].length < 20) return null
  const median = values => { values.sort((a, b) => a - b); return values[values.length >> 1] }
  return "#" + samples.map(v => median(v).toString(16).padStart(2, "0")).join("")
}

// The collar as a photo shows it, as a strip (a canvas): the top 7% of the garment, across the cloth on those
// rows, with the backdrop (the neck opening) painted in the cloth's colour; the folded collar drawn over a
// shirt (stage.js's wearCollars) is textured with it, its points at the ends and the back of the neck in the
// middle, as a photo of the front shows them.
export function collarStrip(photo) {
  const { canvas, mask, box } = photo
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  const rows = Math.max(6, Math.round(0.07 * (box.bottom - box.top)))
  const w = canvas.width
  const image = ctx.getImageData(0, box.top, w, Math.min(rows, canvas.height - box.top))
  const d = image.data
  let left = w, right = 0
  for (let y = 0; y < image.height; y++) for (let x = box.left; x <= box.right; x++) if (mask[(box.top + y) * w + x]) { left = Math.min(left, x); right = Math.max(right, x) }
  if (right - left < 8) return null
  const fill = collarColour(photo)
  if (!fill) return null
  const rgb = [1, 3, 5].map(k => parseInt(fill.slice(k, k + 2), 16))
  for (let y = 0; y < image.height; y++) for (let x = left; x <= right; x++) {
    if (mask[(box.top + y) * w + x]) continue
    const i = 4 * (y * w + x)
    d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2]; d[i + 3] = 255
  }
  const strip = document.createElement("canvas")
  strip.width = 512; strip.height = 64
  const sctx = strip.getContext("2d")
  const whole = document.createElement("canvas")
  whole.width = w; whole.height = image.height
  whole.getContext("2d").putImageData(image, 0, 0)
  sctx.drawImage(whole, left, 0, right - left + 1, image.height, 0, 0, 512, 64)
  return strip
}

// A store photo as a canvas (at most `size` across) with its cloth mask: { canvas, mask, box } or null.
// labels: paint over a neck label (patchLabels; not for trousers, whose drawstring would go the same way).
// cords: paint out a hood's drawcords hanging down the chest (paintCords; the photo of the front of a hooded
// garment). worn: the photo is of it worn (its role, photo_roles.js), whatever the skin in it says.
export async function loadPhotoForRedrape(src, size = 2000, { labels = true, kind = "top", part = null, cords = false, worn: onModel = false } = {}) {
  const image = await new Promise((resolve, reject) => { const img = new Image(); img.crossOrigin = "anonymous"; img.onload = () => resolve(img); img.onerror = reject; img.src = src })
  const scale = Math.min(1, size / Math.max(image.naturalWidth, image.naturalHeight))
  const w = Math.round(image.naturalWidth * scale), h = Math.round(image.naturalHeight * scale)
  const canvas = document.createElement("canvas")
  canvas.width = w; canvas.height = h
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  ctx.drawImage(image, 0, 0, w, h)
  // The mask at half size (it's read row by row), scaled up when used.
  const small = document.createElement("canvas")
  const sw = Math.round(w / 2), sh = Math.round(h / 2)
  small.width = sw; small.height = sh
  const sctx = small.getContext("2d", { willReadFrequently: true })
  sctx.drawImage(canvas, 0, 0, sw, sh)
  const smallData = sctx.getImageData(0, 0, sw, sh).data
  // On someone: the garment alone (segment.js's wornGarmentMask), not the person; only the cloth is laid on.
  // (Or the photo's role says so, photo_roles.js: a model in dark clothes, or with darker skin, can show too
  // little skin for the count.)
  let worn = onModel || (photoTraits(smallData, sw, sh).skin > WORN_SKIN && faceAtTop(smallData, sw, sh))
  let found = clothMask(smallData, sw, sh)
  if (worn) {
    const garment = await wornGarmentMask(smallData, sw, sh, kind, src).catch(() => null)
    const person = garment ? maskFound(garment, sw, sh, found?.bg ?? backdropOf(smallData, sw, sh)) : null
    // No one found in it after all (a beige hood read as a face): the photo as a garment on its own.
    if (person) found = person
    else worn = false
  }
  if (!found) return null
  // With the vision service's clothes-parsing model (vision.mjs's /parse, when PARSE_MODEL is set), what it
  // reads as skin, hair or backdrop comes off the cloth mask, so none of it lands on the cloth.
  const parsed = await remoteParse(smallData, sw, sh).catch(() => null)
  if (parsed && trimByParse(found.mask, parsed) > 0) { const hung = found.hung; found = maskFound(found.mask, sw, sh, found.bg) ?? found; found.hung = hung }
  // A one-piece's half: the photo's garment cut at its waist (the narrowest row between a third and two
  // thirds of the way down), the upper part for its top, the lower for its shorts or pants.
  if (part) {
    found = cutAtWaist(found, sw, sh, part)
    if (!found) return null
  }
  const mask = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) mask[y * w + x] = found.mask[Math.min(sh - 1, y >> 1) * sw + Math.min(sw - 1, x >> 1)]
  const b = found.box
  const box = { left: b.left * 2, right: Math.min(w - 1, b.right * 2 + 1), top: b.top * 2, bottom: Math.min(h - 1, b.bottom * 2 + 1), w, h }
  // The light rim just inside the outline (the backdrop blended into the cloth's edge, the cut-out's
  // half-size steps), taken over by the cloth just inside it: laid on, a leg's or a tee's side lands on that
  // thin strip of the photo, stretched, and it showed as white down the seam.
  const rim = cleanRim(ctx, mask, w, h, found.bg)
  const cordCount = cords && !worn ? paintCords(ctx, mask, w, h, box) : 0
  if (labels && !worn) patchLabels(ctx, mask, box)
  const flat = flatField(ctx, mask, box)
  // Past the cloth's edge, the cloth's own colour (bleed), so the texture's filtering never draws in the backdrop.
  if (flat) bleed(flat.data, mask, w, h, BLEED)
  const plain = ctx.getImageData(0, 0, w, h)
  bleed(plain.data, mask, w, h, BLEED)
  ctx.putImageData(plain, 0, 0)
  return { canvas, mask, box, bg: found.bg, flat, worn, cloth: clothColourOf(plain.data, mask, w, h), rim, cords: cordCount }
}

// A hood's drawcords in a photo of the front, painted out with the cloth either side of them: laid on point
// for point they aren't cloth, and the drape stretched them across the chest and shoulders in white bands
// (Kith's Daily Paper camo zip hoodie, its cream cords). A cord: pixels far lighter or darker than nearly all
// of the cloth (beyond its 2nd to 98th percentiles by CORD_APART, from the cloth away from the middle), in
// one thin upright run (at least 6% of the garment long and three times as long as it's wide) near the
// middle, from below the hood down to three-quarters of the way; one that runs on to there is the zip.
// Each row of a cord (grown a little, for its shadow) is filled from the cloth either side (a few pixels'
// mean, so no streaks). Changes the canvas (ctx) in place; returns how many cords it painted out.
export function paintCords(ctx, mask, w, h, box) {
  const image = ctx.getImageData(0, 0, w, h), d = image.data
  const W = box.right - box.left + 1, H = box.bottom - box.top + 1
  if (W < 40 || H < 40) return 0
  const lum = i => 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2]
  // The middle: of the garment's top rows (a hood's crown, a collar).
  let sum = 0, n = 0
  for (let y = box.top; y <= box.top + Math.max(2, Math.round(H * 0.03)); y++) for (let x = box.left; x <= box.right; x++) if (mask[y * w + x]) { sum += x; n++ }
  if (!n) return 0
  const cx = sum / n, half = W * 0.2
  // The cloth's lightness, away from the middle.
  const lums = []
  for (let y = Math.round(box.top + H * 0.2); y < box.top + H * 0.8; y += 3) for (let x = box.left; x <= box.right; x += 3) {
    const i = y * w + x
    if (mask[i] && Math.abs(x - cx) > half) lums.push(lum(i))
  }
  if (lums.length < 200) return 0
  lums.sort((a, b) => a - b)
  const low = lums[Math.floor(lums.length * 0.02)] - CORD_APART, high = lums[Math.floor(lums.length * 0.98)] + CORD_APART
  // Candidates in the window, then their connected runs.
  const x0 = Math.max(0, Math.floor(cx - half)), x1 = Math.min(w - 1, Math.ceil(cx + half))
  const y0 = Math.round(box.top + H * 0.12), y1 = Math.min(h - 1, Math.round(box.top + H * 0.75))
  const ww = x1 - x0 + 1, wh = y1 - y0 + 1
  const cand = new Uint8Array(ww * wh)
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * w + x
    if (!mask[i]) continue
    const l = lum(i)
    if (l > high || l < low) cand[(y - y0) * ww + x - x0] = 1
  }
  const seen = new Uint8Array(ww * wh), fill = new Uint8Array(w * h)
  let cords = 0
  for (let k = 0; k < ww * wh; k++) {
    if (!cand[k] || seen[k]) continue
    const run = [k]
    seen[k] = 1
    let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1
    for (let r = 0; r < run.length; r++) {
      const q = run[r], qx = q % ww, qy = (q - qx) / ww
      if (qx < minX) minX = qx; if (qx > maxX) maxX = qx; if (qy < minY) minY = qy; if (qy > maxY) maxY = qy
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = qx + dx, ny = qy + dy
        if (nx < 0 || ny < 0 || nx >= ww || ny >= wh) continue
        const j = ny * ww + nx
        if (cand[j] && !seen[j]) { seen[j] = 1; run.push(j) }
      }
    }
    const tall = maxY - minY + 1, wide = maxX - minX + 1
    if (tall < H * 0.06 || tall < 3 * wide || maxY >= wh - 1) continue
    cords++
    for (const q of run) { const qx = q % ww, qy = (q - qx) / ww; fill[(qy + y0) * w + qx + x0] = 1 }
  }
  if (!cords) return 0
  // Grown a little (the cord's shadow, its soft edge), within the cloth.
  const grow = Math.max(2, Math.round(W * 0.006))
  const grown = boxBlur(Float32Array.from(fill), w, h, grow)
  for (let i = 0; i < w * h; i++) fill[i] = grown[i] > 0 && mask[i] ? 1 : 0
  const src = Uint8ClampedArray.from(d)
  const side = (x, y, dir, c) => {
    let total = 0, count = 0
    for (let dy = -3; dy <= 3; dy++) for (let k = 0; k < 4; k++) {
      const xx = x + dir * k, yy = y + dy
      if (xx < 0 || yy < 0 || xx >= w || yy >= h || fill[yy * w + xx] || !mask[yy * w + xx]) continue
      total += src[4 * (yy * w + xx) + c]; count++
    }
    return count ? total / count : null
  }
  for (let y = y0 - grow; y <= y1 + grow; y++) {
    if (y < 0 || y >= h) continue
    for (let x = Math.max(0, x0 - grow); x <= Math.min(w - 1, x1 + grow);) {
      if (!fill[y * w + x]) { x++; continue }
      let end = x
      while (end + 1 < w && fill[y * w + end + 1]) end++
      const a = x - 1, b = end + 1
      for (let c = 0; c < 3; c++) {
        const l = side(a, y, -1, c), r = side(b, y, 1, c)
        for (let k = x; k <= end; k++) {
          const t = (k - a) / (b - a)
          d[4 * (y * w + k) + c] = l !== null && r !== null ? l + (r - l) * t : l ?? r ?? d[4 * (y * w + k) + c]
        }
      }
      x = end + 1
    }
  }
  ctx.putImageData(image, 0, 0)
  return cords
}
// A cord is this much lighter than the cloth's lightest 2% (or darker than its darkest).
const CORD_APART = 15

// The cloth's rim in a photo: the band just inside its outline whose colour leans from the cloth's toward
// the backdrop's (bg) by more than RIM_LEAN of the way (Kith's &Kin sweatpants: half the way at the
// outline, still a tenth ten pixels in, more down the side the light came from and at the hem; a black
// tee's, a quarter at the outline, nothing a pixel in), as wide as it is there, at most RIM_MOST of the
// photo across: a pixel is in it when its lean (over the pixels round it, so a light thread of a
// herringbone isn't) is past that and the pixel outside it is in it too. Its pixels take the colour of the
// nearest cloth pixel inside it (a breadth-first spread in from there); the alpha is left. Changes the
// canvas (ctx) in place; returns how many pixels in it reaches at most (0 for none).
export function cleanRim(ctx, mask, w, h, bg) {
  const image = ctx.getImageData(0, 0, w, h), d = image.data
  const most = Math.max(1, Math.round(Math.max(w, h) * RIM_MOST))
  // Each cloth pixel's ring in from the outline (1 on it), up to one past the most.
  const ring = new Uint8Array(w * h)
  let frontier = []
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x
    if (!mask[i]) continue
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w]) { ring[i] = 1; frontier.push(i) }
  }
  const band = []
  for (let r = 2; frontier.length; r++) {
    for (const i of frontier) band.push(i)
    if (r > most + 1) break
    const next = []
    for (const i of frontier) for (const j of [i - 1, i + 1, i - w, i + w]) if (j >= 0 && j < w * h && mask[j] && !ring[j]) { ring[j] = r; next.push(j) }
    frontier = next
  }
  // The cloth's colour, from deeper in than the rim could be.
  const samples = [[], [], []]
  for (let i = 0; i < w * h; i += 5) if (mask[i] && !ring[i]) for (let c = 0; c < 3; c++) samples[c].push(d[4 * i + c])
  if (samples[0].length < 100) return 0
  const cloth = samples.map(v => { v.sort((a, b) => a - b); return v[v.length >> 1] })
  const toward = [0, 1, 2].map(c => bg[c] - cloth[c]), span = toward.reduce((sum, v) => sum + v * v, 0)
  if (span < 20 * 20) return 0   // the cloth about the backdrop's colour: no rim to tell
  // Each band pixel's lean, then its mean over the band's pixels within a few of it.
  const lean = new Float32Array(w * h), on = new Float32Array(w * h)
  for (const i of band) {
    let t = 0
    for (let c = 0; c < 3; c++) t += (d[4 * i + c] - cloth[c]) * toward[c]
    lean[i] = t / span; on[i] = 1
  }
  const near = Math.max(1, Math.round(most / 4))
  const sum = boxBlur(lean, w, h, near), weight = boxBlur(on, w, h, near)
  const leans = i => weight[i] > 1e-6 && sum[i] / weight[i] > RIM_LEAN
  // The rim: from the outline in, while it leans.
  const rim = new Uint8Array(w * h)
  frontier = band.filter(i => ring[i] === 1 && leans(i))
  for (const i of frontier) rim[i] = 1
  let width = frontier.length ? 1 : 0
  for (let r = 2; r <= most && frontier.length; r++) {
    const next = []
    for (const i of frontier) for (const j of [i - 1, i + 1, i - w, i + w]) if (j >= 0 && j < w * h && ring[j] === r && !rim[j] && leans(j)) { rim[j] = 1; next.push(j) }
    if (next.length) width = r
    frontier = next
  }
  if (!width) return 0
  // Filled from the cloth just inside it, ring by ring outward.
  frontier = []
  for (const i of band) if (!rim[i] && [i - 1, i + 1, i - w, i + w].some(j => j >= 0 && j < w * h && rim[j])) frontier.push(i)
  while (frontier.length) {
    const next = []
    for (const i of frontier) for (const j of [i - 1, i + 1, i - w, i + w]) {
      if (j < 0 || j >= w * h || rim[j] !== 1) continue
      rim[j] = 2   // (filled)
      d[4 * j] = d[4 * i]; d[4 * j + 1] = d[4 * i + 1]; d[4 * j + 2] = d[4 * i + 2]
      next.push(j)
    }
    frontier = next
  }
  ctx.putImageData(image, 0, 0)
  return width
}
// A rim pixel leans from the cloth's colour toward the backdrop's by more than this share of the way.
const RIM_LEAN = 0.08
// The widest rim taken over: this share of the photo across (13 pixels at its 1600).
const RIM_MOST = 0.008

// The share of a photo that's skin above which it's taken to be on someone (photoTraits' skin, which leaves
// out skin-coloured cloth).
const WORN_SKIN = 0.01
// How far past the cloth's edge its colour is carried (pixels at the photo's working size).
const BLEED = 16

function cutAtWaist(found, w, h, part) {
  const { mask, box } = found
  const span = box.bottom - box.top
  let waist = Math.round(box.top + 0.45 * span), least = Infinity
  for (let y = Math.round(box.top + span / 3); y <= box.top + (2 * span) / 3; y++) {
    let a = -1, b = -1
    for (let x = box.left; x <= box.right; x++) if (mask[y * w + x]) { if (a < 0) a = x; b = x }
    if (a >= 0 && b - a < least) { least = b - a; waist = y }
  }
  const out = Uint8Array.from(mask)
  if (part === "upper") out.fill(0, (waist + 1) * w)
  else out.fill(0, 0, waist * w)
  return maskFound(out, w, h, found.bg)
}

// Whether a photo shows someone: skin across the top of the figure (a face, a neck), which a garment laid
// out or hung never has (a tan print on a tee is skin-coloured too, but lower down), and far more of it there
// than over the clothes below. A print in tans all over (a camo) is as "skin" on a hood as on the body: Kith's
// Daily Paper camo zip hoodie was taken for someone wearing it, its tan patches cut out as skin, and the
// photo stretched over what was left in streaks.
function faceAtTop(data, w, h) {
  const person = garmentMask(data, w, h)?.mask
  if (!person) return false
  let top = -1, bottom = -1
  for (let y = 0; y < h && top < 0; y++) for (let x = 0; x < w; x++) if (person[y * w + x]) { top = y; break }
  for (let y = h - 1; y >= 0 && bottom < 0; y--) for (let x = 0; x < w; x++) if (person[y * w + x]) { bottom = y; break }
  if (top < 0) return false
  const share = (from, to) => {
    let skin = 0, all = 0
    for (let y = Math.round(from); y < to; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!person[i]) continue
      all++
      if (isSkin(data[4 * i], data[4 * i + 1], data[4 * i + 2])) skin++
    }
    return all > 0 ? skin / all : 0
  }
  const tall = bottom - top
  const head = share(top, top + 0.15 * tall), body = share(top + 0.3 * tall, top + 0.7 * tall)
  return head > 0.25 && head > 2 * body
}

// A mask as clothMask gives one: { mask, box, bg }.
function maskFound(mask, w, h, bg) {
  let left = w, right = -1, top = h, bottom = -1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y) }
  return right < 0 ? null : { mask, box: { left, right, top, bottom, w, h }, bg, hung: false }
}

// The backdrop's colour: the median of the photo's border.
function backdropOf(data, w, h) {
  const median = values => { values.sort((a, b) => a - b); return values[values.length >> 1] }
  return [0, 1, 2].map(c => { const e = []; for (let x = 0; x < w; x += 4) e.push(data[4 * x + c], data[4 * ((h - 1) * w + x) + c]); return median(e) })
}

// The cloth's colour: the median of the masked pixels.
function clothColourOf(data, mask, w, h) {
  const samples = [[], [], []]
  for (let i = 0; i < w * h; i += 7) if (mask[i]) for (let c = 0; c < 3; c++) samples[c].push(data[4 * i + c])
  if (!samples[0].length) return null
  return samples.map(v => { v.sort((a, b) => a - b); return v[v.length >> 1] })
}

// Every pixel within `radius` of the cloth (mask) but outside it takes the colour of the nearest cloth pixel
// (a breadth-first spread outward, a ring a pass); its alpha, where it holds a relief, flat (128).
export function bleed(data, mask, w, h, radius) {
  const filled = Uint8Array.from(mask)
  let frontier = []
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x
    if (!mask[i]) continue
    if ((x > 0 && !mask[i - 1]) || (x < w - 1 && !mask[i + 1]) || (y > 0 && !mask[i - w]) || (y < h - 1 && !mask[i + w])) frontier.push(i)
  }
  for (let ring = 0; ring < radius && frontier.length; ring++) {
    const next = []
    for (const i of frontier) {
      const x = i % w, y = (i - x) / w
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j < 0 || filled[j]) continue
        filled[j] = 1
        data[4 * j] = data[4 * i]; data[4 * j + 1] = data[4 * i + 1]; data[4 * j + 2] = data[4 * i + 2]; data[4 * j + 3] = 128
        next.push(j)
      }
    }
    frontier = next
  }
}

// A re-draped photo checked point by point: a cloth point whose place in its photo isn't the garment's cloth
// (off the mask, or skin where the cloth isn't skin-coloured: a hand, a neck, hair at a collar) takes the
// place of its nearest neighbour on the same pattern piece that is. uv: registerPhoto's, changed in place;
// photos: { front, back } as loadPhotoForRedrape gives them. Returns how many points were moved.
export function guardForeign(top, uv, photos) {
  const { cloth } = top
  const n = cloth.points.length
  const bad = new Uint8Array(n)
  const context = new Map()
  const pixelsOf = photo => {
    if (!context.has(photo)) context.set(photo, photo.canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, photo.canvas.width, photo.canvas.height).data)
    return context.get(photo)
  }
  let count = 0
  for (let i = 0; i < n; i++) {
    const photo = uv[3 * i + 2] === 3 && photos.back ? photos.back : photos.front
    const w = photo.canvas.width, h = photo.canvas.height
    const x = Math.min(w - 1, Math.max(0, Math.round(uv[3 * i] * w))), y = Math.min(h - 1, Math.max(0, Math.round((1 - uv[3 * i + 1]) * h)))
    const k = y * w + x
    // Off the cloth: no cloth within a few pixels (a point at the very edge is the edge, not the backdrop).
    let near = false
    for (let dy = -4; dy <= 4 && !near; dy += 2) for (let dx = -4; dx <= 4 && !near; dx += 2) {
      const yy = y + dy, xx = x + dx
      if (yy >= 0 && yy < h && xx >= 0 && xx < w && photo.mask[yy * w + xx]) near = true
    }
    if (!near) { bad[i] = 1; count++; continue }
    // Skin only counts on a photo of someone wearing it (a flat photo's red or tan cloth reads as skin too),
    // and not where the cloth itself is skin-coloured.
    if (!photo.worn || !photo.mask[k]) continue
    const d = pixelsOf(photo)
    const clothSkin = photo.cloth && isSkin(...photo.cloth)
    if (!clothSkin && isSkin(d[4 * k], d[4 * k + 1], d[4 * k + 2])) { bad[i] = 1; count++ }
  }
  if (!count) return 0
  // Neighbours on the same piece, by the cloth's triangles.
  const next = Array.from({ length: n }, () => [])
  for (const [a, b, c] of cloth.triangles) for (const [p, q] of [[a, b], [b, c], [c, a]]) if (cloth.panel[p] === cloth.panel[q]) { next[p].push(q); next[q].push(p) }
  const from = new Int32Array(n).fill(-1)
  let frontier = []
  for (let i = 0; i < n; i++) if (!bad[i]) { from[i] = i; frontier.push(i) }
  while (frontier.length) {
    const more = []
    for (const i of frontier) for (const j of next[i]) if (from[j] < 0) { from[j] = from[i]; more.push(j) }
    frontier = more
  }
  for (let i = 0; i < n; i++) if (bad[i] && from[i] >= 0) { const j = from[i]; uv[3 * i] = uv[3 * j]; uv[3 * i + 1] = uv[3 * j + 1]; uv[3 * i + 2] = uv[3 * j + 2] }
  return count
}

// The photo as a material rather than a picture: its light taken out, its relief kept. The photographer's
// light (a soft gradient, the shading of the large folds the garment hung in) is a wide blur of the photo's
// brightness over the cloth; dividing it out leaves the cloth's own colour and pattern, which the page's
// light then shades, with the folds the page's own drape gives it. What was taken out below the scale of the
// blur is the fabric's relief (its weave, ribbing, stitching, quilting, small creases) and goes in the alpha
// channel as a height, for the shader to tilt the surface by (as it does a puffer's baffles). Returns
// ImageData the size of the photo, or null when the photo is too small.
export function flatField(ctx, mask, box) {
  if (box.w < 64 || box.h < 64) return null
  return flatFieldImage(ctx.getImageData(0, 0, box.w, box.h), mask, box)
}

// flatField on ImageData (or { data, width, height }) in place; returns it, or null when there's too little cloth.
export function flatFieldImage(image, mask, box) {
  const w = box.w, h = box.h
  const d = image.data
  // Brightness at a quarter size, over the cloth only; blurred over about 3% of the garment's width.
  const sw = Math.max(1, w >> 2), sh = Math.max(1, h >> 2)
  const lum = new Float32Array(sw * sh), on = new Float32Array(sw * sh)
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    let sum = 0, n = 0
    for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
      const X = Math.min(w - 1, 4 * x + dx), Y = Math.min(h - 1, 4 * y + dy)
      if (!mask[Y * w + X]) continue
      const i = 4 * (Y * w + X)
      sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; n++
    }
    if (n) { lum[y * sw + x] = sum / n; on[y * sw + x] = 1 }
  }
  // Two blurs: a wide one (12% of the garment's width) is the photographer's light, a gradient over the
  // garment; a narrow one (2%) is the reference the relief is read against.
  const wide = Math.max(2, Math.round(0.12 * (box.right - box.left) / 4)), narrow = Math.max(1, Math.round(0.02 * (box.right - box.left) / 4))
  const blurredWide = boxBlur(lum, sw, sh, wide), weightWide = boxBlur(on, sw, sh, wide)
  const blurredNarrow = boxBlur(lum, sw, sh, narrow), weightNarrow = boxBlur(on, sw, sh, narrow)
  const shade = new Float32Array(sw * sh), local = new Float32Array(sw * sh)
  const levels = []
  for (let k = 0; k < sw * sh; k++) {
    shade[k] = weightWide[k] > 0.05 ? blurredWide[k] / weightWide[k] : 0
    local[k] = weightNarrow[k] > 0.05 ? blurredNarrow[k] / weightNarrow[k] : 0
    if (on[k] && shade[k] > 0) levels.push(shade[k])
  }
  if (levels.length < 50) return null
  levels.sort((a, b) => a - b)
  const median = levels[levels.length >> 1]
  // Each pixel divided by the light there (never by more than a factor of 1.4 either way: the gradient goes,
  // the folds the garment hung in stay, as photographed), and its relief: how much brighter or darker it is
  // than its near surroundings, as a height about 0.5.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = 4 * (y * w + x)
    if (!mask[y * w + x]) { d[i + 3] = 128; continue }
    const k = (y >> 2) * sw + (x >> 2)
    const s = shade[k], ref = local[k]
    const gain = s > 0 ? Math.min(1.4, Math.max(0.7, median / s)) : 1
    const L = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
    d[i] = Math.min(255, d[i] * gain); d[i + 1] = Math.min(255, d[i + 1] * gain); d[i + 2] = Math.min(255, d[i + 2] * gain)
    const relief = ref > 8 ? Math.max(-0.5, Math.min(0.5, L / ref - 1)) : 0
    d[i + 3] = Math.round(128 + relief * 200)
  }
  return image
}

// Whether a photo shows cloth, not its backdrop, at a texture coordinate (u, v) of registerPhoto's: a cut-out
// a listing names that the photo shows covered (by a drape, a panel) isn't cut.
export function showsCloth(photo, u, v) {
  const { canvas, mask, box, bg } = photo
  const x = Math.min(canvas.width - 1, Math.max(0, Math.round(u * canvas.width))), y = Math.min(canvas.height - 1, Math.max(0, Math.round((1 - v) * canvas.height)))
  if (!mask[y * canvas.width + x]) return false
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  const p = ctx.getImageData(x, y, 1, 1).data
  return Math.hypot(p[0] - bg[0], p[1] - bg[1], p[2] - bg[2]) > 40
}

// The neck opening of a photo of the front painted over with the cloth beside it: the backdrop seen through
// it, and the label inside the back of the neck, would otherwise be laid on the chest or the collar. Only on
// a garment darker than a backdrop or a label (the bright pixels at the top of a white tee are the tee), and
// only at the neck: the top of the garment, in the middle (a chest logo sits lower and off to a side).
function patchLabels(ctx, mask, box) {
  const w = box.w
  const H = box.bottom - box.top
  const rows = Math.min(Math.max(2, Math.round(0.13 * H)), box.h - box.top)
  const middle = (box.left + box.right) / 2, near = 0.14 * (box.right - box.left)
  const x0 = Math.max(box.left, Math.round(middle - near)), x1 = Math.min(box.right, Math.round(middle + near))
  // The cloth's colour, from the middle of the garment.
  const mid = ctx.getImageData(0, box.top + Math.round(0.3 * H), w, Math.max(1, Math.round(0.4 * H))).data
  const samples = [[], [], []]
  for (let i = 0; i < mid.length / 4; i += 5) {
    const y = box.top + Math.round(0.3 * H) + Math.floor(i / w), x = i % w
    if (x < box.left || x > box.right || !mask[y * w + x]) continue
    for (let c = 0; c < 3; c++) samples[c].push(mid[4 * i + c])
  }
  if (samples[0].length < 100) return
  const median = values => { values.sort((a, b) => a - b); return values[values.length >> 1] }
  const cloth = samples.map(median)
  if (Math.max(...cloth) > 150) return
  // Bright: well lighter than the cloth, in every channel. A garment with much of that in its middle (a
  // plaid's pale checks, a print) keeps its neck as it is.
  const lift = 70
  let pale = 0
  for (let k = 0; k < samples[0].length; k++) if (samples[0][k] > cloth[0] + lift && samples[1][k] > cloth[1] + lift && samples[2][k] > cloth[2] + lift) pale++
  if (pale > 0.04 * samples[0].length) return
  const image = ctx.getImageData(0, box.top, w, rows)
  const d = image.data
  // The gaps of a label's printed words are closed (the bright grown by 4 pixels, then shrunk back).
  let bright = new Uint8Array(w * rows)
  for (let y = 0; y < rows; y++) for (let x = x0; x <= x1; x++) {
    const i = 4 * (y * w + x)
    if (mask[(box.top + y) * w + x] && d[i] > cloth[0] + lift && d[i + 1] > cloth[1] + lift && d[i + 2] > cloth[2] + lift) bright[y * w + x] = 1
  }
  const grow = (input, value) => {
    const R = 4
    const pass1 = new Uint8Array(w * rows), out = new Uint8Array(w * rows)
    for (let y = 0; y < rows; y++) for (let x = x0; x <= x1; x++) {
      let hit = 0
      for (let k = -R; k <= R && !hit; k++) { const xx = x + k; if (xx >= x0 && xx <= x1 && input[y * w + xx] === value) hit = 1 }
      pass1[y * w + x] = hit ? value : 1 - value
    }
    for (let y = 0; y < rows; y++) for (let x = x0; x <= x1; x++) {
      let hit = 0
      for (let k = -R; k <= R && !hit; k++) { const yy = y + k; if (yy >= 0 && yy < rows && pass1[yy * w + x] === value) hit = 1 }
      out[y * w + x] = hit ? value : 1 - value
    }
    return out
  }
  bright = grow(grow(bright, 1), 0)
  let painted = 0
  // Each painted pixel takes the cloth either side of its run on the row, blended across it.
  for (let y = 0; y < rows; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!bright[y * w + x]) continue
      let b = x
      while (b + 1 <= x1 && bright[y * w + b + 1]) b++
      const pick = px => (px >= box.left && px <= box.right && mask[(box.top + y) * w + px] && !bright[y * w + px] ? [d[4 * (y * w + px)], d[4 * (y * w + px) + 1], d[4 * (y * w + px) + 2]] : null)
      let left = null, right = null
      for (let k = 1; k < 16 && !left; k++) left = pick(x - k)
      for (let k = 1; k < 16 && !right; k++) right = pick(b + k)
      left ??= right; right ??= left
      if (!left) { x = b; continue }
      for (let px = x; px <= b; px++) {
        const t = b > x ? (px - x) / (b - x) : 0
        const i = 4 * (y * w + px)
        for (let c = 0; c < 3; c++) d[i + c] = Math.round(left[c] * (1 - t) + right[c] * t)
        painted++
      }
      x = b
    }
  }
  if (painted) ctx.putImageData(image, 0, box.top)
}

// Lettering, appliqué and logos kept rigid. The point-by-point registration bends a print with the rows it
// crosses, which shears a word where a row's ends move (the zip, a sleeve's seam, a fold the hanging shape
// has and the photo hasn't). So each graphic in the photo (a patch of pixels far from the cloth's colour,
// its letters joined) is laid on the cloth as one piece: the points that land on it take the place a single
// move, turn and scale of their own pattern piece gives them (fitted, by least squares, to where the
// registration put them), blended back into the registration over a margin round it, so the print follows
// the cloth's drape without ever shearing. An all-over print (most of the garment) is left as registered.
// uv: registerPhoto's, changed in place; photo: loadPhotoForRedrape's; which: 1 (front) or 3 (back).
// Returns how many graphics were laid rigid.
export function rigidPrints(top, uv, photo, which = 1) {
  const { cloth } = top
  const W = photo.canvas.width, H = photo.canvas.height
  const sw = W >> 1, sh = H >> 1
  if (!photo.cloth || sw < 32 || sh < 32) return 0
  const data = photo.canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, W, H).data
  const [cr, cg, cb] = photo.cloth
  // The graphic's pixels at half size: far from the cloth's colour, on the cloth.
  const graphic = new Uint8Array(sw * sh)
  let on = 0, cloth2 = 0
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const X = 2 * x, Y = 2 * y, k = Y * W + X
    if (!photo.mask[k]) continue
    cloth2++
    const i = 4 * k
    if (Math.hypot(data[i] - cr, data[i + 1] - cg, data[i + 2] - cb) > 70) { graphic[y * sw + x] = 1; on++ }
  }
  if (!cloth2 || on < 0.003 * cloth2 || on > 0.4 * cloth2) return 0
  // Letters joined into words (grown by 1.2% of the garment's width), then the pieces as regions.
  const box = photo.box, reach = Math.max(2, Math.round((box.right - box.left) * 0.006))
  const grown = boxBlur(Float32Array.from(graphic), sw, sh, reach)
  const label = new Int32Array(sw * sh).fill(-1)
  const regions = []
  for (let k = 0; k < sw * sh; k++) {
    if (grown[k] <= 0.02 || label[k] >= 0) continue
    const stack = [k], cells = []
    label[k] = regions.length
    while (stack.length) {
      const i = stack.pop(), x = i % sw, y = (i - x) / sw
      cells.push(i)
      for (const j of [x > 0 ? i - 1 : -1, x < sw - 1 ? i + 1 : -1, y > 0 ? i - sw : -1, y < sh - 1 ? i + sw : -1]) {
        if (j < 0 || label[j] >= 0 || grown[j] <= 0.02) continue
        label[j] = regions.length
        stack.push(j)
      }
    }
    regions.push(cells.length)
  }
  const keep = regions.map(area => area >= 0.002 * cloth2 && area <= 0.35 * cloth2)
  if (!keep.some(Boolean)) return 0
  // Each point's region (by where the registration put it), on this photo.
  const n = cloth.points.length
  const regionOf = new Int32Array(n).fill(-1)
  for (let i = 0; i < n; i++) {
    if (uv[3 * i + 2] !== which) continue
    const x = Math.min(sw - 1, Math.max(0, Math.floor((uv[3 * i] * W) / 2))), y = Math.min(sh - 1, Math.max(0, Math.floor(((1 - uv[3 * i + 1]) * H) / 2)))
    const r = label[y * sw + x]
    if (r >= 0 && keep[r]) regionOf[i] = r
  }
  // A region's points on one pattern piece: fit pattern (cm) to photo (pixels), a similarity, and lay them by it.
  const groups = new Map()
  for (let i = 0; i < n; i++) if (regionOf[i] >= 0) { const key = `${regionOf[i]}:${cloth.panel[i]}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(i) }
  let laid = 0
  for (const points of groups.values()) {
    if (points.length < 12) continue
    const dst = points.map(i => [uv[3 * i] * W, (1 - uv[3 * i + 1]) * H])
    // A pattern piece is drawn y up and the photo y down, and a piece may lie either way round on it: the
    // pattern's points are tried each way, the best fit kept. Never mirrored against how the registration
    // lays the whole piece (a mirrored K is the one thing a graphic can't be).
    const hand = handOf(cloth, uv, cloth.panel[points[0]], W, H)
    let best = null
    for (const [fx, fy] of [[1, -1], [-1, -1], [1, 1], [-1, 1]]) {
      if (hand && Math.sign(fx * fy) !== hand) continue
      const src = points.map(i => [fx * cloth.points[i][0], fy * cloth.points[i][1]])
      const t = similarity(src, dst)
      if (!t) continue
      let err = 0
      for (let k = 0; k < points.length; k++) { const [x, y] = t(src[k]); err += Math.hypot(x - dst[k][0], y - dst[k][1]) }
      if (!best || err < best.err) best = { t, src, err }
    }
    // Too far from the registration (a wrong match): left as registered.
    if (!best || best.err / points.length > 0.05 * (box.right - box.left)) continue
    const { t, src } = best
    // Blended in from the region's edge: a point's weight by how many of its neighbours are in the region.
    const inRegion = new Set(points)
    for (let k = 0; k < points.length; k++) {
      const i = points[k]
      const [x, y] = t(src[k])
      const w = edgeWeight(cloth, i, inRegion)
      uv[3 * i] = (w * x + (1 - w) * dst[k][0]) / W
      uv[3 * i + 1] = 1 - (w * y + (1 - w) * dst[k][1]) / H
    }
    laid++
  }
  return laid
}

// A point's share of neighbours in a set, through the cloth's triangles (1 deep inside, about 0.5 at the edge).
let neighbourCache = new WeakMap()
function edgeWeight(cloth, i, set) {
  let next = neighbourCache.get(cloth)
  if (!next) {
    next = Array.from({ length: cloth.points.length }, () => new Set())
    for (const [a, b, c] of cloth.triangles) { next[a].add(b).add(c); next[b].add(a).add(c); next[c].add(a).add(b) }
    neighbourCache.set(cloth, next)
  }
  let inside = 0, all = 0
  for (const j of next[i]) { all++; if (set.has(j)) inside++ }
  return all ? Math.min(1, Math.max(0, (inside / all - 0.5) * 2)) : 1
}

// The least-squares similarity (move, turn, scale; no mirroring) from points src to dst ([x, y] each), as a
// function, or null when the points are degenerate.
export function similarity(src, dst) {
  const n = src.length
  let sx = 0, sy = 0, dx = 0, dy = 0
  for (let k = 0; k < n; k++) { sx += src[k][0]; sy += src[k][1]; dx += dst[k][0]; dy += dst[k][1] }
  sx /= n; sy /= n; dx /= n; dy /= n
  let a = 0, b = 0, ss = 0
  for (let k = 0; k < n; k++) {
    const px = src[k][0] - sx, py = src[k][1] - sy, qx = dst[k][0] - dx, qy = dst[k][1] - dy
    a += px * qx + py * qy
    b += px * qy - py * qx
    ss += px * px + py * py
  }
  if (ss < 1e-9) return null
  const c = a / ss, s = b / ss
  return ([x, y]) => [dx + c * (x - sx) - s * (y - sy), dy + s * (x - sx) + c * (y - sy)]
}

// Which pieces the photos really show, and plain cloth for the rest. Laying a photo on point for point only
// works where the photo shows that piece: a hood on a front photo is seen from inside or folded down, a
// sleeve laid along the body borrows the body's lettering, a sleeve on someone wearing it is half arm. Such a
// piece shows a patch of the photo's plainest cloth instead (plainPatch: its colour and weave, no picture),
// which can look plain where the garment isn't, but never shows something that isn't the garment.
//
//   hood            always plain (its outside isn't on a front photo)
//   sleeves, bands  plain when more of the piece is off the cloth's colour than the photo can explain:
//                   a fifth of a sleeve (a sixth on a worn photo), half a band
//   the back        plain when there's no photo of it and the front has a graphic (a chest print isn't
//                   on the back too), else the front laid on as before
//
// photos: { front, back } as loadPhotoForRedrape gives them; uv as registerPhoto gives it, changed in place.
// Returns { plain: [piece names], far: { name: share } } (far: the share of each piece's points off the
// cloth's colour, before any were made plain).
export function trustPieces(top, uv, photos) {
  const { cloth } = top
  const n = cloth.points.length
  const names = cloth.panels
  const pixels = new Map()
  const pixelsOf = photo => {
    if (!pixels.has(photo)) pixels.set(photo, photo.canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, photo.canvas.width, photo.canvas.height).data)
    return pixels.get(photo)
  }
  const photoOf = i => (uv[3 * i + 2] === 3 && photos.back ? photos.back : photos.front)
  // How much of each piece is off the cloth's colour, and its middle colour.
  const stats = names.map(() => ({ n: 0, far: 0, rgb: [[], [], []] }))
  for (let i = 0; i < n; i++) {
    if (!(uv[3 * i + 2] > 0)) continue
    const photo = photoOf(i), w = photo.canvas.width, h = photo.canvas.height
    const x = Math.min(w - 1, Math.max(0, Math.round(uv[3 * i] * w))), y = Math.min(h - 1, Math.max(0, Math.round((1 - uv[3 * i + 1]) * h)))
    const d = pixelsOf(photo), k = 4 * (y * w + x)
    const s = stats[cloth.panel[i]]
    s.n++
    if (!photo.cloth || Math.hypot(d[k] - photo.cloth[0], d[k + 1] - photo.cloth[1], d[k + 2] - photo.cloth[2]) > FAR) s.far++
    for (let c = 0; c < 3; c++) s.rgb[c].push(d[k + c])
  }
  const far = Object.fromEntries(names.map((name, p) => [name, stats[p].n ? Math.round((stats[p].far / stats[p].n) * 100) / 100 : null]))
  // A print all over (a check, a jacquard, a camo) is on the sleeves and back too, and stays; a placed graphic
  // (a chest print, lettering) is what a sleeve or a back mustn't borrow. All over: most of the front off the
  // cloth's colour, or the back photo about as busy as the front.
  const front = photoShare(photos.front), back = photos.back ? photoShare(photos.back) : null
  const allOver = front != null && (front > 0.5 || (back != null && front > 0.08 && back > 0.6 * front))
  const graphic = !allOver && front != null && front > 0.04
  const worn = Boolean(photos.front.worn)
  const plain = []
  // A pair (the two sleeves, cuffs, halves of a hood) goes together: one plain sleeve beside one printed one
  // looks more wrong than either.
  const pairOf = name => name.replace(/_[LR]$/, "")
  const worst = {}
  for (const name of names) if (far[name] != null) worst[pairOf(name)] = Math.max(worst[pairOf(name)] ?? 0, far[name])
  for (const [p, name] of names.entries()) {
    if (far[name] == null) continue
    const share = worst[pairOf(name)]
    let reason = null
    if (/^hood/.test(name)) reason = "hood"
    else if (allOver) reason = null
    else if (/^sleeve/.test(name) && share > (worn ? 0.16 : 0.2)) reason = "sleeve"
    else if (/^(cuff|waistband|collar|placket)/.test(name) && share > 0.5) reason = "band"
    else if (/^back/.test(name) && !photos.back && graphic) reason = "back"
    if (!reason) continue
    // Bands keep their own colour (a black rib on grey); the rest take the cloth's.
    const median = values => { const v = [...values].sort((a, b) => a - b); return v[v.length >> 1] }
    const target = reason === "band" ? stats[p].rgb.map(median) : null
    const source = reason === "back" || !photos.back || !/^back/.test(name) ? photos.front : photos.back
    const patch = plainPatch(source, target ?? source.cloth)
    if (!patch) continue
    layPatch(cloth, uv, p, source, patch, source === photos.back ? 3 : 1)
    plain.push(name)
  }
  return { plain, far, front, back, allOver }
}

// The share of a photo's cloth off the cloth's colour (FAR away), sampled every 4 pixels.
function photoShare(photo) {
  if (!photo?.cloth || !photo.mask) return null
  const W = photo.canvas.width
  const d = photo.canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, W, photo.canvas.height).data
  let n = 0, far = 0
  for (let y = photo.box.top; y <= photo.box.bottom; y += 4) for (let x = photo.box.left; x <= photo.box.right; x += 4) {
    const k = y * W + x
    if (!photo.mask[k]) continue
    n++
    if (Math.hypot(d[4 * k] - photo.cloth[0], d[4 * k + 1] - photo.cloth[1], d[4 * k + 2] - photo.cloth[2]) > FAR) far++
  }
  return n ? far / n : null
}

// The share of a piece off the cloth's colour counts pixels this far from it (RGB distance): a heather's
// light and dark flecks are nearer than that, lettering and skin and a lining in shadow are further.
const FAR = 70

// The plainest square of cloth in a photo near a colour: the window, about a twentieth of the garment across,
// all on the cloth (and no skin, on a worn photo), whose colour is nearest the target and whose pixels vary
// least. { x, y, w, h } in the photo's pixels, or null.
export function plainPatch(photo, target) {
  if (!photo?.mask || !target) return null
  const { box } = photo
  const W = photo.canvas.width, H = photo.canvas.height
  const d = photo.canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, W, H).data
  const size = Math.max(8, Math.round(0.05 * (box.right - box.left)))
  const step = Math.max(2, size >> 1), probe = Math.max(1, size >> 3)
  let best = null
  for (let y = box.top; y + size <= box.bottom; y += step) for (let x = box.left; x + size <= box.right; x += step) {
    let n = 0, sum = [0, 0, 0], sq = 0, ok = true
    for (let yy = y; yy < y + size && ok; yy += probe) for (let xx = x; xx < x + size; xx += probe) {
      const k = yy * W + xx
      if (!photo.mask[k]) { ok = false; break }
      const r = d[4 * k], g = d[4 * k + 1], b = d[4 * k + 2]
      if (photo.worn && isSkin(r, g, b)) { ok = false; break }
      sum[0] += r; sum[1] += g; sum[2] += b; sq += r * r + g * g + b * b; n++
    }
    if (!ok || !n) continue
    const mean = sum.map(v => v / n)
    const spread = Math.sqrt(Math.max(0, sq / n - (mean[0] ** 2 + mean[1] ** 2 + mean[2] ** 2)))
    const score = Math.hypot(mean[0] - target[0], mean[1] - target[1], mean[2] - target[2]) + spread
    if (!best || score < best.score) best = { score, x, y, w: size, h: size, gap: Math.hypot(mean[0] - target[0], mean[1] - target[1], mean[2] - target[2]) }
  }
  // Nothing near the colour (a band in a colour the photo shows nowhere broad enough): no patch.
  return best && best.gap < 45 ? best : null
}

// A piece's points laid on a patch: the piece's pattern, scaled the same both ways to fit inside it.
function layPatch(cloth, uv, panel, photo, patch, which) {
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity
  for (let i = 0; i < cloth.points.length; i++) if (cloth.panel[i] === panel) {
    const [x, y] = cloth.points[i]
    minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y)
  }
  const span = Math.max(1e-6, maxx - minx, maxy - miny)
  const inner = 0.8 * patch.w, x0 = patch.x + 0.1 * patch.w, y0 = patch.y + 0.1 * patch.h
  const W = photo.canvas.width, H = photo.canvas.height
  for (let i = 0; i < cloth.points.length; i++) if (cloth.panel[i] === panel) {
    const [x, y] = cloth.points[i]
    const qx = x0 + ((x - minx) / span) * inner, qy = y0 + ((maxy - y) / span) * inner
    uv[3 * i] = qx / W; uv[3 * i + 1] = 1 - qy / H; uv[3 * i + 2] = which
  }
}

// Which way round the registration lays a pattern piece on its photo: the sign of the determinant of the
// least-squares linear map from the piece's pattern (cm) to its photo points (pixels), 1 or -1, or 0 when
// it can't tell (too few points, or the piece folded flat).
const hands = new WeakMap()
function handOf(cloth, uv, panel, W, H) {
  let cache = hands.get(uv)
  if (!cache) { cache = new Map(); hands.set(uv, cache) }
  if (cache.has(panel)) return cache.get(panel)
  let n = 0, mx = 0, my = 0, mu = 0, mv = 0
  for (let i = 0; i < cloth.points.length; i++) if (cloth.panel[i] === panel && uv[3 * i + 2] > 0) { n++; mx += cloth.points[i][0]; my += cloth.points[i][1]; mu += uv[3 * i] * W; mv += (1 - uv[3 * i + 1]) * H }
  let hand = 0
  if (n >= 6) {
    mx /= n; my /= n; mu /= n; mv /= n
    let sxx = 0, sxy = 0, syy = 0, sux = 0, suy = 0, svx = 0, svy = 0
    for (let i = 0; i < cloth.points.length; i++) if (cloth.panel[i] === panel && uv[3 * i + 2] > 0) {
      const x = cloth.points[i][0] - mx, y = cloth.points[i][1] - my, u = uv[3 * i] * W - mu, v = (1 - uv[3 * i + 1]) * H - mv
      sxx += x * x; sxy += x * y; syy += y * y; sux += u * x; suy += u * y; svx += v * x; svy += v * y
    }
    const det = sxx * syy - sxy * sxy
    if (Math.abs(det) > 1e-9) {
      // [a b; c d] = [sux suy; svx svy] * inverse([sxx sxy; sxy syy])
      const a = (sux * syy - suy * sxy) / det, b = (suy * sxx - sux * sxy) / det
      const c = (svx * syy - svy * sxy) / det, d = (svy * sxx - svx * sxy) / det
      const m = a * d - b * c
      hand = Math.abs(m) > 1e-9 ? Math.sign(m) : 0
    }
  }
  cache.set(panel, hand)
  return hand
}
