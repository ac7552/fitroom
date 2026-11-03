// The accuracy checks (development only): for each garment a run puts on, what can be told automatically of
// how true it is to its shop photos, beside the hand labels of what each listing is (accuracy.json). Served
// with the runner from public/validation/; runner.js's check() calls accuracyOf for each garment.
//
//   construction  sleeves, hood, collar, closure and one-piece as drafted, against the labels
//   silhouette    the hanging simulation's outline against the photo's cloth mask (IoU, both fitted to
//                 their box): how close the garment's shape is to the photo's, at any size
//   foreign       the share of cloth points whose place in the photo was skin, hair or backdrop (before the
//                 guard moved them: stage.js's d.foreign)
//   pieces        pattern pieces left with no photo on them (a band, a cuff, a hood) while the photo is on
//
// A check passes at: construction all fields equal; silhouette 0.9 or more; foreign under 1%; pieces none.
const SLOT = { top: "top", jacket: "outer", coat: "outer", trousers: "bottom" }

export const PASS = { silhouette: 0.9, foreign: 0.01 }

// What the drafted pattern is, in the labels' terms.
export function drafted(d) {
  const pattern = d.top.pattern, panels = Object.keys(pattern.panels)
  const sleeved = panels.some(p => /^sleeve_/.test(p))
  const sleeve = pattern.measures?.sleeve ?? null
  const collarSeen = d.top.item.cut?.photo?.collar
  const shirtish = ["shirt", "shortshirt", "polo", "rugby"].includes(d.top.item.style) || Boolean(d.top.item.cut?.collar)
  return {
    sleeves: !sleeved ? "none" : sleeve != null && sleeve < 35 ? "short" : "long",
    hood: panels.some(p => /^hood_/.test(p)),
    collar: (collarSeen ? collarSeen === "shirt" : shirtish) ? "shirt" : panels.includes("collar") ? "band" : "none",
    closure: pattern.closure ?? "pullover",
    onePiece: false
  }
}

// How much of the hanging outline overlaps the photo's cloth mask, both drawn in their bounding box on a
// 64 by 96 grid (IoU, 0 to 1). hanging: the hanging positions by simulated point; photo: { mask, box }.
export function silhouette(d, photo, grid = [64, 96]) {
  const x = d.hanging
  if (!x || !photo?.mask) return null
  const [GW, GH] = grid
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity
  for (let j = 0; j < x.length; j += 3) { minx = Math.min(minx, x[j]); maxx = Math.max(maxx, x[j]); miny = Math.min(miny, x[j + 1]); maxy = Math.max(maxy, x[j + 1]) }
  const canvas = document.createElement("canvas")
  canvas.width = GW; canvas.height = GH
  const g = canvas.getContext("2d", { willReadFrequently: true })
  g.fillStyle = "#000"; g.fillRect(0, 0, GW, GH); g.fillStyle = "#fff"
  const map = d.top.drape.map
  const px = v => ((v - minx) / (maxx - minx)) * (GW - 1), py = v => ((maxy - v) / (maxy - miny)) * (GH - 1)
  for (const [a, b, c] of d.top.cloth.triangles) {
    const A = map[a], B = map[b], C = map[c]
    g.beginPath(); g.moveTo(px(x[3 * A]), py(x[3 * A + 1])); g.lineTo(px(x[3 * B]), py(x[3 * B + 1])); g.lineTo(px(x[3 * C]), py(x[3 * C + 1])); g.fill()
  }
  const sim = g.getImageData(0, 0, GW, GH).data
  const { mask, box } = photo
  let both = 0, either = 0
  for (let r = 0; r < GH; r++) for (let q = 0; q < GW; q++) {
    const X = Math.round(box.left + (q / (GW - 1)) * (box.right - box.left)), Y = Math.round(box.top + (r / (GH - 1)) * (box.bottom - box.top))
    const a = sim[4 * (r * GW + q)] > 128, b = Boolean(mask[Y * box.w + X])
    if (a && b) both++
    if (a || b) either++
  }
  return either ? Math.round((both / either) * 1000) / 1000 : null
}

// Pattern pieces with no point on a photo while the photo's on (aPhoto's third value 0 on every point).
export function bare(d) {
  if (!d.redrape) return []
  const { cloth } = d.top, uv = d.redrape.uv
  const seen = new Set()
  for (let i = 0; i < cloth.points.length; i++) if (uv[3 * i + 2] > 0) seen.add(cloth.panel[i])
  return cloth.panels.filter((_, p) => !seen.has(p))
}

// The checks for one garment. stage: the page's FittingStage; kind: the outfit's kind; label: its entry in
// accuracy.json (or null).
export function accuracyOf(stage, kind, label) {
  const d = stage.slots[SLOT[kind]]
  if (!d?.top) return { error: "not draped" }
  const out = { redrape: d.redrapeState ?? null }
  const made = drafted(d)
  out.drafted = made
  if (label) {
    const wrong = Object.keys(made).filter(k => k in label && label[k] !== made[k])
    out.construction = { ok: wrong.length === 0, wrong }
  }
  const front = d.redrapePhotos?.front
  out.silhouette = front ? silhouette(d, front) : null
  out.foreign = d.redrape ? Math.round(((d.foreign ?? 0) / d.top.cloth.points.length) * 1000) / 1000 : null
  out.bare = bare(d)
  out.pass = {
    construction: out.construction ? out.construction.ok : null,
    silhouette: out.silhouette == null ? null : out.silhouette >= PASS.silhouette,
    foreign: out.foreign == null ? null : out.foreign < PASS.foreign,
    pieces: d.redrape ? out.bare.length === 0 : null
  }
  return out
}

// The score of a set of results (VAL.results): the share of checks passed, over the checks that could be made.
export function score(results) {
  let passed = 0, made = 0
  const by = {}
  for (const run of Object.values(results)) for (const item of run.items ?? []) for (const [name, ok] of Object.entries(item.accuracy?.pass ?? {})) {
    if (ok == null) continue
    made++; if (ok) passed++
    by[name] ??= { passed: 0, made: 0 }
    by[name].made++; if (ok) by[name].passed++
  }
  return { share: made ? Math.round((passed / made) * 1000) / 1000 : null, passed, made, by }
}
