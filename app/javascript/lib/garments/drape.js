// Cloth simulation: sews the placed pattern pieces together and lets the garment settle on the body under
// gravity, the way garment tools drape a pattern on an avatar. Position-based dynamics (XPBD): every frame is
// split into small steps; in each, the cloth moves, then each constraint (its threads can't stretch much, it
// bends only so easily, seams pull together) nudges the points back, and any point inside the skin is pushed
// out onto it. Pure JavaScript over typed arrays, so it runs in a Web Worker or in Node.
import { SkinField } from "lib/garments/body"

// How each kind of cloth behaves: compliance to stretching and to bending (higher is softer), how heavily
// it's damped, and how far it sits off the skin (m).
export const CLOTHS = {
  jersey: { stretch: 2e-7, bend: 2e-4, drag: 1.2, thickness: 0.0035 },
  rib: { stretch: 1.2e-6, bend: 3e-4, drag: 1.2, thickness: 0.0035 },
  fleece: { stretch: 1.5e-7, bend: 1e-4, drag: 1.4, thickness: 0.005 },
  twill: { stretch: 2e-8, bend: 4e-5, drag: 1.4, thickness: 0.004 },
  shell: { stretch: 2e-8, bend: 6e-5, drag: 1.5, thickness: 0.004 },
  wool: { stretch: 3e-8, bend: 2.5e-5, drag: 1.6, thickness: 0.005 },
  // Jeans: stiff, heavy cotton that keeps its shape down the leg.
  denim: { stretch: 1.5e-8, bend: 1.6e-5, drag: 1.6, thickness: 0.005 },
  // Linen: crisp, a little stiffer than cotton twill, so a leg falls straight instead of crumpling.
  linen: { stretch: 2e-8, bend: 2e-5, drag: 1.5, thickness: 0.0045 },
  // Dresses: stretch cloth gives a lot (so a dress cut smaller than the body clings), leather is stiff and
  // heavy-looking, silk and chiffon light and soft.
  stretch: { stretch: 9e-7, bend: 1.5e-4, drag: 1.2, thickness: 0.003 },
  leather: { stretch: 1e-8, bend: 1.2e-5, drag: 1.7, thickness: 0.005 },
  silk: { stretch: 3e-8, bend: 5e-4, drag: 1.0, thickness: 0.0025 }
}

// Hems (and the rims of bands and hoods) are turned up and stitched: two layers, so that strip is heavier
// and much stiffer to bend, which keeps it hanging in a smooth line.
const HEM_DEPTH = 2.2      // cm
const HEM_BEND = 0.08      // its bending compliance, as a share of the cloth's
const HEM_WEIGHT = 1.6     // its mass, as a share of the cloth's

const FRAME = 1 / 60
const SUBSTEPS = 10
const GRAVITY = -9.81
const MAX_SEW_STEP = 0.0025   // metres a seam closes in one small step, at most

export class Drape {
  // cloth: from cloth.js; start: Float32Array placed positions (place.js); body: { positions, normals, index }
  // of the posed skin (and its SkinField as `field`, if it's already been made).
  // options: fabric (a CLOTHS name), friction (how much of its sideways movement cloth touching the skin
  // keeps each small step), selfRadius (how close two folds of cloth can come, m; 0 to let them pass), and
  // envelope: { table (body.js's torso table), top, bottom (heights) }: between them, cloth also stays
  // outside the slices' convex outline, so it hangs round the hips and legs instead of folding in between.
  // attach: placeCloth's band attachments; while they're held (see holdBands), bands ride on the edges they're
  // sewn to and only the body's own seams are sewn.
  // floor: a height cloth can't fall below (pants longer than the leg pile up there), or null.
  // ring: { points (cloth point indices round a waist) }: a waistband, which holds the garment up (see
  // holdRing).
  // feet: bodyFrame's feet, for pants: each leg's cloth stays outside its own foot's outline (see stayOffFeet).
  // snug: how far round (m) a pant leg's hem can stretch, for stayOffFeet: a cuff smaller than the foot stays
  // above the ankle instead of being pulled down over it.
  // tuck: { table (body.js's torso table), top (a height), raise (m higher at the middle of the back), inside
  // (m) }: a top tucked into pants. Below `top` its body pieces stay within `inside` of the body's convex
  // outline, gathered as a waistband holds them.
  // hemStrip: false keeps a hem's edge in a smooth line without stiffening the strip above it. Round a pant
  // leg, a stiff, heavy strip hinged on softer cloth rolls outwards like a turned-up cuff.
  constructor(cloth, start, body, { fabric = "jersey", friction = 0.7, selfRadius = 0.006, envelope = null, attach = null, floor = null, ring = null, feet = null, snug = null, tuck = null, hemStrip = true } = {}) {
    this.hemStrip = hemStrip
    this.snug = snug
    this.tuck = tuck
    // The pieces a tuck gathers: the body's own, not the sleeves (in some poses the hands hang lower).
    this.tucks = Uint8Array.from(cloth.panel, p => (/^(front|back|waistband)/.test(cloth.panels[p]) ? 1 : 0))
    this.envelope = envelope
    this.feet = feet
    // Which leg each pattern point is on: 1 the left, -1 the right, 0 neither.
    this.legSide = Int8Array.from(cloth.panel, p => { const name = cloth.panels[p]; return /_L$/.test(name) ? 1 : /_R$/.test(name) ? -1 : 0 })
    this.hangs = Boolean(envelope)   // hangs round both legs (a skirt, a dress), in any pose
    this.floor = floor
    this.ring = ring && ring.points.length >= 8 ? { ...ring, order: ringOrder(ring.points, start) } : null
    this.friction = friction
    this.selfRadius = selfRadius
    this.cloth = cloth
    this.n = cloth.points.length
    this.x = Float32Array.from(start)
    this.p = new Float32Array(3 * this.n)
    this.v = new Float32Array(3 * this.n)
    this.isHem = Uint8Array.from(cloth.toHem ?? cloth.toFree ?? [], d => (d <= HEM_DEPTH ? 1 : 0))
    this.w = Float32Array.from({ length: this.n }, (_, i) => (this.isHem[i] ? 1 / HEM_WEIGHT : 1))
    this.params = { ...(CLOTHS[fabric] ?? CLOTHS.jersey) }
    this.field = body.field ?? new SkinField(body.positions, body.normals, body.index)
    this.frame = 0
    this.sewn = false
    // Which pattern points are rib (cuffs, collars, waistbands): it stretches far more easily.
    this.isRib = Uint8Array.from(cloth.panel, p => (cloth.panelFabric?.[p] === "rib" ? 1 : 0))
    this.build(cloth.triangles, Int32Array.from({ length: this.n }, (_, i) => i))
    this.sewing = Int32Array.from(cloth.sewing.flat())
    this.attach = attach?.points.length ? attach : null
    if (this.attach) {
      const band = new Uint8Array(this.n)
      for (const i of this.attach.points) band[i] = 1
      this.allSewing = this.sewing
      this.sewing = Int32Array.from(cloth.sewing.filter(([a, b]) => !band[a] && !band[b]).flat())
      this.held = new Float32Array(this.n)
      for (const i of this.attach.points) { this.held[i] = this.w[i]; this.w[i] = 0 }
      this.reattach(this.x)
    }
  }

  // While bands are held, each band point sits where its attachment puts it, off the edge it's sewn to.
  reattach(p) {
    const { points, from, to, u, offset, direction } = this.attach
    for (let k = 0; k < points.length; k++) {
      const i = 3 * points[k], a = 3 * from[k], b = 3 * to[k], t = u[k], o = offset[k]
      for (let c = 0; c < 3; c++) p[i + c] = p[a + c] * (1 - t) + p[b + c] * t + direction[3 * k + c] * o
    }
  }

  // Lets the held bands go: from now on they're cloth like the rest, and their seams are sewn too.
  releaseBands() {
    if (!this.attach) return
    for (const i of this.attach.points) this.w[i] = this.held[i]
    this.sewing = this.allSewing
    this.attach = null
  }

  // Constraints from the triangles. map: each pattern point's simulated point (after seams are closed, the
  // two sides of a seam are one point).
  build(triangles, map) {
    const pts = this.cloth.points
    const edgeRest = new Map()   // "A,B" (simulated points) -> [sum of rest lengths, count, rib]
    const opposite = new Map()   // "a,b" (pattern points) -> the pattern point opposite it
    const bends = []
    const tris = []
    for (const [a, b, c] of triangles) {
      const A = map[a], B = map[b], C = map[c]
      if (A === B || B === C || C === A) continue
      tris.push(A, B, C)
      for (const [i, j, k] of [[a, b, c], [b, c, a], [c, a, b]]) {
        const I = map[i], J = map[j]
        const key = I < J ? `${I},${J}` : `${J},${I}`
        const rest = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) / 100
        const e = edgeRest.get(key)
        if (e) { e[0] += rest; e[1]++ } else edgeRest.set(key, [rest, 1, this.isRib[i] && this.isRib[j]])
        // Bending: the two points either side of an edge of the flat pattern keep their flat distance apart.
        // (Only edges of the pattern itself: across a seam there's no flat distance to keep.)
        const flatKey = i < j ? `${i},${j}` : `${j},${i}`
        const o = opposite.get(flatKey)
        if (o === undefined) opposite.set(flatKey, k)
        else if (map[o] !== map[k]) bends.push(map[o], map[k], Math.hypot(pts[o][0] - pts[k][0], pts[o][1] - pts[k][1]) / 100, this.hemStrip && this.isHem[o] && this.isHem[k])
      }
    }
    const count = edgeRest.size
    this.edges = new Int32Array(2 * count)
    this.rest = new Float32Array(count)
    this.edgeRib = new Uint8Array(count)
    let e = 0
    for (const [key, [sum, k, rib]] of edgeRest) {
      const [a, b] = key.split(",").map(Number)
      this.edges[2 * e] = a; this.edges[2 * e + 1] = b
      this.rest[e] = sum / k
      this.edgeRib[e] = rib ? 1 : 0
      e++
    }
    // Along free edges (hems and rims), each point's neighbours either side keep their distance too, so the
    // edge stays a smooth line instead of flapping into a zigzag.
    for (const run of this.cloth.free ?? []) {
      for (let k = 1; k < run.length - 1; k++) {
        const a = run[k - 1], c = run[k + 1]
        if (map[a] === map[c]) continue
        bends.push(map[a], map[c], Math.hypot(pts[a][0] - pts[c][0], pts[a][1] - pts[c][1]) / 100, 1)
      }
    }
    // Each point's neighbours and theirs (two steps along the cloth), so cloth touching itself can tell a fold
    // from the cloth round a point, which is near it anyway.
    const neighbourSets = new Map()
    for (let t = 0; t < tris.length; t += 3) {
      for (const [i, j] of [[tris[t], tris[t + 1]], [tris[t + 1], tris[t + 2]], [tris[t + 2], tris[t]]]) {
        if (!neighbourSets.has(i)) neighbourSets.set(i, new Set())
        if (!neighbourSets.has(j)) neighbourSets.set(j, new Set())
        neighbourSets.get(i).add(j); neighbourSets.get(j).add(i)
      }
    }
    const pointCount = Math.max(0, ...map) + 1
    const ring = i => {
      const near = new Set(neighbourSets.get(i) ?? [])
      for (const j of neighbourSets.get(i) ?? []) for (const k of neighbourSets.get(j)) near.add(k)
      near.delete(i)
      return near
    }
    const rings = Array.from({ length: pointCount }, (_, i) => ring(i))
    this.neighbourStart = new Int32Array(pointCount + 1)
    for (let i = 0; i < pointCount; i++) this.neighbourStart[i + 1] = this.neighbourStart[i] + rings[i].size
    this.neighbours = new Int32Array(this.neighbourStart[pointCount])
    for (let i = 0; i < pointCount; i++) {
      let k = this.neighbourStart[i]
      for (const j of rings[i]) this.neighbours[k++] = j
    }
    const bendCount = bends.length / 4
    this.bends = new Int32Array(2 * bendCount)
    this.bendRest = new Float32Array(bendCount)
    this.bendHem = new Uint8Array(bendCount)
    for (let i = 0; i < bendCount; i++) {
      this.bends[2 * i] = bends[4 * i]; this.bends[2 * i + 1] = bends[4 * i + 1]; this.bendRest[i] = bends[4 * i + 2]
      this.bendHem[i] = bends[4 * i + 3] ? 1 : 0
    }
    this.triangles = Uint32Array.from(tris)
  }

  // One frame (1/60 s). gravity: on or off (off while the seams close), or a share of it.
  // still: the cloth keeps no speed from one small step to the next, so it eases into shape instead of
  // springing (see phases' relaxFrames).
  step({ gravity = true, sew = !this.sewn, still = false } = {}) {
    const h = FRAME / SUBSTEPS
    const { x, p, v, w } = this
    const n = this.x.length / 3
    const drag = Math.exp(-this.params.drag * (gravity === true ? 1 : 4) * h)
    const fall = GRAVITY * h * (gravity === true ? 1 : Number(gravity) || 0)
    const stretch = this.params.stretch / (h * h), ribStretch = CLOTHS.rib.stretch / (h * h)
    const bend = this.params.bend / (h * h)
    for (let s = 0; s < SUBSTEPS; s++) {
      for (let i = 0; i < n; i++) {
        if (fall) v[3 * i + 1] += fall
        p[3 * i] = x[3 * i] + v[3 * i] * h
        p[3 * i + 1] = x[3 * i + 1] + v[3 * i + 1] * h
        p[3 * i + 2] = x[3 * i + 2] + v[3 * i + 2] * h
      }
      if (sew) this.pullSeams()
      solveDistances(p, w, this.edges, this.rest, stretch, ribStretch, this.edgeRib)
      solveDistances(p, w, this.bends, this.bendRest, bend, bend * HEM_BEND, this.bendHem)
      if (this.sewn && s % 2 === 1) this.selfCollide()
      this.collide()
      if (this.ring) this.holdRing()
      if (this.attach) this.reattach(p)
      for (let i = 0; i < 3 * n; i++) {
        v[i] = still ? 0 : ((p[i] - x[i]) / h) * drag
        x[i] = p[i]
      }
    }
    this.frame++
  }

  // A waistband holds the garment up where it fits: while the rest is sewn on, it stays at the height it was
  // placed at (where the body is as round as it), and afterwards it can't slip more than a centimetre below
  // where it was sewn. The cloth below it hangs and folds as it will.
  holdRing() {
    const { p, x } = this
    const points = this.map ? this.ring.order.map(i => this.map[i]) : this.ring.order
    if (this.sewn && !this.ring.sewnAt) this.ring.sewnAt = new Map(points.map(j => [j, x[3 * j + 1]]))
    for (const j of points) {
      if (!this.sewn) p[3 * j + 1] = x[3 * j + 1]
      else p[3 * j + 1] = Math.max(p[3 * j + 1], this.ring.sewnAt.get(j) - 0.01)
    }
  }

  // Each pair of points the sewing joins moves together, a little at a time.
  pullSeams() {
    const { p, sewing } = this
    for (let k = 0; k < sewing.length; k += 2) {
      const a = 3 * sewing[k], b = 3 * sewing[k + 1]
      const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2]
      const d = Math.hypot(dx, dy, dz)
      if (d < 1e-6) continue
      const move = (Math.min(d, 2 * MAX_SEW_STEP) / d) * 0.5
      p[a] += dx * move; p[a + 1] += dy * move; p[a + 2] += dz * move
      p[b] -= dx * move; p[b + 1] -= dy * move; p[b + 2] -= dz * move
    }
  }

  // The widest gap left in any seam (m).
  seamGap() {
    let worst = 0
    const { x, sewing } = this
    for (let k = 0; k < sewing.length; k += 2) {
      const a = 3 * sewing[k], b = 3 * sewing[k + 1]
      worst = Math.max(worst, Math.hypot(x[b] - x[a], x[b + 1] - x[a + 1], x[b + 2] - x[a + 2]))
    }
    return worst
  }

  // Points inside the skin, or closer to it than the cloth's thickness, go back out along the skin's normal;
  // touching the skin slows them (friction).
  collide() {
    const { p, x, field } = this
    const hit = field.hit
    const thick = this.params.thickness, keep = this.friction
    const n = p.length / 3
    const tucks = this.tuck ? this.tuckedPoints() : null
    for (let i = 0; i < n; i++) {
      const px = p[3 * i], py = p[3 * i + 1], pz = p[3 * i + 2]
      const d = field.at(px, py, pz)
      if (d >= thick) {
        // Tucked in, cloth is pressed onto the body all the way round, into its hollows (the small of the back)
        // as well: the pants over it follow the body there too.
        if (tucks?.[i] && d < 0.05 && this.underTuck(px, py, pz)) {
          const pull = d - thick
          p[3 * i] -= hit[0] * pull; p[3 * i + 1] -= hit[1] * pull; p[3 * i + 2] -= hit[2] * pull
        }
        continue
      }
      const nx = hit[0], ny = hit[1], nz = hit[2]
      const push = thick - d
      let qx = px + nx * push, qy = py + ny * push, qz = pz + nz * push
      // Friction: take away some of the sideways movement of this step.
      const mx = qx - x[3 * i], my = qy - x[3 * i + 1], mz = qz - x[3 * i + 2]
      const normal = mx * nx + my * ny + mz * nz
      const tx = mx - normal * nx, ty = my - normal * ny, tz = mz - normal * nz
      qx -= tx * (1 - keep); qy -= ty * (1 - keep); qz -= tz * (1 - keep)
      p[3 * i] = qx; p[3 * i + 1] = qy; p[3 * i + 2] = qz
    }
    if (this.envelope) this.stayOutside()
    if (this.tuck) this.stayTucked()
    if (this.feet) this.stayOffFeet()
    if (this.floor !== null) {
      // On the floor, cloth stays put rather than sliding (it rests on it).
      for (let i = 0; i < n; i++) {
        if (p[3 * i + 1] >= this.floor) continue
        p[3 * i + 1] = this.floor
        p[3 * i] = x[3 * i] + (p[3 * i] - x[3 * i]) * 0.3
        p[3 * i + 2] = x[3 * i + 2] + (p[3 * i + 2] - x[3 * i + 2]) * 0.3
      }
    }
  }

  // Cloth can't pass through itself: points closer than `selfRadius` (that aren't within two steps of each
  // other along the cloth) push apart. A hashed grid finds the near ones.
  selfCollide() {
    const { p } = this
    const n = p.length / 3
    const radius = this.selfRadius
    if (radius <= 0) return
    const cell = radius
    const size = 1 << 16, mask = size - 1
    const head = (this.hashHead ??= new Int32Array(size))
    head.fill(-1)
    const next = this.hashNext?.length >= n ? this.hashNext : (this.hashNext = new Int32Array(n))
    const key = (ix, iy, iz) => ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) & mask
    for (let i = 0; i < n; i++) {
      const k = key(Math.floor(p[3 * i] / cell), Math.floor(p[3 * i + 1] / cell), Math.floor(p[3 * i + 2] / cell))
      next[i] = head[k]
      head[k] = i
    }
    const r2 = radius * radius
    const start = this.neighbourStart, nb = this.neighbours
    // Tucked under a waistband, cloth gathers in layers too thin to keep apart; it's hidden there anyway.
    let quiet = null
    if (this.tuck && this.simTucks) {
      quiet = this.quiet?.length === n ? this.quiet : (this.quiet = new Uint8Array(n))
      for (let i = 0; i < n; i++) quiet[i] = this.simTucks[i] && this.underTuck(p[3 * i], p[3 * i + 1], p[3 * i + 2]) ? 1 : 0
    }
    for (let i = 0; i < n; i++) {
      const ix = Math.floor(p[3 * i] / cell), iy = Math.floor(p[3 * i + 1] / cell), iz = Math.floor(p[3 * i + 2] / cell)
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) for (let oz = -1; oz <= 1; oz++) {
        for (let j = head[key(ix + ox, iy + oy, iz + oz)]; j >= 0; j = next[j]) {
          if (j <= i || (quiet && quiet[i] && quiet[j])) continue
          const dx = p[3 * j] - p[3 * i], dy = p[3 * j + 1] - p[3 * i + 1], dz = p[3 * j + 2] - p[3 * i + 2]
          const d2 = dx * dx + dy * dy + dz * dz
          if (d2 >= r2 || d2 < 1e-14) continue
          let adjacent = false
          for (let k = start[i]; k < start[i + 1]; k++) if (nb[k] === j) { adjacent = true; break }
          if (adjacent) continue
          const d = Math.sqrt(d2), push = ((radius - d) / d) * 0.5
          p[3 * i] -= dx * push; p[3 * i + 1] -= dy * push; p[3 * i + 2] -= dz * push
          p[3 * j] += dx * push; p[3 * j + 1] += dy * push; p[3 * j + 2] += dz * push
        }
      }
    }
  }

  // Near the floor, each leg's points go out of their own foot: up onto it (the instep, the heel) when its top
  // is nearer, else out to the nearest side of its outline. Pushed only sideways, a hem landing on the instep
  // is shoved round the foot and twists the leg.
  stayOffFeet() {
    const { p } = this
    const thick = this.params.thickness
    const map = this.map
    if (map && !this.simSide) {
      this.simSide = new Int8Array(this.x.length / 3)
      for (let i = 0; i < map.length; i++) if (this.legSide[i]) this.simSide[map[i]] = this.legSide[i]
    }
    const side = map ? this.simSide : this.legSide
    const n = p.length / 3
    for (let i = 0; i < n; i++) {
      if (!side[i]) continue
      const foot = side[i] > 0 ? this.feet.L : this.feet.R
      const y = p[3 * i + 1]
      if (y > foot.top) continue
      // A snug hem can't slip lower than the foot lets it; there it stays put, as on the floor.
      const low = this.snug ? ((foot.snugAt ??= new Map()).get(this.snug) ?? foot.snugAt.set(this.snug, foot.lowest(this.snug)).get(this.snug)) : -Infinity
      if (y < low) {
        p[3 * i + 1] = low
        p[3 * i] = this.x[3 * i] + (p[3 * i] - this.x[3 * i]) * 0.3
        p[3 * i + 2] = this.x[3 * i + 2] + (p[3 * i + 2] - this.x[3 * i + 2]) * 0.3
        continue
      }
      const hull = foot.at(y)
      if (!hull) continue
      const px = p[3 * i], pz = p[3 * i + 2]
      let best = Infinity, bx = 0, bz = 0
      let inside = true
      for (let k = 0; k < hull.length; k++) {
        const [ax, az] = hull[k], [cx, cz] = hull[(k + 1) % hull.length]
        const ex = cx - ax, ez = cz - az, len = Math.hypot(ex, ez) || 1
        const d = (ex * (pz - az) - ez * (px - ax)) / len   // > 0: inside (left of an anticlockwise edge)
        if (d < -thick) { inside = false; break }
        if (d < best) { best = d; bx = ez / len; bz = -ex / len }
      }
      if (!inside) continue
      // How high the foot rises over this point: up the slices while it's still inside them.
      let r = Math.floor((y - foot.floor) / foot.step)
      while (r + 1 < foot.hulls.length && foot.hulls[r + 1] && insideHull(foot.hulls[r + 1], px, pz)) r++
      const up = foot.floor + (r + 1) * foot.step - y
      if (up < best) {
        p[3 * i + 1] = y + up + thick
        // Resting on it, it stays put rather than sliding off (as on the floor).
        p[3 * i] = this.x[3 * i] + (px - this.x[3 * i]) * 0.3
        p[3 * i + 2] = this.x[3 * i + 2] + (pz - this.x[3 * i + 2]) * 0.3
      } else {
        p[3 * i] = px + bx * (best + thick)
        p[3 * i + 2] = pz + bz * (best + thick)
      }
    }
  }

  // Whether a point is below the tuck's top (which rises towards the middle of the back).
  underTuck(x, y, z) {
    const { table, top, raise = 0 } = this.tuck
    if (y > top + raise) return false
    return y <= top + raise * Math.max(0, -Math.cos(Math.atan2(x, z - table.centreAt(y))))
  }

  // Which simulated points are on a tucked top's body pieces.
  tuckedPoints() {
    if (!this.map) return this.tucks
    if (!this.simTucks) {
      this.simTucks = new Uint8Array(this.x.length / 3)
      for (let i = 0; i < this.map.length; i++) if (this.tucks[i]) this.simTucks[this.map[i]] = 1
    }
    return this.simTucks
  }

  // A tucked top's body pieces, below the tuck's top: pulled in towards the body's middle line until they're
  // within the tuck's room of its convex outline.
  stayTucked() {
    const { p } = this
    const { table, inside } = this.tuck
    const tucks = this.tuckedPoints()
    const n = p.length / 3
    for (let i = 0; i < n; i++) {
      if (!tucks[i]) continue
      const y = p[3 * i + 1]
      if (!this.underTuck(p[3 * i], y, p[3 * i + 2])) continue
      const x = p[3 * i], z = p[3 * i + 2] - table.centreAt(y)
      const angle = Math.atan2(x, z)
      const r = Math.hypot(x, z)
      const reach = table.envelope(y, angle) + inside
      if (r <= reach) continue
      const s = reach / r
      p[3 * i] = x * s
      p[3 * i + 2] = table.centreAt(y) + z * s
    }
  }

  // Below the envelope's top, push points out sideways from the body's middle line to its convex outline.
  stayOutside() {
    const { p } = this
    const { table, top, bottom = -Infinity } = this.envelope
    const thick = this.params.thickness
    const n = p.length / 3
    for (let i = 0; i < n; i++) {
      const y = p[3 * i + 1]
      if (y > top || y < bottom) continue
      const x = p[3 * i], z = p[3 * i + 2] - table.centreAt(y)
      const r = Math.hypot(x, z)
      if (r < 1e-6) continue
      const reach = table.envelope(y, Math.atan2(x, z)) + thick
      if (r >= reach) continue
      const s = reach / r
      p[3 * i] = x * s
      p[3 * i + 2] = table.centreAt(y) + z * s
    }
  }

  // Moves the finished cloth (its joined points, see closeSeams) to new positions on a new body: the same
  // garment skinned into another pose, to settle there.
  // envelope: the new body's (see the constructor), to keep a skirt round both legs there too, or null.
  repose(positions, field, envelope = null, feet = null) {
    this.x.set(positions)
    this.v.fill(0)
    this.field = field
    this.envelope = envelope
    this.feet = feet
  }

  // Settles it where it is, a frame at a time (see phases), calming it at the end.
  * settle(frames = 70, calmFrames = 25) {
    const drag = this.params.drag
    for (let k = 0; k < frames; k++) {
      this.params.drag = k >= frames - calmFrames ? Math.max(drag, 6) : drag * 2
      this.step({ gravity: true, sew: false })
      yield "posing"
    }
    this.params.drag = drag
  }

  // Join each sewn pair into one point, so the garment is one piece of cloth; the constraints are rebuilt
  // on the joined points. this.map then gives each pattern point its simulated point.
  closeSeams() {
    const n = this.n
    const parent = Int32Array.from({ length: n }, (_, i) => i)
    const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
    for (let k = 0; k < this.sewing.length; k += 2) {
      const a = find(this.sewing[k]), b = find(this.sewing[k + 1])
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b)
    }
    const index = new Int32Array(n).fill(-1)
    let next = 0
    for (let i = 0; i < n; i++) if (find(i) === i) index[i] = next++
    const map = Int32Array.from({ length: n }, (_, i) => index[find(i)])
    const x = new Float32Array(3 * next), count = new Float32Array(next)
    for (let i = 0; i < n; i++) {
      const j = map[i]
      x[3 * j] += this.x[3 * i]; x[3 * j + 1] += this.x[3 * i + 1]; x[3 * j + 2] += this.x[3 * i + 2]
      count[j]++
    }
    for (let j = 0; j < next; j++) { x[3 * j] /= count[j]; x[3 * j + 1] /= count[j]; x[3 * j + 2] /= count[j] }
    this.map = map
    this.x = x
    this.p = new Float32Array(3 * next)
    this.v = new Float32Array(3 * next)
    const mass = new Float32Array(next)
    for (let i = 0; i < n; i++) mass[map[i]] = Math.max(mass[map[i]], this.isHem[i] ? HEM_WEIGHT : 1)
    this.w = Float32Array.from(mass, m => 1 / m)
    this.build(this.cloth.triangles, map)
    this.sewing = new Int32Array(0)
    this.sewn = true
    this.joined = next
  }

  // The garment as drawn: every pattern point (so each panel keeps its own texture coordinates) at its
  // simulated position. Returns Float32Array positions.
  pattern() {
    const map = this.map ?? Int32Array.from({ length: this.n }, (_, i) => i)
    const out = new Float32Array(3 * this.n)
    for (let i = 0; i < this.n; i++) {
      const j = map[i]
      out[3 * i] = this.x[3 * j]; out[3 * i + 1] = this.x[3 * j + 1]; out[3 * i + 2] = this.x[3 * j + 2]
    }
    return out
  }

  // How stretched the cloth is round each pattern point: its edges' length over their rest length, averaged.
  strain() {
    const map = this.map ?? Int32Array.from({ length: this.n }, (_, i) => i)
    const m = this.x.length / 3
    const sum = new Float32Array(m), count = new Float32Array(m)
    const { x, edges, rest } = this
    for (let e = 0; e < rest.length; e++) {
      const a = edges[2 * e], b = edges[2 * e + 1]
      const ratio = Math.hypot(x[3 * b] - x[3 * a], x[3 * b + 1] - x[3 * a + 1], x[3 * b + 2] - x[3 * a + 2]) / rest[e]
      sum[a] += ratio; count[a]++; sum[b] += ratio; count[b]++
    }
    return Float32Array.from({ length: this.n }, (_, i) => (count[map[i]] ? sum[map[i]] / count[map[i]] : 1))
  }
}

// One pass over distance constraints (XPBD, one iteration per small step). compliance: already divided by
// the step squared; rib: per constraint, use ribCompliance instead.
function solveDistances(p, w, pairs, rest, compliance, ribCompliance, rib) {
  const count = rest.length
  for (let e = 0; e < count; e++) {
    const a = 3 * pairs[2 * e], b = 3 * pairs[2 * e + 1]
    const dx = p[a] - p[b], dy = p[a + 1] - p[b + 1], dz = p[a + 2] - p[b + 2]
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (d < 1e-9) continue
    const wa = w[pairs[2 * e]], wb = w[pairs[2 * e + 1]]
    const alpha = rib && rib[e] ? ribCompliance : compliance
    const lambda = -(d - rest[e]) / (wa + wb + alpha)
    const sx = (dx / d) * lambda, sy = (dy / d) * lambda, sz = (dz / d) * lambda
    p[a] += sx * wa; p[a + 1] += sy * wa; p[a + 2] += sz * wa
    p[b] -= sx * wb; p[b + 1] -= sy * wb; p[b + 2] -= sz * wb
  }
}

// The whole drape: sew with gravity off, first the body's own seams (with the bands held on their edges) and
// then the bands', until the seams close; join them, then let it hang and settle, calming it at the end.
// options: Drape's, plus attach (from placeCloth), sewFrames, settleFrames. onFrame(drape, phase) is called
// after each frame (for drawing progress). Returns the drape.
export function drapeGarment(cloth, start, body, options = {}, onFrame = null) {
  const drape = new Drape(cloth, start, body, options)
  for (const phase of drape.phases(options)) onFrame?.(drape, phase)
  return drape
}

// The same, a frame at a time: a generator that yields after each frame with the phase it's in ("sewing",
// "settling"), so a page can run a few frames between redraws.
// relaxFrames: frames at the start in which the placed cloth only eases to its own size, keeping no speed.
// Cloth laid round a body starts a little stretched in places (round a waist, over the hips); let go at once
// it springs back hard enough to fling the hem up and crumple it.
// sewGravity: a share of gravity while sewing, to hold a long garment's skirt down as its seams close (with
// none, the cloth draws up as it's pulled together, and a skirt rides up the legs and crumples coming down).
Drape.prototype.phases = function* ({ sewFrames = 150, settleFrames = 150, calmFrames = 50, sewGravity = false, relaxFrames = 0 } = {}) {
  let f = 0
  for (let k = 0; k < relaxFrames; k++, f++) {
    this.step({ gravity: 0, sew: false, still: true })
    yield "sewing"
  }
  // Sewing stops once every seam has closed to a few millimetres, or has stopped closing any further.
  const sew = function* (drape, limit) {
    let best = Infinity, since = 0
    for (let k = 0; k < limit; k++, f++) {
      drape.step({ gravity: sewGravity, sew: true })
      yield "sewing"
      if (k < 12 || k % 4) continue
      const gap = drape.seamGap()
      if (gap < 0.005) return
      if (gap < best - 0.0005) { best = gap; since = k } else if (gap < 0.012 && k - since >= 12) return
    }
  }
  if (this.attach) {
    yield* sew(this, sewFrames)
    this.releaseBands()
  }
  yield* sew(this, sewFrames)
  this.sewFramesUsed = f
  this.closeSeams()
  const drag = this.params.drag
  for (let k = 0; k < settleFrames; k++) {
    if (k === settleFrames - calmFrames) this.params.drag = Math.max(drag, 6)
    this.step({ gravity: true, sew: false })
    yield "settling"
  }
  this.params.drag = drag
}

// Whether [x, z] is inside a convex outline whose points run anticlockwise.
function insideHull(hull, x, z) {
  for (let k = 0; k < hull.length; k++) {
    const [ax, az] = hull[k], [cx, cz] = hull[(k + 1) % hull.length]
    if ((cx - ax) * (z - az) - (cz - az) * (x - ax) < 0) return false
  }
  return true
}

// A waist's points in order round it (by angle about their middle, seen from above), each once.
function ringOrder(points, positions) {
  const unique = [...new Set(points)]
  let cx = 0, cz = 0
  for (const i of unique) { cx += positions[3 * i]; cz += positions[3 * i + 2] }
  cx /= unique.length; cz /= unique.length
  return unique.sort((a, b) => Math.atan2(positions[3 * a] - cx, positions[3 * a + 2] - cz) - Math.atan2(positions[3 * b] - cx, positions[3 * b + 2] - cz))
}
