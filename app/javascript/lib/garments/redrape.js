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
import { Drape } from "lib/garments/drape"
import { boxBlur, garmentMask } from "lib/garments/print"

// Frames the hanger drape runs at most (it stops when still).
const HANGER_FRAMES = 400
// Rows the hanging silhouette is read at.
const ROWS = 512

// The garment hanging as a store photographs it: from the body drape's rest shape (restX: the sewn garment
// in the sewing pose, by simulated point), held at its shoulder seams and neck, let fall with no body under
// it until still. Run a few milliseconds at a time (advance), so the page keeps drawing; `positions` are the
// hanging positions by simulated point (the same points as the body drape's) once `done`.
export class HangerDrape {
  constructor(top, restX, { frames = HANGER_FRAMES } = {}) {
    const { cloth, pattern } = top
    const map = top.drape.map
    const n = cloth.points.length
    const start = new Float32Array(3 * n)
    for (let i = 0; i < n; i++) { const j = map[i]; start[3 * i] = restX[3 * j]; start[3 * i + 1] = restX[3 * j + 1]; start[3 * i + 2] = restX[3 * j + 2] }
    const nobody = { at: () => 1, hit: [0, 1, 0], layers: null }
    const drape = this.drape = new Drape(cloth, start, { field: nobody }, { fabric: pattern.fabric, friction: 0.3 })
    drape.releaseBands()
    drape.closeSeams()
    // The points a hanger holds: a top's shoulder seams and neck (a sleeveless top's straps are its
    // shoulders); trousers' or a skirt's waist.
    const heldEdge = top.bottoms ? key => /\/waist$/.test(key) || /^waistband\//.test(key) : key => /\/(shoulder_[LR]|neck_[LR]|strap.*|top)$/.test(key) || /^collar\//.test(key)
    const held = this.held = [...new Set(Object.keys(cloth.edges).filter(heldEdge).flatMap(key => cloth.edges[key].map(i => drape.map[i])))]
    const at = this.at = new Float32Array(3 * held.length)
    held.forEach((j, k) => { at[3 * k] = drape.x[3 * j]; at[3 * k + 1] = drape.x[3 * j + 1]; at[3 * k + 2] = drape.x[3 * j + 2] })
    for (const j of held) drape.w[j] = 0
    this.still = drape.stillness()
    this.frames = frames
    this.frame = 0
    this.done = held.length === 0   // nothing to hang it by: no hanging shape
    this.positions = drape.x
  }

  hold() {
    const { drape, held, at } = this
    held.forEach((j, k) => { drape.x[3 * j] = at[3 * k]; drape.x[3 * j + 1] = at[3 * k + 1]; drape.x[3 * j + 2] = at[3 * k + 2]; drape.v[3 * j] = drape.v[3 * j + 1] = drape.v[3 * j + 2] = 0 })
  }

  // Runs for up to `budget` milliseconds. Returns true while there's more to do.
  advance(budget = 10) {
    if (this.done) return false
    const end = performance.now() + budget
    do {
      this.drape.step({ gravity: true, sew: false })
      this.hold()
      this.frame++
      if (this.frame >= this.frames || (this.frame > 60 && this.still.quiet(0.00025))) { this.done = true; break }
    } while (performance.now() < end)
    return !this.done
  }
}

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
  // The hanger's hook: the rows at the top narrower than a third of the widest.
  let first = -1, hookEnd = -1
  for (let y = 0; y < h; y++) {
    if (!widths[y]) continue
    if (first < 0) first = y
    if (widths[y] < widest * 0.3) { out.fill(0, y * w, (y + 1) * w); hookEnd = y } else break
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
  const vext = [0, 1, 2].map(g => { let lo = Infinity, hi = -Infinity; for (let i = 0; i < n; i++) if (groupOf(names[cloth.panel[i]]) === g) { const Y = hanging[3 * map[i] + 1]; lo = Math.min(lo, Y); hi = Math.max(hi, Y) } return [lo, hi] })
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
  const ends = { front: endsOf(layouts.front), back: layouts.back ? endsOf(layouts.back) : null }
  // The photo's rows per unit of hanging height, and each group's hanging top and bottom as photo rows.
  const scaleOf = layout => {
    const end = layout === layouts.back ? ends.back : ends.front
    const [blo, bhi] = bottoms ? [miny, maxy] : vext[1]
    const scale = (bottoms ? layout.H - 1 : end.body) / Math.max(1e-6, bhi - blo)
    const rowsOf = [0, 1, 2].map(g => {
      const [glo, ghi] = vext[g]
      if (!Number.isFinite(glo)) return null
      const from = (bhi - ghi) * scale
      let to = (bhi - glo) * scale
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
    const inset = Math.max(1, Math.round(layout.width * 0.002))
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
export async function loadPhotoForRedrape(src, size = 2000, { labels = true } = {}) {
  const image = await new Promise((resolve, reject) => { const img = new Image(); img.crossOrigin = "anonymous"; img.onload = () => resolve(img); img.onerror = reject; img.src = src })
  const scale = Math.min(1, size / Math.max(image.naturalWidth, image.naturalHeight))
  const w = Math.round(image.naturalWidth * scale), h = Math.round(image.naturalHeight * scale)
  const canvas = document.createElement("canvas")
  canvas.width = w; canvas.height = h
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  ctx.drawImage(image, 0, 0, w, h)
  // The mask at a quarter size (it's read row by row), scaled up when used.
  const small = document.createElement("canvas")
  const sw = Math.round(w / 2), sh = Math.round(h / 2)
  small.width = sw; small.height = sh
  const sctx = small.getContext("2d", { willReadFrequently: true })
  sctx.drawImage(canvas, 0, 0, sw, sh)
  const found = clothMask(sctx.getImageData(0, 0, sw, sh).data, sw, sh)
  if (!found) return null
  const mask = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) mask[y * w + x] = found.mask[Math.min(sh - 1, y >> 1) * sw + Math.min(sw - 1, x >> 1)]
  const b = found.box
  const box = { left: b.left * 2, right: Math.min(w - 1, b.right * 2 + 1), top: b.top * 2, bottom: Math.min(h - 1, b.bottom * 2 + 1), w, h }
  if (labels) patchLabels(ctx, mask, box)
  const flat = flatField(ctx, mask, box)
  return { canvas, mask, box, bg: found.bg, flat }
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
