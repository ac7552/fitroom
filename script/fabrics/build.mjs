// The cloth's surfaces, built yarn by yarn: for each fabric the page draws (fabric.js's surfaces), a tile of
// its structure as the threads make it (a plain, twill or satin weave with each warp and weft yarn going
// over and under its neighbours, a jersey knit's V-shaped loops, rib's raised knit wales and sunken purl
// ones, fleece's brushed fibres, felted wool, leather's grain), with the yarns' twist and stray fibres. From
// the height that leaves, three things the shader uses: the surface's tilt (a normal map), how far each
// spot is down between yarns (cavity: light reaches it less), and how rough it is (a yarn's top is
// smoother than the fibres between). No scans or downloads: the geometry is ours (CC0, like the rest).
//
//   node script/fabrics/build.mjs [out]      # writes public/models/fabrics/<surface>-normal.webp and -detail.webp
//
// (WebP, through sharp, about a tenth the size of PNG: NODE_PATH=<a node_modules with sharp>; without sharp,
// PNG, and fabric.js's SURFACE_EXT must say so.)
//
// Each tile repeats seamlessly (every count across it is whole), and is read at fabric.js's CLOTHS tile size.
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { createRequire } from "node:module"

const OUT = path.resolve(process.argv[2] ?? "public/models/fabrics")
const N = 512

// Tileable smooth noise (value noise on a lattice that wraps), and its fractal sum.
function noiseOf(seed) {
  let s = seed >>> 0
  const random = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const G = 256, grid = Float32Array.from({ length: G * G }, random)
  const at = (i, j, cells) => grid[(((j % cells) + cells) % cells) * G + (((i % cells) + cells) % cells)]
  const one = (u, v, cells) => {
    const x = u * cells, y = v * cells, fx = Math.floor(x), fy = Math.floor(y), tx = x - fx, ty = y - fy
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty)
    const a = at(fx, fy, cells), b = at(fx + 1, fy, cells), c = at(fx, fy + 1, cells), d = at(fx + 1, fy + 1, cells)
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
  }
  return { one, fbm: (u, v, cells, octaves = 4) => { let sum = 0, amp = 0.5, total = 0; for (let k = 0; k < octaves; k++) { sum += amp * one(u, v, cells << k); total += amp; amp *= 0.5 } return sum / total }, random }
}

// A yarn's cross-section: round, 1 at its middle, 0 at its edge (d and r in the same units).
const round = (d, r) => (Math.abs(d) >= r ? -1 : Math.sqrt(1 - (d / r) ** 2))
const smooth = t => t * t * (3 - 2 * t)
const wrap = t => t - Math.floor(t)

// A woven cloth: `ends` warp yarns (up the tile) and `picks` weft yarns (across), crossing over(i, j) (warp i
// over weft j); each yarn rises over the yarns it crosses and dips under, smoothly. radius: a yarn's half
// width as a share of its spacing; lift: how far it rises and dips; twist: the ply's stripes per crossing;
// slub: how much a yarn's thickness wanders along it; thick(i): a yarn heavier than the rest (ripstop's).
function weave({ ends, picks, over, radius = 0.42, lift = 0.28, twist = 2, slub = 0, thick = () => 1, seed = 1, fuzz = 0.06 }) {
  const n = noiseOf(seed)
  const crossing = (k, count, value) => {
    // Smoothly from the crossing before to the one after (a cosine between their values).
    const x = wrap(k / count) * count - 0.5, j0 = Math.floor(x), t = x - j0
    return value(j0) + (value(j0 + 1) - value(j0)) * smooth(t)
  }
  return (u, v) => {
    let best = -1, top = 0, warp = 1
    // The warp yarn under this point (and its neighbour), rising and dipping along v.
    const fu = u * ends - 0.5, i0 = Math.floor(fu)
    for (const i of [i0, i0 + 1]) {
      const r = radius * thick(((i % ends) + ends) % ends) * (1 + slub * (n.one((i + 0.5) / ends, v, 24) - 0.5))
      const d = fu - i
      const h = round(d, r)
      if (h < 0) continue
      const z = crossing(v * picks, picks, j => (over(((i % ends) + ends) % ends, ((j % picks) + picks) % picks) ? lift : -lift))
      const stripes = 0.07 * Math.cos(2 * Math.PI * (v * picks * twist + d * 1.5))
      const value = z + 0.5 * h + stripes * h
      if (value > best) { best = value; top = h; warp = 1 }
    }
    // And the weft yarn, along u.
    const fv = v * picks - 0.5, j0 = Math.floor(fv)
    for (const j of [j0, j0 + 1]) {
      const r = radius * thick(((j % picks) + picks) % picks) * (1 + slub * (n.one(u, (j + 0.5) / picks, 24) - 0.5))
      const d = fv - j
      const h = round(d, r)
      if (h < 0) continue
      const z = crossing(u * ends, ends, i => (over(((i % ends) + ends) % ends, ((j % picks) + picks) % picks) ? -lift : lift))
      const stripes = 0.07 * Math.cos(2 * Math.PI * (u * ends * twist - d * 1.5))
      const value = z + 0.5 * h + stripes * h
      if (value > best) { best = value; top = h; warp = 0 }
    }
    // The gaps between yarns, and the stray fibres over everything.
    if (best < -0.9) best = -lift - 0.3
    return { height: best + fuzz * (n.fbm(u, v, 64, 3) - 0.5), top, warp }
  }
}

// A knit's face: `wales` columns of V-shaped stitches across, `courses` up; each stitch two legs, leaning in
// to the bottom of the V; purl(w): a wale knitted from the back (rib), sunken, its loops lying across.
function knit({ wales, courses, purl = () => false, leg = 0.2, seed = 2, fuzz = 0.08, twist = 3 }) {
  const n = noiseOf(seed)
  // The distance from (x, y) to the segment a-b, and how far along it.
  const segment = (x, y, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
    return [Math.hypot(x - ax - t * dx, y - ay - t * dy), t]
  }
  return (u, v) => {
    const fx = u * wales, fy = v * courses
    const w = Math.floor(fx), c = Math.floor(fy)
    let best = -0.3, top = 0
    // This stitch's legs, and the neighbours' that reach into it.
    for (const ow of [-1, 0, 1]) for (const oc of [-1, 0]) {
      const W = w + ow, C = c + oc
      const x = fx - W, y = fy - C
      const sunk = purl(((W % wales) + wales) % wales)
      if (sunk) {
        // A purl bump: a loop lying across the wale.
        const [d, t] = segment(x, y, 0.08, 0.5, 0.92, 0.5)
        const h = round(d, 0.3)
        if (h >= 0) { const value = -0.35 + 0.45 * h + 0.06 * h * Math.cos(2 * Math.PI * t * twist); if (value > best) { best = value; top = h } }
        continue
      }
      for (const [ax, ay, bx, by] of [[0.5, 0.0, 0.08, 1.05], [0.5, 0.0, 0.92, 1.05]]) {
        const [d, t] = segment(x, y, ax, ay, bx, by)
        const h = round(d, leg)
        if (h < 0) continue
        // Each leg rises from where it's pulled through the stitch below to the top of its loop.
        const value = 0.25 * smooth(t) - 0.1 + 0.5 * h + 0.07 * h * Math.cos(2 * Math.PI * (t * twist + d * 2))
        if (value > best) { best = value; top = h }
      }
    }
    return { height: best + fuzz * (n.fbm(u, v, 64, 3) - 0.5), top }
  }
}

// Fibres: `count` short curved strokes lying at random, each a little raised; brushed (fleece) or felted
// (wool). base: a structure under them (a knit), or null. Returns a height function.
function fibres({ count, length, width, base = null, height = 0.5, seed = 3, smoothness = 0 }) {
  const n = noiseOf(seed)
  const field = new Float32Array(N * N)
  for (let k = 0; k < count; k++) {
    let x = n.random() * N, y = n.random() * N
    let a = n.random() * Math.PI * 2
    const len = length * (0.5 + n.random()), h = height * (0.4 + 0.6 * n.random())
    const bend = (n.random() - 0.5) * 0.25
    for (let s = 0; s < len; s += 0.7) {
      x += Math.cos(a) * 0.7; y += Math.sin(a) * 0.7; a += bend * 0.7 / length * 6
      const r = width
      for (let oy = -Math.ceil(r); oy <= Math.ceil(r); oy++) for (let ox = -Math.ceil(r); ox <= Math.ceil(r); ox++) {
        const d = Math.hypot(ox, oy)
        if (d > r) continue
        const X = ((Math.round(x) + ox) % N + N) % N, Y = ((Math.round(y) + oy) % N + N) % N
        const value = h * Math.sqrt(1 - (d / r) ** 2)
        if (value > field[Y * N + X]) field[Y * N + X] = value
      }
    }
  }
  const blurred = smoothness ? blur(field, smoothness) : field
  return (u, v) => {
    const X = Math.min(N - 1, Math.floor(u * N)), Y = Math.min(N - 1, Math.floor(v * N))
    const under = base ? base(u, v) : { height: 0, top: 0 }
    const f = blurred[Y * N + X]
    return { height: Math.max(under.height * 0.6, f + under.height * 0.3) + 0.05 * (n.fbm(u, v, 32, 3) - 0.5), top: Math.max(under.top * 0.5, f) }
  }
}

// Leather's grain: tileable cells, raised in their middles and creased at their edges, with pores.
function grain({ cells = 40, seed = 4 }) {
  const n = noiseOf(seed)
  // Each cell's point, as its place within the cell (so a neighbour across the tile's edge is the same).
  const offsets = Array.from({ length: cells * cells }, () => [n.random(), n.random()])
  return (u, v) => {
    let d1 = Infinity, d2 = Infinity
    const cx = Math.floor(u * cells), cy = Math.floor(v * cells)
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const X = cx + ox, Y = cy + oy
      const [fx, fy] = offsets[(((Y % cells) + cells) % cells) * cells + (((X % cells) + cells) % cells)]
      const d = Math.hypot(u * cells - (X + fx), v * cells - (Y + fy))
      if (d < d1) { d2 = d1; d1 = d } else if (d < d2) d2 = d
    }
    const edge = Math.min(1, (d2 - d1) * 2.2)
    const pore = n.one(u, v, 180) > 0.93 ? -0.15 : 0
    return { height: 0.5 * Math.sqrt(edge) + pore + 0.08 * (n.fbm(u, v, 48, 3) - 0.5), top: edge }
  }
}

function blur(field, radius) {
  const out = new Float32Array(N * N), tmp = new Float32Array(N * N)
  const r = Math.max(1, Math.round(radius))
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let s = 0
    for (let k = -r; k <= r; k++) s += field[y * N + ((x + k) % N + N) % N]
    tmp[y * N + x] = s / (2 * r + 1)
  }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let s = 0
    for (let k = -r; k <= r; k++) s += tmp[(((y + k) % N + N) % N) * N + x]
    out[y * N + x] = s / (2 * r + 1)
  }
  return out
}

const jersey = knit({ wales: 14, courses: 18 })
const SURFACES = {
  knit: jersey,
  rib: knit({ wales: 20, courses: 13, purl: w => w % 2 === 1, leg: 0.22 }),
  fine: knit({ wales: 40, courses: 48, leg: 0.22, fuzz: 0.05 }),
  // (Fleece is the brushed side: its knit hidden under the raised fibres.)
  fleece: fibres({ count: 16000, length: 7, width: 1.1, height: 0.35, smoothness: 2.2, seed: 10 }),
  felt: fibres({ count: 9000, length: 7, width: 1.3, height: 0.5, smoothness: 1.6, seed: 5 }),
  // Denim and chino: a 3/1 twill (the warp over three wefts, under one, a step over each row), slubby.
  twill: weave({ ends: 24, picks: 24, over: (i, j) => (j - i + 400) % 4 !== 3, radius: 0.46, lift: 0.3, slub: 0.35, seed: 6 }),
  // Denim: the same 3/1 twill, heavier and slubbier, its warp indigo and its weft undyed (fabric.js shows
  // the weft where it's on top).
  denim: weave({ ends: 28, picks: 28, over: (i, j) => (j - i + 400) % 4 !== 3, radius: 0.47, lift: 0.34, slub: 0.55, seed: 11 }),
  plain: weave({ ends: 24, picks: 24, over: (i, j) => (i + j) % 2 === 0, radius: 0.44, lift: 0.26, seed: 7 }),
  // Nylon ripstop: a fine plain weave with a heavier yarn every eighth.
  ripstop: weave({ ends: 48, picks: 48, over: (i, j) => (i + j) % 2 === 0, radius: 0.4, lift: 0.2, thick: i => (i % 8 === 0 ? 1.6 : 1), fuzz: 0.02, seed: 8 }),
  // Satin: a 5-harness satin, each warp floating over four wefts, so the surface is long smooth floats.
  smooth: weave({ ends: 60, picks: 60, over: (i, j) => (j - 2 * i + 500) % 5 !== 0, radius: 0.52, lift: 0.05, twist: 0, fuzz: 0.015, seed: 9 }),
  grain: grain({})
}

// The height field and what's derived from it: a normal map (rg: the tilt, b: up), and the detail map
// (r: cavity, 1 open to 0 deep between yarns; g: roughness, 0.5 the cloth's own, more between and on fibres;
// b: on a woven cloth, 1 where a warp yarn is on top and 0 a weft; on others, the yarns' tops).
function bake(fn) {
  const height = new Float32Array(N * N), top = new Float32Array(N * N), which = new Float32Array(N * N)
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const r = fn((x + 0.5) / N, (y + 0.5) / N)
    height[y * N + x] = r.height
    top[y * N + x] = r.top
    which[y * N + x] = r.warp ?? r.top
  }
  let lo = Infinity, hi = -Infinity
  for (const h of height) { if (h < lo) lo = h; if (h > hi) hi = h }
  for (let i = 0; i < height.length; i++) height[i] = (height[i] - lo) / (hi - lo || 1)
  const wide = blur(height, 6)
  const normal = new Uint8Array(N * N * 4), detail = new Uint8Array(N * N * 4)
  const at = (x, y) => height[((y + N) % N) * N + ((x + N) % N)]
  // (How steep the relief is drawn: the heights span a yarn's thickness, a few pixels across.)
  const STEEP = 5
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * STEEP, dy = (at(x, y + 1) - at(x, y - 1)) * STEEP
    const l = Math.hypot(dx, dy, 1), i = 4 * (y * N + x)
    normal[i] = Math.round((-dx / l * 0.5 + 0.5) * 255)
    normal[i + 1] = Math.round((-dy / l * 0.5 + 0.5) * 255)
    normal[i + 2] = Math.round((1 / l * 0.5 + 0.5) * 255)
    normal[i + 3] = 255
    const deep = Math.max(0, wide[y * N + x] - height[y * N + x])
    detail[i] = Math.round(Math.max(0, 1 - deep * 2.6) * 255)
    detail[i + 1] = Math.round(Math.min(1, 0.45 + deep * 1.5 + (1 - top[y * N + x]) * 0.15) * 255)
    detail[i + 2] = Math.round(Math.min(1, which[y * N + x]) * 255)
    detail[i + 3] = 255
  }
  return { normal, detail }
}

// A PNG of N × N RGBA bytes.
function png(rgba) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(N, 0); header.writeUInt32BE(N, 4); header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0
  const raw = Buffer.alloc((N * 4 + 1) * N)
  for (let y = 0; y < N; y++) { raw[y * (N * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * N * 4, N * 4).copy(raw, y * (N * 4 + 1) + 1) }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))])
}

fs.mkdirSync(OUT, { recursive: true })
let sharp = null
try { sharp = createRequire(path.resolve(process.env.NODE_PATH ?? "node_modules", "x"))("sharp") } catch { sharp = null }
const write = async (file, rgba, quality) => {
  if (!sharp) return fs.writeFileSync(`${file}.png`, png(rgba))
  await sharp(Buffer.from(rgba.buffer), { raw: { width: N, height: N, channels: 4 } }).removeAlpha().webp({ quality, effort: 6 }).toFile(`${file}.webp`)
}
const only = process.env.ONLY?.split(",")
for (const [name, fn] of Object.entries(SURFACES)) {
  if (only && !only.includes(name)) continue
  const t0 = Date.now()
  const { normal, detail } = bake(fn)
  await write(path.join(OUT, `${name}-normal`), normal, 92)
  await write(path.join(OUT, `${name}-detail`), detail, 88)
  console.log(`${name}: ${Date.now() - t0} ms`)
}
