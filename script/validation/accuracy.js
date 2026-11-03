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
//   appearance    what each piece shows, read off the cloth's own texture (where its points land in the
//                 photos, after every correction), against what the photos show of the garment: a sleeve or
//                 hood in the garment's colour (not a lining, lettering or skin), the back as plain as the
//                 back photo (or plain, when there's none and the front has a chest graphic), the front's
//                 graphic about as much of the front as it is of the photo's
//
// A check passes at: construction all fields equal; silhouette 0.9 or more; foreign under 1%; pieces none;
// appearance no piece wrong.
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
    // A romper or jumpsuit comes as a top and shorts or pants, each with its half of the photo.
    onePiece: Boolean(d.top.photos?.part || d.top.item.photoPart || d.top.item.one_piece)
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

// What each piece shows: the share of its points whose colour in the photo is off the garment's cloth colour
// (FAR away), and its middle colour; and what the photos show (the share of the photo's cloth off its
// colour, front and back). { pieces: { name: { far, rgb } }, photo: { front, back }, wrong: [{ piece, why }] }.
const FAR = 70
function clothShare(photo) {
  const W = photo.canvas.width, H = photo.canvas.height
  const d = photo.canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, W, H).data
  let n = 0, far = 0
  for (let y = photo.box.top; y <= photo.box.bottom; y += 4) for (let x = photo.box.left; x <= photo.box.right; x += 4) {
    const k = y * W + x
    if (!photo.mask[k]) continue
    n++
    if (Math.hypot(d[4 * k] - photo.cloth[0], d[4 * k + 1] - photo.cloth[1], d[4 * k + 2] - photo.cloth[2]) > FAR) far++
  }
  return n ? far / n : null
}
export function appearance(d) {
  const photos = d.redrapePhotos, uv = d.redrape?.uv
  if (!photos?.front?.cloth || !uv) return null
  const { cloth } = d.top
  const pixels = new Map()
  const at = (photo, i) => {
    if (!pixels.has(photo)) pixels.set(photo, photo.canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, photo.canvas.width, photo.canvas.height).data)
    const w = photo.canvas.width, h = photo.canvas.height, D = pixels.get(photo)
    const x = Math.min(w - 1, Math.max(0, Math.round(uv[3 * i] * w))), y = Math.min(h - 1, Math.max(0, Math.round((1 - uv[3 * i + 1]) * h)))
    const k = 4 * (y * w + x)
    return [D[k], D[k + 1], D[k + 2]]
  }
  const acc = cloth.panels.map(() => ({ n: 0, far: 0, sum: [0, 0, 0] }))
  const ref = photos.front.cloth
  for (let i = 0; i < cloth.points.length; i++) {
    const z = uv[3 * i + 2]
    if (!(z > 0)) continue
    const c = at(z === 3 && photos.back ? photos.back : photos.front, i)
    const a = acc[cloth.panel[i]]
    a.n++; for (let k = 0; k < 3; k++) a.sum[k] += c[k]
    if (Math.hypot(c[0] - ref[0], c[1] - ref[1], c[2] - ref[2]) > FAR) a.far++
  }
  const pieces = Object.fromEntries(cloth.panels.map((name, p) => [name, acc[p].n ? { far: Math.round((acc[p].far / acc[p].n) * 100) / 100, rgb: acc[p].sum.map(v => Math.round(v / acc[p].n)) } : null]))
  const photo = { front: clothShare(photos.front), back: photos.back ? clothShare(photos.back) : null }
  const wrong = []
  // (A print all over is on the sleeves too: they're held to the front's share, not to plain.)
  const allOver = d.trust?.allOver ?? false
  for (const [name, piece] of Object.entries(pieces)) {
    if (!piece) continue
    const limit = allOver ? (photo.front ?? 0) + 0.2 : 0.25
    if (/^(sleeve|hood)/.test(name) && piece.far > limit) wrong.push({ piece: name, why: `${Math.round(piece.far * 100)}% off the garment's colour` })
  }
  const back = pieces.back
  if (back) {
    // As plain as the back photo, or plain when there's none and the front's graphic is a placed one.
    const allowed = photo.back != null ? photo.back + 0.1 : photo.front != null && photo.front < 0.7 ? 0.08 : 1
    if (back.far > allowed) wrong.push({ piece: "back", why: `${Math.round(back.far * 100)}% graphic where the photo has ${Math.round((photo.back ?? 0) * 100)}%` })
  }
  const front = pieces.front ?? pieces.front_L
  if (front && photo.front != null && photo.front > 0.05) {
    const ratio = front.far / photo.front
    if (ratio < 0.6 || ratio > 1.6) wrong.push({ piece: "front", why: `graphic ${Math.round(front.far * 100)}% of the front, ${Math.round(photo.front * 100)}% of the photo's` })
  }
  return { pieces, photo, wrong }
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
  out.plain = d.trust?.plain ?? []
  out.trust = d.trust ? { far: d.trust.far, front: d.trust.front, back: d.trust.back, allOver: d.trust.allOver } : null
  out.appearance = d.redrape ? appearance(d) : null
  // The listing's own notes (accuracy.json "expect"), checked by what the appearance read.
  if (out.appearance && label?.expect) for (const [what, value] of Object.entries(label.expect)) {
    // Plain: no busier than the back photo's own cloth (a heather's flecks count), or near nothing without one.
    const plainAs = (out.appearance.photo.back ?? 0) + 0.08
    if (what === "backPlain" && value && (out.appearance.pieces.back?.far ?? 0) > plainAs) out.appearance.wrong.push({ piece: "back", why: "the back should be plain" })
  }
  out.pass = {
    construction: out.construction ? out.construction.ok : null,
    silhouette: out.silhouette == null ? null : out.silhouette >= PASS.silhouette,
    foreign: out.foreign == null ? null : out.foreign < PASS.foreign,
    // A piece left with no photo while the photo's on, unless it was made plain on purpose (trustPieces).
    pieces: d.redrape ? out.bare.every(name => out.plain.includes(name)) : null,
    appearance: out.appearance ? out.appearance.wrong.length === 0 : null
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
