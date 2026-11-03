// Fitting the pattern to the photo. A garment laid flat or hung for its shop photo shows its front at true
// proportion: the photo is a scale drawing of the pattern we draft. So instead of drafting from the listing's
// words alone, the photo's outline is measured (measureOutline) and the chart's measurements are moved to
// match it (fitChart), within the garment's own size spread; and what the outline shows of the construction
// (constructionFrom: the collar, the sleeves' length, a hood, bands at the cuffs and hem) corrects the
// listing's reading. All of it is arithmetic on the photo's cloth mask (redrape.js's clothMask), in the page.
//
// Scale: the photo shows one size, the shop's sample (photoSize: the middle of the chart). Its chest is the
// yardstick when the sleeves hang apart from the body (the body's width under the arms is half the chest);
// otherwise the chart's length is. With neither, nothing is fitted.
import { clothMask, layoutPhoto } from "lib/garments/redrape"
import { loadImage } from "lib/garments/print"

// How far the photo may move a chart measurement the chart gives (a share); a measurement the chart doesn't
// give is the photo's.
const MOVE = { length: 0.25, shoulders: 0.2, sleeve: 0.3, waist: 0.3 }
// The photo is read at about this many pixels across.
const SIZE = 900

// A store photo as its outline measurements: loads the photo, finds the cloth (clothMask) and measures it
// (measureOutline). Null when the photo doesn't show a garment laid out or hanging.
export async function readOutline(src) {
  const image = await loadImage(src)
  const scale = Math.min(1, SIZE / Math.max(image.naturalWidth, image.naturalHeight))
  const w = Math.round(image.naturalWidth * scale), h = Math.round(image.naturalHeight * scale)
  const canvas = document.createElement("canvas")
  canvas.width = w; canvas.height = h
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  ctx.drawImage(image, 0, 0, w, h)
  const found = clothMask(ctx.getImageData(0, 0, w, h).data, w, h)
  if (!found) return null
  return measureOutline({ mask: found.mask, box: { ...found.box, w, h }, hung: found.hung })
}

// The photo's garment measured, in pixels of the photo: rows and widths of its body and sleeves, its neck,
// and what its outline says of its construction. photo: { mask, box } as clothMask gives them.
export function measureOutline(photo) {
  const { mask, box } = photo
  const w = box.w, H = box.bottom - box.top + 1, W = box.right - box.left
  if (H < 40 || W < 20) return null
  const layout = layoutPhoto(photo, false)
  const num = v => (Number.isNaN(v) || v == null ? null : v)
  const allW = y => { const a = num(layout.all[0][y]), b = num(layout.all[1][y]); return a == null ? 0 : b - a }
  const bodyW = y => { const a = num(layout.body[0][y]), b = num(layout.body[1][y]); return a == null ? 0 : b - a }
  // The top and bottom edges, column by column: the first and last cloth rows.
  const topY = new Int32Array(w).fill(-1), bottomY = new Int32Array(w).fill(-1)
  for (let x = box.left; x <= box.right; x++) {
    for (let y = box.top; y <= box.bottom; y++) if (mask[y * w + x]) { topY[x] = y - box.top; break }
    for (let y = box.bottom; y >= box.top; y--) if (mask[y * w + x]) { bottomY[x] = y - box.top; break }
  }
  // The centre column, where the neck is.
  const centre = Math.round((box.left + box.right) / 2)
  // The shoulder points: the garment's top corners. Outside the collar (the middle 35% of the width), the
  // top edge runs level from shoulder to shoulder on a hanging garment, and climbs to that level along a
  // sleeve laid out to the side; the shoulder level is where that edge mostly lies (its 10th percentile of
  // height), and each shoulder point the outermost column reaching within 2% of the length of it.
  const shoulder = { left: null, right: null }
  const outer = []
  for (let x = box.left; x <= box.right; x++) if (topY[x] >= 0 && Math.abs(x - centre) > 0.175 * W) outer.push(topY[x])
  outer.sort((a, b) => a - b)
  const level = outer.length ? outer[Math.floor(outer.length * 0.1)] : 0
  for (const [key, from, dir] of [["left", box.left, 1], ["right", box.right, -1]]) {
    let found = null
    for (let x = from; dir > 0 ? x <= centre : x >= centre; x += dir) if (topY[x] >= 0 && topY[x] <= level + 0.02 * H) { found = x; break }
    shoulder[key] = found == null ? null : { x: found, y: topY[found] }
  }
  const shoulderW = shoulder.left && shoulder.right ? shoulder.right.x - shoulder.left.x : null
  const shoulderRow = shoulder.left && shoulder.right ? Math.round((shoulder.left.y + shoulder.right.y) / 2) : Math.round(0.06 * H)
  // A sleeve hangs apart from the body when its run begins in the top half of the garment and goes on for
  // a sixth of its length at least (runs only at the bottom are cuffs peeping below a hem, not a sleeve).
  // (Nothing above the shoulders is a sleeve: a collar's or a band's halves either side of the neck opening.)
  const sideRows = [0, 2].map(g => { const rows = []; for (let y = shoulderRow; y < H; y++) if (!Number.isNaN(layout.sides[g][0][y])) rows.push(y); return rows })
  const sideApart = sideRows.map((rows, g) => {
    if (rows.length < 0.15 * H || rows[0] >= 0.5 * H) return false
    // A strap (a slip dress's) is a run too narrow to be a sleeve: under 7% of the garment's width at its top.
    const side = layout.sides[g * 2]
    const top = median(rows.slice(0, Math.max(1, Math.round(rows.length * 0.15))).map(y => side[1][y] - side[0][y]))
    return top != null && top >= 0.07 * W
  })
  const apart = sideApart[0] || sideApart[1]
  // Sleeveless: nothing hangs or lies outside the shoulders (straps or armholes), so the garment is no wider
  // below the shoulders than at them. (Sleeves hanging along the body make it wider there.)
  let widestTop = 0
  for (let y = shoulderRow; y < Math.min(H, shoulderRow + 0.35 * H); y++) widestTop = Math.max(widestTop, allW(y))
  const sleeveless = !apart && shoulderW != null && shoulderW >= 0.95 * widestTop
  // The body's hem: the last row whose body run is wider than a third of the shoulders (a dress narrows).
  const least = shoulderW ? 0.35 * shoulderW : 0.4 * W
  let hemRow = 0
  for (let y = 0; y < H; y++) if (bodyW(y) > least || (!apart && allW(y) > least)) hemRow = y
  // The underarm: the first row the sleeves hang apart from the body; the body's width there is half the
  // chest. On a sleeveless garment, its widest row in the top third.
  let underarmRow = null
  if (apart) underarmRow = Math.min(...sideRows.filter((rows, k) => sideApart[k]).map(rows => rows[0]))
  else if (sleeveless) { let most = 0; for (let y = shoulderRow; y < 0.35 * H; y++) if (allW(y) > most) { most = allW(y); underarmRow = y } }
  const widthAt = y => (apart ? bodyW(y) || (layout.extended[0] && layout.extended[2] ? layout.extended[2][y] - layout.extended[0][y] : 0) : allW(y))
  // (Read a little below the underarm itself, where the smoothed rows are clear of the sleeve's cap.)
  const underarmW = underarmRow != null ? median([4, 6, 8, 10, 12].map(k => widthAt(Math.min(H - 1, underarmRow + k))).filter(v => v > 0)) : null
  const bodyLength = hemRow - shoulderRow
  const at = share => { const y = Math.min(hemRow, Math.round(shoulderRow + share * bodyLength)); return widthAt(y) }
  // The waist: the narrowest body row between a third and two thirds of the way down.
  let waistW = Infinity
  for (let y = Math.round(shoulderRow + 0.3 * bodyLength); y <= shoulderRow + 0.7 * bodyLength; y++) { const v = widthAt(y); if (v > 0) waistW = Math.min(waistW, v) }
  if (!Number.isFinite(waistW)) waistW = null
  // The hem's width, a little above the hem itself (a shirt tail's lowest rows are its curve, a band's its band).
  const hemW = median([0.9, 0.92, 0.94, 0.96].map(at).filter(v => v > 0))
  const bandW = median([0, 1, 2, 3].map(k => widthAt(Math.max(0, hemRow - k))).filter(v => v > 0))
  // The hem's shape: curved when the middle hangs lower than the sides (a shirt's tail), by more than 2% of the length.
  const bodyLeft = num(layout.body[0][Math.max(0, hemRow - 3)]), bodyRight = num(layout.body[1][Math.max(0, hemRow - 3)])
  let hemShape = "straight"
  if (bodyLeft != null && bodyRight != null) {
    const mid = median([-2, -1, 0, 1, 2].map(k => bottomY[centre + k]).filter(v => v >= 0))
    const sides = median([0.1, 0.15, 0.2].flatMap(s => [bottomY[Math.round(bodyLeft + s * (bodyRight - bodyLeft))], bottomY[Math.round(bodyRight - s * (bodyRight - bodyLeft))]]).filter(v => v >= 0))
    if (mid != null && sides != null && mid - sides > 0.02 * H) hemShape = "curved"
  }
  // A band at the hem: a straight hem, and the last rows narrower than the rows above by an eighth or more.
  // A band at the hem can't be told from the hem's own rounding (and cuffs hanging below a hem); its absence
  // can: the last rows as wide as the hem above them. (false: plainly none; null: can't tell.)
  const hemBand = hemW == null || bandW == null ? null : bandW >= 0.96 * hemW ? false : null
  // The neck: the opening between the collar's or neckline's two sides at the top, as a gap in the rows
  // (background seen through it); its width at the top and how many rows it runs.
  const neck = neckOf(layout, H, W)
  // Each sleeve hanging apart: its length from the shoulder point down the middle of its run, its width at
  // the top and at the end, and a cuff band (the end narrower than the sleeve above it by a fifth).
  const sleeves = {}
  for (const [key, g, point, ok] of [["right", 0, shoulder.left, sideApart[0]], ["left", 2, shoulder.right, sideApart[1]]]) sleeves[key] = ok ? sleeveOf(layout, g, point, H, shoulderRow) : null
  let sleeveLength = median(Object.values(sleeves).map(s => s?.length).filter(v => v != null))
  // Sleeves lying along the body (a hanging shirt) or touching it (laid out at an angle): their ends are
  // the garment's outermost bottom corners, from the shoulder point to the corner.
  let sleeveEnds = null
  if (!apart && !sleeveless && shoulder.left && shoulder.right) {
    const corner = (from, dir) => { for (let x = from; dir > 0 ? x <= centre : x >= centre; x += dir) if (bottomY[x] >= 0) return { x, y: bottomY[x] }; return null }
    const l = corner(box.left, 1), r = corner(box.right, -1)
    const lengths = [[l, shoulder.left], [r, shoulder.right]].filter(([c]) => c).map(([c, p]) => Math.hypot(c.x - p.x, c.y - p.y))
    if (lengths.length) { sleeveLength = median(lengths); sleeveEnds = [l, r] }
  }
  const collar = collarOf({ topY, centre, H, shoulder, neck, box })
  return {
    H, W, apart, sleeveless, hung: Boolean(photo.hung), shoulderRow, underarmRow, hemRow, bodyLength,
    shoulderW, underarmW, waistW, hemW, chestW: at(0.25), hipW: at(0.75),
    hemShape, hemBand, neck, sleeves, sleeveLength, sleeveEnds, collar,
    hood: collar === "hood",
    shoulderPts: [shoulder.left, shoulder.right].filter(Boolean)
  }
}

function neckOf(layout, H, W) {
  // Rows at the top where the body is split by an opening (layoutPhoto's gap): its width at the top and how
  // many rows it runs.
  let depth = 0, width = null, top = null
  for (let y = 0; y < Math.min(H, Math.round(0.3 * H)); y++) {
    const a = layout.gap[0][y], b = layout.gap[1][y]
    if (!Number.isNaN(a) && b - a > 0.03 * W) { if (top == null) { top = y; width = b - a }; depth = y - top + 1; continue }
    if (top != null) break
  }
  return top == null ? null : { top, depth, width }
}

function sleeveOf(layout, g, point, H, from = 0) {
  const side = layout.sides[g]
  const rows = []
  for (let y = from; y < H; y++) if (!Number.isNaN(side[0][y])) rows.push(y)
  if (rows.length < 0.04 * H) return null
  const first = rows[0], last = rows[rows.length - 1]
  // Down the middle of the run, from the shoulder point (or the run's top) to its end.
  let length = 0
  let px = point ? point.x : (side[0][first] + side[1][first]) / 2, py = point ? point.y : first
  for (let y = first; y <= last; y += 2) {
    if (Number.isNaN(side[0][y])) continue
    const cx = (side[0][y] + side[1][y]) / 2
    length += Math.hypot(cx - px, y - py)
    px = cx; py = y
  }
  const widthOver = (from, to) => median(rows.filter(y => y >= from && y <= to).map(y => side[1][y] - side[0][y]))
  const span = last - first
  const top = widthOver(first, first + 0.15 * span), end = widthOver(last - 0.06 * span, last), above = widthOver(last - 0.3 * span, last - 0.12 * span)
  return { first, last, length, top, end, cuffBand: end != null && above != null && end < 0.8 * above }
}

// The collar, from the top edge between the shoulder points, as height above the shoulder line: "shirt"
// (two points standing up either side of a narrow lower middle), "open" (a neckline: the middle low over a
// wide stretch), "band" (a low rim, under 3% of the length), "stand" (a rim standing higher), "hood" (standing
// a fifth of the length or more), or null when it can't tell: a top edge cut level (a hanger's cut) hides
// the collar's shape unless it's low.
function collarOf({ topY, centre, H, shoulder, neck, box }) {
  if (!shoulder.left || !shoulder.right) return null
  const half = (shoulder.right.x - shoulder.left.x) / 2
  const shoulderY = (shoulder.left.y + shoulder.right.y) / 2
  const h = []   // [x offset from the centre as a share of the half shoulder width, height above the shoulder line in rows]
  for (let x = shoulder.left.x; x <= shoulder.right.x; x++) if (x >= box.left && x <= box.right && topY[x] >= 0) h.push([(x - centre) / half, shoulderY - topY[x]])
  if (h.length < 10) return null
  let rise = -Infinity
  for (const [, v] of h) if (v > rise) rise = v
  const middle = h.filter(([u]) => Math.abs(u) < 0.08).map(([, v]) => v)
  const hc = middle.length ? median(middle) : rise
  // How wide the low middle is.
  const lowZone = h.filter(([, v]) => v < 0.5 * rise).length / h.length
  const dip = rise > 0 ? hc / rise : 1
  if (typeof globalThis.__collarDebug === "function") globalThis.__collarDebug({ rise: rise / H, dip, lowZone }, h)
  if (rise >= 0.18 * H) return "hood"
  // A middle clearly lower than the highest point: collar points either side of a narrow opening (a shirt),
  // or a wide opening in a low rim (a band) or with no rim to speak of (an open neckline). A top edge as
  // high in the middle as anywhere says nothing: a hanger's cut, or a collar laid flat, looks like a band.
  if (dip < 0.5) {
    if (lowZone < 0.35) return "shirt"
    return rise < 0.045 * H ? "band" : "open"
  }
  return null
}

function median(values) {
  const v = values.filter(x => x != null && !Number.isNaN(x)).sort((a, b) => a - b)
  return v.length ? v[v.length >> 1] : null
}

// The chart's sizes moved to the photo. chart: { sizes: [{ name, chest, length, shoulders, sleeve, waist, ... }] };
// outline: measureOutline's; sample: the size photographed ({ chest, length }, photoSize). Returns
// { sizes, scale (cm per photo pixel), by ("chest" or "length": the yardstick), moved: [names of measurements
// changed] } or null when there's no yardstick. Each size moves by the same share as the sample, so the
// chart's grading is kept; a measurement the chart doesn't give takes the photo's, scaled by the size's chest.
export function fitChart(chart, outline, sample) {
  if (!outline || !sample?.chest || !chart?.sizes?.length) return null
  let scale = null, by = null
  if (outline.underarmW > 0 && (outline.apart || outline.sleeveless)) { scale = (sample.chest / 2) / outline.underarmW; by = "chest" }
  else if (sample.length > 0 && outline.bodyLength > 0) { scale = sample.length / outline.bodyLength; by = "length" }
  if (!scale) return null
  // The shoulders are read where the sleeves hang apart (the chest sets the scale) or the garment lies
  // flat; hung on a hanger, the shoulders droop and read narrow.
  const shoulders = outline.shoulderW > 0 && (by === "chest" || !outline.hung)
  const seen = {
    length: by !== "length" && outline.bodyLength > 0 ? outline.bodyLength * scale : null,
    shoulders: shoulders ? outline.shoulderW * scale : null,
    sleeve: outline.sleeveLength > 0 ? outline.sleeveLength * scale : null,
    // The hem round: the pattern's hem takes the chart's waist, never wider than the chest.
    waist: outline.hemW > 0 ? Math.min(outline.hemW * 2 * scale, sample.chest) : null
  }
  const moved = new Set()
  const sizes = chart.sizes.map(size => {
    if (!(size.chest > 0)) return size
    const grade = size.chest / sample.chest
    const out = { ...size }
    for (const key of Object.keys(seen)) {
      const want = seen[key]
      if (want == null) continue
      const have = size[key]
      let value
      if (have > 0) {
        // The sample's own value is the reference; every size moves by the sample's share.
        const sampleHave = sampleValue(chart.sizes, sample, key) ?? have
        const ratio = Math.min(1 + MOVE[key], Math.max(1 - MOVE[key], want / sampleHave))
        value = Math.round(have * ratio * 10) / 10
      } else value = Math.round(want * grade * 10) / 10
      if (value !== have) { out[key] = value; moved.add(key) }
    }
    // What the chart never gives: the pattern's own proportions, from the photo, graded by the chest.
    const photo = {}
    if (outline.neck?.width > 0) photo.neckWidth = (outline.neck.width * scale * grade) / 2
    if (outline.neck?.depth > 0) photo.neckDepth = outline.neck.depth * scale * grade
    if (outline.apart && outline.underarmRow != null && outline.shoulderRow != null) photo.armhole = (outline.underarmRow - outline.shoulderRow) * scale * grade + 4.4
    const tops = Object.values(outline.sleeves).map(s => s?.top).filter(v => v > 0)
    const ends = Object.values(outline.sleeves).map(s => s?.end).filter(v => v > 0)
    if (tops.length) photo.bicep = median(tops) * 2 * scale * grade
    if (ends.length) photo.opening = median(ends) * 2 * scale * grade
    if (Object.keys(photo).length) out.photo = photo
    return out
  })
  return { sizes, scale, by, moved: [...moved] }
}

function sampleValue(sizes, sample, key) {
  const size = sizes.find(s => s.chest === sample.chest && s[key] > 0) ?? sizes.find(s => s[key] > 0)
  return size ? size[key] : null
}

// What the outline says of the garment's make, as a patch for its cut: the collar ("shirt", "band", "stand",
// "open" = none, "hood"), the sleeves ("short", "three-quarter", "long", "sleeveless"), a hood, bands at the
// cuffs and the hem, a curved hem. Only what it can tell; sleeve length in cm needs the scale (fitChart's).
export function constructionFrom(outline, scale = null) {
  if (!outline) return {}
  const out = {}
  if (outline.collar) out.collar = outline.collar
  if (outline.hood) out.hood = true
  if (outline.sleeveless) out.sleeves = "sleeveless"
  else if (scale && outline.sleeveLength > 0) {
    // Measured to the sleeve's outer corner when it hangs along the body, which adds a little.
    const cm = outline.sleeveLength * scale
    out.sleeves = cm < 38 ? "short" : cm < 52 ? "three-quarter" : "long"
  }
  const cuffs = Object.values(outline.sleeves).filter(Boolean)
  if (cuffs.length) out.cuffBand = cuffs.filter(s => s.cuffBand).length > cuffs.length / 2
  if (outline.hemBand != null) out.hemBand = outline.hemBand
  out.hemShape = outline.hemShape
  return out
}

// A dress's sleeves from its photo's outline alone, with no chart to scale by. A dress without sleeves is
// widest at its hem or hips (straps, a cap or a cowl at the top read as a short "sleeve" to the outline, so the
// outline never says short); long sleeves hanging beside it make it wider at the chest than at the hem, and
// run most of its length. "long", or null when the outline can't tell.
export function dressSleeves(outline) {
  if (!outline || outline.sleeveless) return null
  if (!(outline.sleeveLength > 0) || !(outline.bodyLength > 0) || !(outline.chestW > 0) || !(outline.hemW > 0)) return null
  return outline.sleeveLength / outline.bodyLength > 0.45 && outline.chestW > 1.1 * outline.hemW ? "long" : null
}
