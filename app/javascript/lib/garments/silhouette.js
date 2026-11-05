// How well a simulated garment's outline matches its shop photo: the garment's points (as the photo would see
// them: x across, y up) drawn filled on a grid in their bounding box, the photo's cloth mask read on the same
// grid in its own bounding box, and the share of the two that overlaps (intersection over union, 0 to 1). As
// the validation's silhouette check measures it (script/validation/accuracy.js), with no canvas, so a worker
// or Node can score it too.
//
// The hanging shape is what the shop's photos are laid onto the cloth by (redrape.js's registerPhoto): the
// better its outline matches the photo's, the closer each point of the cloth lands to its own place in the
// photo. HangTrial (below) hangs a garment several ways and keeps the one that matches best.

// positions: Float32Array of points (3 a point); triangles: [[a, b, c]] pattern points; map: each pattern
// point's simulated point (or null); photo: { mask (Uint8Array w × h), box: { left, right, top, bottom, w } }.
export function outlineIoU(positions, triangles, map, photo, [GW, GH] = [64, 96]) {
  if (!positions?.length || !photo?.mask) return null
  const x = positions
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity
  for (let j = 0; j < x.length; j += 3) {
    if (x[j] < minx) minx = x[j]; if (x[j] > maxx) maxx = x[j]
    if (x[j + 1] < miny) miny = x[j + 1]; if (x[j + 1] > maxy) maxy = x[j + 1]
  }
  if (!(maxx > minx && maxy > miny)) return null
  const sim = new Uint8Array(GW * GH)
  const px = v => ((v - minx) / (maxx - minx)) * (GW - 1), py = v => ((maxy - v) / (maxy - miny)) * (GH - 1)
  for (const [a, b, c] of triangles) {
    const A = map ? map[a] : a, B = map ? map[b] : b, C = map ? map[c] : c
    fillTriangle(sim, GW, GH, px(x[3 * A]), py(x[3 * A + 1]), px(x[3 * B]), py(x[3 * B + 1]), px(x[3 * C]), py(x[3 * C + 1]))
  }
  const { mask, box } = photo
  let both = 0, either = 0
  for (let r = 0; r < GH; r++) for (let q = 0; q < GW; q++) {
    const X = Math.round(box.left + (q / (GW - 1)) * (box.right - box.left)), Y = Math.round(box.top + (r / (GH - 1)) * (box.bottom - box.top))
    const s = sim[r * GW + q] === 1, p = Boolean(mask[Y * box.w + X])
    if (s && p) both++
    if (s || p) either++
  }
  return either ? both / either : null
}

// A triangle filled into a grid: every cell whose centre is inside it (as a canvas's fill, read at half
// coverage, is).
function fillTriangle(grid, W, H, ax, ay, bx, by, cx, cy) {
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)))
  const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)))
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
  if (Math.abs(area) < 1e-9) return
  const s = Math.sign(area)
  const edges = [[ax, ay, bx, by], [bx, by, cx, cy], [cx, cy, ax, ay]].map(([x1e, y1e, x2e, y2e]) => {
    const ex = x2e - x1e, ey = y2e - y1e, len = Math.hypot(ex, ey) || 1
    return [x1e, y1e, ex, ey, 1e-9 * len]
  })
  for (let y = y0; y <= y1; y++) for (let xx = x0; xx <= x1; xx++) {
    let inside = true
    for (const [ex0, ey0, ex, ey, slack] of edges) {
      if (s * (ex * (y - ey0) - ey * (xx - ex0)) < -slack) { inside = false; break }
    }
    if (inside) grid[y * W + xx] = 1
  }
}

// The ways a top is tried, hung up or laid out (hanger.js's flat: the sleeves' angle below level, radians):
// a shop photographs a tee laid out with its sleeves a little down, a hoodie with them down along its sides,
// a shirt on a hanger.
export const TRIALS = [null, { angle: 0.4 }, { angle: 0.9 }, { angle: 1.3 }]

// ?hangtrial=off hangs it the one way, as before.
export const TRIAL_ON = typeof location === "undefined" || new URLSearchParams(location.search).get("hangtrial") !== "off"

// Several hangings of one garment (each an object with advance(budget), done and positions: a HangerDrape or
// the worker's), run in turn; once all are done, the one whose outline best matches the photo is `positions`.
// tries: [{ flat, hanger }]; photo: the front photo ({ mask, box }); top: the garment (its cloth and drape).
export class HangTrial {
  constructor(tries, top, photo) {
    this.tries = tries
    this.top = top
    this.photo = photo
    this.scores = null
    this.best = null
  }

  get done() { return this.best !== null || this.tries.every(t => t.hanger.done) && this.pick() }

  advance(budget) {
    const running = this.tries.find(t => !t.hanger.done)
    if (running) { running.hanger.advance(budget); return true }
    this.pick()
    return false
  }

  // The best match (a garment the photo shows no outline for keeps the first, hung up as before).
  pick() {
    if (this.best) return true
    const { cloth, drape } = this.top
    this.scores = this.tries.map(t => ({ flat: t.flat, iou: t.hanger.positions ? outlineIoU(t.hanger.positions, cloth.triangles, drape.map, this.photo) : null }))
    let at = 0
    this.scores.forEach((s, k) => { if (s.iou != null && (this.scores[at].iou == null || s.iou > this.scores[at].iou + 0.005)) at = k })
    this.best = this.tries[at]
    this.chosen = this.scores[at]
    return true
  }

  get positions() { return this.best ? this.best.hanger.positions : this.tries[0].hanger.positions }
}
