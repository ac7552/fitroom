// The drape bank: garments draped once, kept, and used to start the next one of the same kind. A drape depends
// on the pattern's style (a crewneck, jeans, a slip dress), the garment's measurements and the body; not on
// the shop link. So a crewneck in a size near one already draped starts from that drape, settled on the
// body (a few frames to fit its own measurements), instead of being sewn and let fall from scratch (seconds).
//
// An entry (see exportEntry) keeps, for each point of the draped cloth, where it was on its pattern (panel and
// place on it, 0 to 1 across and down) and where it ended up, in the body's bind space through the bones it
// follows (restBind and skin weights, as stage.js's reposeDraped works them out), so it goes on another
// body of the same type through its skeleton. The new garment's points take the bind position of the nearest
// stored points on the same panel (warmStart), and the drape carries on from there.
//
// Entries are JSON files under public/drapes/, listed in public/drapes/index.json (writeIndex says how).
// The bank is for speed only: a garment with no entry near it drapes as before.

// How far a bank entry's measurements may be from the garment's (a share) and still start it.
const NEAR = 0.2
// The nearest stored points a new point takes its start from.
const K = 3

export class DrapeBank {
  constructor(base = "/drapes") {
    this.base = base
    this.index = null
    this.entries = new Map()
    this.loading = fetch(`${base}/index.json`, { cache: "no-cache" }).then(r => (r.ok ? r.json() : [])).then(list => { this.index = list }).catch(() => { this.index = [] })
  }

  // The best entry for a drafted garment on a body type, or null: the same pattern style and panels, the
  // same body type, its measurements within NEAR of the garment's (the nearest wins).
  async pick(top, bodyType) {
    await this.loading
    if (!this.index?.length) return null
    const want = signature(top)
    let best = null, bestFar = Infinity
    for (const meta of this.index) {
      if (meta.style !== want.style || meta.bodyType !== bodyType || meta.panels !== want.panels) continue
      const far = distance(meta.measures, want.measures)
      if (far == null || far > NEAR || far >= bestFar) continue
      best = meta; bestFar = far
    }
    if (!best) return null
    if (!this.entries.has(best.file)) {
      this.entries.set(best.file, fetch(`${this.base}/${best.file}`, { cache: "force-cache" }).then(r => (r.ok ? r.json() : null)).catch(() => null))
    }
    const entry = await this.entries.get(best.file)
    return entry ? { entry, far: bestFar } : null
  }
}

// What a drape depends on: the pattern's style and panels, and the measurements that size it.
export function signature(top) {
  const m = top.pattern.measures
  const measures = {}
  for (const key of ["chest", "waist", "hips", "length", "sleeve", "shoulders", "inseam", "rise", "thigh", "hem", "opening"]) if (Number.isFinite(m[key])) measures[key] = m[key]
  return { style: top.pattern.style, panels: Object.keys(top.pattern.panels).sort().join(","), measures }
}

// How far apart two sets of measurements are: the largest share any shared one differs by (null with none).
function distance(a, b) {
  let most = null
  for (const key of Object.keys(a)) {
    if (!Number.isFinite(b[key])) continue
    const far = Math.abs(a[key] - b[key]) / Math.max(1, Math.abs(a[key]))
    most = most == null ? far : Math.max(most, far)
  }
  return most
}

// Each simulated point's place on its pattern: [panel index, u (0 to 1 across the panel's box), v (down it)].
// After the seams are closed, a point on a seam belongs to two panels; it takes the first.
function placesOf(top) {
  const { cloth, pattern, drape } = top
  const names = cloth.panels
  const boxes = names.map(name => {
    const pts = pattern.panels[name].edges.flatMap(e => e.points)
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs) || 1, Math.max(...ys) - Math.min(...ys) || 1]
  })
  const m = drape.x.length / 3
  const places = new Array(m)
  for (let i = 0; i < cloth.points.length; i++) {
    const j = drape.map ? drape.map[i] : i
    if (places[j]) continue
    const p = cloth.panel[i], [x, y] = cloth.points[i], [x0, y0, w, h] = boxes[p]
    places[j] = [p, (x - x0) / w, (y - y0) / h]
  }
  return { places, names }
}

// A draped, posed garment as a bank entry (plain JSON). d: the stage's slot record (restBind and weights set).
export function exportEntry(d, bodyType) {
  const top = d.top
  const { places, names } = placesOf(top)
  const sig = signature(top)
  const round = (v, k = 4) => Math.round(v * 10 ** k) / 10 ** k
  return {
    version: 1, style: sig.style, bodyType, panels: sig.panels, measures: sig.measures, panelNames: names,
    item: { name: top.item.name, kind: top.item.kind, style: top.item.style, fabric: top.item.fabric },
    places: places.map(([p, u, v]) => [p, round(u), round(v)]),
    restBind: Array.from(d.restBind, v => round(v, 5)),
    skinIndex: Array.from(d.weights.skinIndex),
    skinWeight: Array.from(d.weights.skinWeight, v => round(v, 3))
  }
}

// A new garment started from an entry: for each of its simulated points, the bind-space position and skin
// weights of the K nearest stored points on the same panel (the position their average, the weights the
// nearest's). Returns { restBind, weights: { skinIndex, skinWeight } } for the garment's points, or null when
// the entry's panels don't match.
export function warmStart(entry, top) {
  const { places, names } = placesOf(top)
  if (names.join(",") !== entry.panelNames.join(",")) return null
  // The stored points by panel, in a coarse grid over (u, v) for the search.
  const byPanel = names.map(() => new Map())
  const cell = 0.05
  const keyOf = (u, v) => `${Math.floor(u / cell)},${Math.floor(v / cell)}`
  entry.places.forEach(([p, u, v], j) => {
    const grid = byPanel[p]
    const key = keyOf(u, v)
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key).push(j)
  })
  const m = places.length
  const restBind = new Float32Array(3 * m)
  const skinIndex = new Uint16Array(4 * m), skinWeight = new Float32Array(4 * m)
  const near = new Array(K)
  for (let i = 0; i < m; i++) {
    const [p, u, v] = places[i]
    const grid = byPanel[p]
    // The nearest K, looking outwards from the point's cell until K are found (or the grid runs out).
    let found = 0
    for (let ring = 0; ring <= 1 / cell && found < K; ring++) {
      const cu = Math.floor(u / cell), cv = Math.floor(v / cell)
      const candidates = []
      for (let du = -ring; du <= ring; du++) for (let dv = -ring; dv <= ring; dv++) {
        if (Math.max(Math.abs(du), Math.abs(dv)) !== ring) continue
        for (const j of grid.get(`${cu + du},${cv + dv}`) ?? []) candidates.push(j)
      }
      if (!candidates.length) continue
      const all = []
      for (let k = 0; k < found; k++) all.push(near[k])
      for (const j of candidates) all.push({ j, d: Math.hypot(entry.places[j][1] - u, entry.places[j][2] - v) })
      all.sort((a, b) => a.d - b.d)
      found = Math.min(K, all.length)
      for (let k = 0; k < found; k++) near[k] = all[k]
      // Everything within this ring is nearer than anything further out only once a full ring past the
      // nearest has been searched: one more ring after K are found.
      if (found >= K && ring > 0) break
    }
    if (!found) return null
    let wsum = 0
    for (let k = 0; k < found; k++) {
      const w = 1 / (near[k].d + 1e-3)
      wsum += w
      const j = near[k].j
      restBind[3 * i] += w * entry.restBind[3 * j]; restBind[3 * i + 1] += w * entry.restBind[3 * j + 1]; restBind[3 * i + 2] += w * entry.restBind[3 * j + 2]
    }
    restBind[3 * i] /= wsum; restBind[3 * i + 1] /= wsum; restBind[3 * i + 2] /= wsum
    const j = near[0].j
    for (let k = 0; k < 4; k++) { skinIndex[4 * i + k] = entry.skinIndex[4 * j + k]; skinWeight[4 * i + k] = entry.skinWeight[4 * j + k] }
  }
  return { restBind, weights: { skinIndex, skinWeight } }
}

// Bind-space points into world space through bone matrices (as skinPoints does with a mesh's skeleton):
// skin is the list of Matrix4 (bone world × bone inverse × bind) from stage.js's restSnapshot.
export function skinWith(points, skinIndex, skinWeight, skin) {
  const n = points.length / 3
  const out = new Float32Array(points.length)
  for (let i = 0; i < n; i++) {
    const x = points[3 * i], y = points[3 * i + 1], z = points[3 * i + 2]
    let ox = 0, oy = 0, oz = 0
    for (let k = 0; k < 4; k++) {
      const w = skinWeight[4 * i + k]
      if (!w) continue
      const m = skin[skinIndex[4 * i + k]].elements
      ox += w * (m[0] * x + m[4] * y + m[8] * z + m[12])
      oy += w * (m[1] * x + m[5] * y + m[9] * z + m[13])
      oz += w * (m[2] * x + m[6] * y + m[10] * z + m[14])
    }
    out[3 * i] = ox; out[3 * i + 1] = oy; out[3 * i + 2] = oz
  }
  return out
}

// The index entry for a bank file, from the entry itself.
export function indexEntry(entry, file) {
  return { file, style: entry.style, bodyType: entry.bodyType, panels: entry.panels, measures: entry.measures, name: entry.item?.name }
}
