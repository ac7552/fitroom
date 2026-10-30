import * as THREE from "three"
import { bodyFrame, SkinField } from "lib/garments/body"
import { STYLES, draftTop } from "lib/garments/pattern"
import { BACK_RAISE, BOTTOM_STYLES, bottomMeasures, draftBottoms, riseFor } from "lib/garments/pants"
import { buildCloth } from "lib/garments/cloth"
import { placeCloth } from "lib/garments/place"
import { bottomsPhotoUV, heightsDown, widthsAcross } from "lib/garments/photo_map"
import { Drape } from "lib/garments/drape"
import { BLANK_TEXTURE, clothMaterial, sheenTint } from "lib/garments/fabric"

// Dressing the mannequin in a top cut from its pattern: the body as the cloth sees it, the drape run a few
// frames at a time between redraws (so the page stays smooth and the cloth is seen settling), the garment's
// mesh and its materials, the shading in its folds, and its fit map.

export const TOP_STYLES = Object.keys(STYLES)
const SPACING = 1.6   // cm between the cloth's points
const BOTTOM_SPACING = 2   // pants have more cloth, and less fine detail to show

// The body as it's shaped and posed now, in world space: positions, normals, triangles, skin weights and bone
// names (for bodyFrame), from the mannequin's skinned mesh.
export function bodySnapshot(mesh) {
  const g = mesh.geometry
  const count = g.attributes.position.count
  const base = g.attributes.position
  const local = new Float32Array(3 * count)
  for (let i = 0; i < count; i++) {
    local[3 * i] = base.getX(i); local[3 * i + 1] = base.getY(i); local[3 * i + 2] = base.getZ(i)
  }
  const morphs = g.morphAttributes.position ?? []
  const influences = mesh.morphTargetInfluences ?? []
  for (let k = 0; k < morphs.length; k++) {
    const w = influences[k]
    if (!w) continue
    const m = morphs[k]
    for (let i = 0; i < count; i++) {
      local[3 * i] += w * (m.getX(i) - (g.morphTargetsRelative ? 0 : base.getX(i)))
      local[3 * i + 1] += w * (m.getY(i) - (g.morphTargetsRelative ? 0 : base.getY(i)))
      local[3 * i + 2] += w * (m.getZ(i) - (g.morphTargetsRelative ? 0 : base.getZ(i)))
    }
  }
  const skinIndex = Uint16Array.from(g.attributes.skinIndex.array)
  const skinWeight = Float32Array.from(g.attributes.skinWeight.array)
  const positions = skinPoints(local, skinIndex, skinWeight, mesh)
  const index = Uint32Array.from(g.index.array)
  return {
    positions, normals: vertexNormals(positions, index), index, skinIndex, skinWeight, local,
    bones: mesh.skeleton.bones.map(b => b.name), head: g.attributes._head ? Float32Array.from(g.attributes._head.array) : null
  }
}

// Points in the skinned mesh's bind space, moved by its skeleton as it's posed now, into world space.
export function skinPoints(points, skinIndex, skinWeight, mesh) {
  const { bones, boneInverses } = mesh.skeleton
  const matrices = bones.map((bone, i) => new THREE.Matrix4().multiplyMatrices(bone.matrixWorld, boneInverses[i]).multiply(mesh.bindMatrix).elements)
  const n = points.length / 3
  const out = new Float32Array(points.length)
  for (let i = 0; i < n; i++) {
    const x = points[3 * i], y = points[3 * i + 1], z = points[3 * i + 2]
    let ox = 0, oy = 0, oz = 0
    for (let k = 0; k < 4; k++) {
      const w = skinWeight[4 * i + k]
      if (!w) continue
      const m = matrices[skinIndex[4 * i + k]]
      ox += w * (m[0] * x + m[4] * y + m[8] * z + m[12])
      oy += w * (m[1] * x + m[5] * y + m[9] * z + m[13])
      oz += w * (m[2] * x + m[6] * y + m[10] * z + m[14])
    }
    out[3 * i] = ox; out[3 * i + 1] = oy; out[3 * i + 2] = oz
  }
  return out
}

// Area-weighted vertex normals of a triangle mesh.
export function vertexNormals(positions, index) {
  const normals = new Float32Array(positions.length)
  addFaceNormals(positions, index, normals, null)
  normalizeAll(normals)
  return normals
}

// Each triangle's normal (its length twice the area), added to its corners (or the points they map to).
function addFaceNormals(positions, index, normals, map) {
  for (let t = 0; t < index.length; t += 3) {
    const a = map ? map[index[t]] : index[t], b = map ? map[index[t + 1]] : index[t + 1], c = map ? map[index[t + 2]] : index[t + 2]
    const ax = positions[3 * a], ay = positions[3 * a + 1], az = positions[3 * a + 2]
    const ux = positions[3 * b] - ax, uy = positions[3 * b + 1] - ay, uz = positions[3 * b + 2] - az
    const vx = positions[3 * c] - ax, vy = positions[3 * c + 1] - ay, vz = positions[3 * c + 2] - az
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    for (const v of [a, b, c]) { normals[3 * v] += nx; normals[3 * v + 1] += ny; normals[3 * v + 2] += nz }
  }
}

function normalizeAll(normals) {
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1
    normals[i] /= l; normals[i + 1] /= l; normals[i + 2] /= l
  }
}

// What the cloth collides with: the body from the ankles up (where it's cut off, the open edge confuses the
// collision field around it, so it's kept well below any hem), without the hands past their heel (a cuff
// sits at the most that far over the hand, see Drape#stayOnArms; the fingers would catch the cloth), and the
// display mannequin's egg in place of the head.
// bodyCount: how many of the vertices are the body's own (the rest, garments under the cloth, all count).
// arms: false for pants (hands rest on the outside of them; an arm coming down into a pose would trap the
// cloth against the hips).
function nearHand(frame, p, at) {
  for (const side of ["L", "R"]) {
    const arm = frame.arms[side]
    const { t, distance } = arm.locate([p[at], p[at + 1], p[at + 2]])
    if (t > arm.lengths[1] * ELBOW_UP && distance < HAND_CLEAR) return true
  }
  return false
}
const HAND_CLEAR = 0.07
// From a little above the elbow: an arm hanging at the side lies against the clothes under a jacket from
// there down (the elbow at the waist, the forearm by the hip), and held off them the jacket's sleeve is
// pushed up the arm as the arms come down into the pose, and bunches its hem at that side.
const ELBOW_UP = 0.75
const HAND_HEEL = 0.06   // m past the wrist: the heel of the hand, which a cuff can rest on

// bottoms: which of the worn-under points are pants or a skirt (null: all of them), the layers field's.
// sleeves: which are a top's sleeves (null: none), left out.
export function collisionBody(body, frame, egg, bodyCount = body.positions.length / 3, { arms = true, bottoms = null, sleeves = null } = {}) {
  const n = body.positions.length / 3
  const keep = new Uint8Array(n), worn = new Uint8Array(n)
  const knee = frame.floor + 0.1
  for (let i = 0; i < n; i++) {
    const p = body.positions
    if (p[3 * i + 1] < knee) continue
    if (i >= bodyCount) {
      worn[i] = !bottoms || bottoms[i] ? 1 : 0
      // A top's sleeves under a jacket's: the jacket's lie on the arm as if they weren't there (the top's are
      // hidden under them, see coveredPoints). Collided with, they make pockets at the armpits that catch the
      // jacket's sleeves as the arms come down, and fold them across the chest.
      if (sleeves?.[i]) continue
      // What's worn under: not right by the arms from the elbow down, where a sleeve hangs beside the waist
      // and thigh; the clothes there would push it up the arm and the cuff off the wrist (see ELBOW_UP). A
      // sleeve may lie against them a little instead.
      if (arms && nearHand(frame, p, 3 * i)) continue
      keep[i] = 1
      continue
    }
    if (egg && body.head && body.head[i] > 0.5) continue
    const part = frame.part[i]
    if (part === 1 || part === 2) {
      if (!arms) continue
      const arm = frame.arms[part === 1 ? "L" : "R"]
      if (arm.locate([p[3 * i], p[3 * i + 1], p[3 * i + 2]]).t > arm.lengths[2] + HAND_HEEL) continue
    }
    keep[i] = 1
  }
  const field = new SkinField(body.positions, body.normals, body.index, { keep, ellipsoids: egg ? [egg] : [] })
  // What's worn under on its own, as well (the pants under a top), all of it, by the hands too: the field
  // above leaves the pants out beside the hands (for the sleeves' cuffs), and in it the nearer surface wins,
  // so a sweatshirt's sides that slip in between the pants and the hips there read as just outside the skin
  // and stay, the pants showing through. Alone, the pants' field has them inside the pants, and the drape
  // puts the garment's body (not its sleeves) back over them (see Drape#collide). Only pants and skirts: a
  // top's own field (a hoodie's, under a jacket) is no solid, its hood a pocket and its sleeves tubes, and in
  // it a jacket's points read as inside and are thrown about.
  if (worn.some(Boolean)) field.layers = new SkinField(body.positions, body.normals, body.index, { keep: worn, strict: true })
  return field
}

// The look of a style in a shop's fabric: the drape's cloth is the style's, the surface the fabric's when it
// says something different (a denim shirt, a nylon bomber).
function surfaceFor(style, fabric) {
  // A dress's own cloth (see GarmentImport::DressCut): leather, silk, stretch or jersey.
  if (style === "dress" && ["stretch", "jersey", "structured"].includes(fabric)) return fabric
  // Silk and leather look like themselves on any top (a silk shirt, a leather tee).
  if (fabric === "silk" || (fabric === "leather" && style !== "zip" && style !== "bomber")) return fabric
  // Knitwear's own knit: a sweater's, or anything the listing calls a knit (a sweater hoodie, a knit zip-up).
  if (fabric === "knit") return "rib"
  if (STYLES[style]?.surface && !["silk", "leather", "nylon"].includes(fabric)) return STYLES[style].surface
  const own = STYLES[style]?.fabric ?? "jersey"
  if (fabric === "denim") return "twill"
  if (fabric === "linen") return "matte"
  if (fabric === "nylon" || fabric === "leather") return "shell"
  // A zip-up or bomber in cotton or fleece is a sweat or a cotton twill, not a glossy nylon shell.
  if (own === "shell" && fabric === "fleece") return "fleece"
  if (own === "shell" && fabric === "cotton") return "twill"
  if (fabric === "wool" && own !== "shell") return own === "jersey" ? "jersey" : "wool"
  return own
}

// How pants look: jeans in denim twill, joggers in fleece, leggings in a fine stretch knit, the rest in
// their shop's fabric (a nylon pant in a matte weave, wool in wool, cotton in twill).
function bottomSurface(style, fabric) {
  if (style === "leggings") return "stretch"
  if (style === "joggers") return fabric === "nylon" ? "matte" : "fleece"
  if (style === "jeans" || fabric === "denim") return "twill"
  if (fabric === "nylon" || fabric === "linen") return "matte"
  if (fabric === "wool") return "wool"
  if (fabric === "leather") return "leather"
  if (fabric === "silk") return "silk"
  return BOTTOM_STYLES[style]?.fabric === "fleece" ? "fleece" : "twill"
}

// How far round (m) a snug pant hem can stretch: a rib cuff a long way, a stretch knit (leggings) a little.
// Null for a woven hem, which tilts to rest on the instep and drops behind the heel.
function snugRound(style, pattern) {
  const cuff = BOTTOM_STYLES[style]?.cuff
  const m = pattern.measures
  if (cuff) return (m.opening * cuff.stretch * 1.4) / 100
  return pattern.fabric === "stretch" ? (m.opening * 1.1) / 100 : null
}

// A tucked top ends this far (cm) below the waistband's seam, inside the pants, and below the top of the
// waistband is held this close (m) round the body, gathered as tucking gathers it: closer than any pants
// sit (see drape.js's CLOTHS), so they cover it.
const TUCK_DEPTH = 10
const TUCK_ROOM = 0.004
const TUCK_HIDDEN = 0.02    // m below the tuck's top that a tucked top stops being drawn
const RIM_SHOWN = 0.002     // and is drawn only from this far above the pants' waistband's top, as it lies

// The height of a ring of [angle, height] pairs (sorted by angle) at an angle, between its neighbours.
function rimAt(rim, angle) {
  let k = rim.findIndex(([a]) => a >= angle)
  if (k < 0) k = rim.length
  const [a0, y0] = rim[(k - 1 + rim.length) % rim.length], [a1, y1] = rim[k % rim.length]
  let span = a1 - a0, at = angle - a0
  if (span <= 0) span += 2 * Math.PI
  if (at < 0) at += 2 * Math.PI
  return y0 + (y1 - y0) * Math.min(Math.max(at / span, 0), 1)
}
// The tops that tuck in.
// (Not a tank top: with nothing over the arms to hold it, gathered into the pants it slides down inside them.)
export const TUCKABLE = ["tee", "longsleeve", "polo", "rugby", "shirt", "shortshirt"]

// The wearer as pants are drafted for them: their measurements, the body's, and from the crotch up to the
// natural waist (about at the navel).
function bottomWearer(measures, frame) {
  const rise = (frame.hps[1] - (measures.height ?? 175) * 0.00235 - frame.crotch) * 100
  return { ...measures, ...frame.measures, rise, riseFor: frame.torso ? round => riseFor(frame, rise, round) : null }
}

// Where pants or a skirt sit on this body (heights in m): their waistband's seam and its top at the sides,
// and how much higher it rises at the middle of the back (see pants.js's legPiece).
export function waistband(item, frame, measures) {
  const wearer = bottomWearer(measures, frame)
  const skirt = item.style === "skirt"
  const m = skirt ? draftBottoms("skirt", item.size, wearer, item.cut ?? null).measures : bottomMeasures(item.style, item.size, wearer, item.cut ?? null)
  const seam = frame.crotch - 0.015 + m.rise / 100
  return { seam, top: seam + m.band / 100, raise: skirt ? 0 : BACK_RAISE / 100 }
}

// One top on the mannequin: drafted, sewn and settled a few frames at a time.
// item: { style, size (cm), color, fabric, tuck }. tuck: the pants it's tucked into ({ style, size, cut }),
// or none. body: bodySnapshot; frame: bodyFrame of it; field: its collision field; measures: the wearer in
// cm (for the parts a chart doesn't give).
// Where a dress is cut out and where it's sheer, as its listing says ("cut-outs on the shoulder", "open back",
// "sheer sleeves"): per pattern point, how far inside a cut-out it is (cm, above 0 inside; the shader leaves
// those out, with a smooth edge between points), and whether it's sheer (1). On the pattern: x across from the
// middle, y down from the shoulder (cm), each piece its own.
export function dressDetails(item, pattern, cloth) {
  const n = cloth.points.length
  const hole = new Float32Array(n).fill(-1), sheer = new Float32Array(n)
  const cut = item.cut
  if (!cut || item.kind === "trousers") return { hole, sheer }
  const m = pattern.measures
  const waistAt = m.shaped?.waistAt ?? m.length * 0.55
  const halfWaist = (m.shaped?.waist ?? m.chest) / 4, halfChest = m.chest / 4
  const armhole = m.armhole
  // Each cut-out: [pieces, x (both sides when mirrored), y, half width, half height].
  const holes = []
  for (const place of cut.cutouts ?? []) {
    if (place === "waist") holes.push([["front"], halfWaist * 0.68, -waistAt, 3, 5.5, true])
    if (place === "sides") holes.push([["front", "back"], halfWaist * 0.86, -(armhole + waistAt) / 2 - 2, 3, 8, true])
    if (place === "back") {
      const top = armhole * 0.45, bottom = waistAt - 4
      holes.push([["back"], 0, -(top + bottom) / 2, halfChest * 0.42, (bottom - top) / 2, false])
    }
    if (place === "front") holes.push([["front"], 0, -(m.frontNeck + 5), 2.5, 4, false])
    if (place === "shoulders") holes.push([["sleeve_L", "sleeve_R"], 0, -7, m.bicep * 0.22, 5, false])
  }
  for (let i = 0; i < n; i++) {
    const piece = cloth.panels[cloth.panel[i]]
    const [x, y] = cloth.points[i]
    for (const [pieces, cx, cy, rx, ry, mirrored] of holes) {
      if (!pieces.includes(piece)) continue
      const dx = (mirrored ? Math.abs(x) : x) - cx, dy = y - cy
      // A rounded rectangle more than an oval (an open back is cut square at its sides).
      const p = 2.6, d = (1 - Math.pow(Math.pow(Math.abs(dx / rx), p) + Math.pow(Math.abs(dy / ry), p), 1 / p)) * Math.min(rx, ry)
      hole[i] = Math.max(hole[i], d)
    }
    const sleeve = /^sleeve/.test(piece), body = piece === "front" || piece === "back"
    const zone = cut.sheer
    if (zone === "all" || (zone === "sleeves" && sleeve) || (zone === "back" && piece === "back") ||
        (zone === "sides" && body && Math.abs(x) > halfWaist * 0.6) || (zone === "skirt" && body && y < -waistAt - 4)) sheer[i] = 1
  }
  return { hole, sheer }
}

// Which points of an inner garment poke out through one worn over it: within `reach` (m) of the outer cloth
// and no nearer the body than it (less `gap`). inner, outer: DrapedTops as they're draped now; field: the
// body as the inner garment was draped on (its skin distance). Returns a Float32Array, 1 where covered.
// Which points of an inner garment poke out through one worn over it: within `reach` (m) of the outer cloth
// and not behind its surface (along its outward normal, less `gap`). inner, outer: DrapedTops as they're
// draped now (their meshes up to date). Returns a Float32Array, 1 where covered.
// How far (m) past an inner point the outer cloth must carry on for the point to count as covered.
const EDGE_MARGIN = 0.008
// How far to one side of the nearest outer cloth (m) a point may be and still count as poking through it.
const SIDEWAYS = 0.012

function freeDistance(outer, b) {
  const n = b.length / 3, out = new Float32Array(n).fill(Infinity)
  const edge = [...new Set((outer.cloth.free ?? []).flat())]
  for (let j = 0; j < n; j++) {
    let best = Infinity
    for (const e of edge) {
      const d = (b[3 * j] - b[3 * e]) ** 2 + (b[3 * j + 1] - b[3 * e + 1]) ** 2 + (b[3 * j + 2] - b[3 * e + 2]) ** 2
      if (d < best) best = d
    }
    out[j] = Math.sqrt(best)
  }
  return out
}

const SLEEVE_TOP = 16   // cm down a sleeve from the top of its cap
export function coveredPoints(inner, outer, { reach = 0.035, gap = 0.003 } = {}) {
  const field = outer.drape.field
  const a = inner.geometry.attributes.position.array
  const b = outer.geometry.attributes.position.array, normals = outer.geometry.attributes.normal.array
  const cell = reach, grid = new Map()
  const key = (x, y, z) => `${x},${y},${z}`
  // Not near the outer garment's edges (an open front, a hem, a cuff): what shows past them is meant to.
  // How far (m) each point of the outer garment is from its nearest free edge (a hem, a cuff, an open
  // front), as it hangs: across its seams too (a body panel's bottom is a rib's height from the hem).
  const free = freeDistance(outer, b)
  // Each piece covers its own part of the inner garment: a sleeve the sleeve under it, the body the body
  // (and pants). A sleeve hanging beside the hip doesn't cover the pants: the pants there are seen past it.
  const partOf = (cloth, i) => {
    const name = cloth.panels?.[cloth.panel?.[i]] ?? ""
    return /^(sleeve|cuff)/.test(name) ? (name.endsWith("_L") ? 1 : 2) : /^hood/.test(name) ? 3 : 0
  }
  const nb = b.length / 3
  const outerPart = Uint8Array.from({ length: nb }, (_, j) => partOf(outer.cloth, j))
  for (let j = 0; j < nb; j++) {
    if (free[j] < 0.008) continue
    const k = key(Math.floor(b[3 * j] / cell), Math.floor(b[3 * j + 1] / cell), Math.floor(b[3 * j + 2] / cell))
    let list = grid.get(k)
    if (!list) grid.set(k, (list = []))
    list.push(j)
  }
  const na = a.length / 3, covered = new Float32Array(na)
  for (let i = 0; i < na; i++) {
    const x = a[3 * i], y = a[3 * i + 1], z = a[3 * i + 2]
    const part = partOf(inner.cloth, i)
    // The top of a sleeve under a jacket's is under the jacket's shoulder too (the jacket's sleeves lie on
    // the arm as if it weren't there, see collisionBody, so its cap can show through the shoulder).
    const cap = (part === 1 || part === 2) && inner.cloth.points?.[i]?.[1] > -SLEEVE_TOP
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell)
    let nearest = Infinity, near = -1
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const j of grid.get(key(cx + dx, cy + dy, cz + dz)) ?? []) {
        if (outerPart[j] !== part && !(cap && outerPart[j] === 0)) continue
        const d = (b[3 * j] - x) ** 2 + (b[3 * j + 1] - y) ** 2 + (b[3 * j + 2] - z) ** 2
        if (d < nearest) { nearest = d; near = j }
      }
    }
    if (near < 0 || nearest > reach * reach) continue
    // Only where the outer cloth carries on past this point: the nearest of it may be up to `reach` away,
    // and just under a hem that's cloth above it, not over it (hidden there, the pants show the body).
    // The further the outer cloth is from the point, the further in from its edge it must be: under a hem
    // that lifts away (a hoodie's front, over its pocket), the cloth seen beneath it is meant to show.
    if (free[near] < 2 * Math.sqrt(nearest) + EDGE_MARGIN) continue
    // The outer cloth's normal, turned to face away from the body (a piece's normals may face either way).
    let nx = normals[3 * near], ny = normals[3 * near + 1], nz = normals[3 * near + 2]
    if (field) {
      field.at(b[3 * near], b[3 * near + 1], b[3 * near + 2])
      const h = field.hit
      if (nx * h[0] + ny * h[1] + nz * h[2] < 0) { nx = -nx; ny = -ny; nz = -nz }
    }
    const out = (x - b[3 * near]) * nx + (y - b[3 * near + 1]) * ny + (z - b[3 * near + 2]) * nz
    // Straight out through the outer cloth, not off past it to one side (below a hem that ends there).
    const aside = Math.sqrt(Math.max(0, nearest - out * out))
    if (out > -gap && aside < SIDEWAYS) covered[i] = 1
  }
  return covered
}

// A garment's pattern drafted for its size, cut into cloth, placed round the body and set up to be sewn
// and draped: everything the 3D view's DrapedTop needs bar what draws it, so it can run where nothing is
// drawn (in a Web Worker, see drape_worker.js). Returns { bottoms, pattern, cloth, drape, steps (the
// drape's phases, a generator), expected (about how many frames it takes) }.
export function sewingFor({ item, body, frame, field, measures }) {
  const bottoms = item.kind === "trousers"
  const wearer = bottoms ? bottomWearer(measures, frame) : { ...measures, ...frame.measures }
  // Tucked in, a top is cut off a little below the waistband (the rest would be hidden in the pants) and
  // gathered round the body from the top of the waistband down.
  let size = item.size, tuck = null
  if (!bottoms && item.tuck) {
    const band = waistband(item.tuck, frame, measures)
    size = { ...size, length: Math.min(size.length ?? Infinity, (frame.hps[1] - band.seam) * 100 + TUCK_DEPTH) }
    // Up to just over the waistband's top, so the cloth comes out of it there; higher at the back, as the
    // back of the pants rises over the seat. A stretch top (a bodysuit) isn't pressed in, only cut short and
    // hidden in the pants: it already lies on the body, with nothing to gather, and pressed in further it
    // slides down off the shoulders.
    tuck = { table: frame.torso, top: band.top + 0.003, raise: band.raise, inside: TUCK_ROOM, press: !item.cut?.stretch }
  }
  // A top that zips down the front (a zip hoodie) is drafted with that closure, so the zip is drawn on it.
  const cut = item.zip && !bottoms ? { ...(item.cut ?? {}), closure: "zip" } : item.cut ?? null
  const pattern = bottoms ? draftBottoms(item.style, size, wearer, cut) : draftTop(item.style, size, wearer, cut)
  const cloth = buildCloth(pattern, bottoms ? BOTTOM_SPACING : SPACING)
  const { positions, attach } = placeCloth(cloth, pattern, frame)
  // A skirt hangs round both legs; pants go round each.
  const envelope = bottoms && item.style !== "skirt" ? null : { table: frame.torso, top: frame.crotch + 0.03, bottom: frame.floor }
  // A dress held up by straps or round the bust grips where it rests (as straps and boning do, rather than
  // sliding off the shoulders' slope); pants grip at the waist; others slide over the body as usual.
  const holds = ["strapless", "one_shoulder", "straps", "thin_straps", "none"].includes(item.cut?.sleeves)
  // Pants' waist: the top edges of the leg pieces, as long round as the pants' waist.
  const ring = bottoms ? {
    points: Object.entries(cloth.edges).filter(([key]) => /^(front|back)(_[LR])?\/waist$/.test(key)).flatMap(([, idx]) => idx),
    length: pattern.measures.waist / 100
  } : null
  const drape = new Drape(cloth, positions, { ...body, field }, {
    // A coat slides down over the clothes under it as it's sewn (held by them as a top is by skin, it'd
    // hang caught on them, short).
    fabric: pattern.fabric, envelope, attach, friction: holds ? 0.12 : item.style === "coat" ? 0.05 : 0.7, ring,
    // Pants, and a dress or coat long enough to reach it, rest on the floor (a gown's hem carries its weight
    // there, rather than pulling it off the shoulders).
    floor: bottoms || item.style === "dress" || item.style === "coat" ? frame.floor + 0.004 : null,
    feet: bottoms && item.style !== "skirt" ? frame.feet : null,
    snug: bottoms && item.style !== "skirt" ? snugRound(item.style, pattern) : null,
    tuck,
    // A long hem (pants, skirts, dresses) keeps a smooth edge, but the strip above it is no stiffer than
    // the rest: stiffened, it rolls out like a cuff and flicks up at the side seams.
    hemStrip: !bottoms && item.style !== "dress",
    // A top's sleeves stop at the hands (a sleeve longer than the arm gathers above its cuff).
    arms: bottoms ? null : frame.arms
  })
  // A long garment (a dress, pants) has further to fall, so it settles for longer.
  const long = pattern.style === "dress" || pattern.measures.length > 85
  // Pants are sewn without gravity (nothing holds them up until they're closed), then fall straight under
  // a heavier pull for a moment (a stretch knit or a rib cuff would be stretched by it, and spring back
  // crumpled); a skirt is laid on with its sides together, so it's closed as it's placed (see phases' weld),
  // eases a moment and hangs from its waistband.
  const skirt = bottoms && item.style === "skirt"
  const phases = skirt ? { settleFrames: 280, calmFrames: 60, relaxFrames: 12, weld: true }
    : bottoms ? { settleFrames: long ? 240 : 160, calmFrames: 60, sewGravity: 0, heavyFrames: drape.snug ? 0 : 60 }
    : long ? { settleFrames: 280, calmFrames: 60, sewGravity: holds ? 0 : 0.4, heavyFrames: item.style === "coat" ? 60 : 0 } : { settleFrames: 140, calmFrames: 45 }
  const steps = drape.phases(phases)
  // About how many steps the drape takes (sewing stops when the seams close, so it's a guess), for a
  // progress bar.
  const expected = (phases.relaxFrames ?? 0) + (phases.heavyFrames ?? 0) + phases.settleFrames + (bottoms ? 300 : 70)
  return { bottoms, pattern, cloth, drape, steps, expected }
}

export class DrapedTop {
  constructor({ item, body, frame, field, measures, renderer }) {
    this.item = item
    const sewing = sewingFor({ item, body, frame, field, measures })
    this.bottoms = sewing.bottoms
    this.pattern = sewing.pattern
    this.cloth = sewing.cloth
    this.drape = sewing.drape
    this.steps = sewing.steps
    this.frames = 0
    this.expected = sewing.expected
    this.phase = "sewing"
    this.done = false
    this.frame = frame
    this.field = field
    this.triangles = Uint32Array.from(this.cloth.triangles.flat())
    this.geometry = this.makeGeometry()
    this.materials = this.makeMaterials(renderer)
    this.mesh = new THREE.Mesh(this.geometry, [this.materials.main, this.materials.rib])
    this.mesh.castShadow = this.mesh.receiveShadow = true
    this.mesh.frustumCulled = false
    this.update()
  }

  // Runs the drape for up to `budget` milliseconds. Returns true while there's more to do. Sewn in a worker
  // (this.remote, remote_drape.js's job), it takes the worker's newest points instead.
  advance(budget = 10) {
    if (this.done) return false
    // (The worker failed: it's sewn here, from where it got to.)
    if (this.remote?.failed) this.remote = null
    const remote = this.remote
    if (remote) {
      if (remote.x) {
        // The seams closed there (the cloth's points joined into one piece): the same here, so the points line up.
        if (remote.x.length !== this.drape.x.length && !this.drape.sewn) {
          this.drape.releaseBands()
          this.drape.closeSeams()
        }
        // (They don't: something differs between the two; it's sewn here instead.)
        if (remote.x.length !== this.drape.x.length) {
          remote.failed = true
          console.warn("[drape] the worker's cloth doesn't match the page's; draping it here")
          return this.advance(budget)
        }
        this.drape.x.set(remote.x)
        this.drape.frame = remote.frame
        this.frames = remote.frames
        this.phase = remote.phase
        remote.x = null
        if (remote.sewn) {
          this.done = true
          this.shade()
        }
        this.update()
      }
      return !this.done
    }
    const end = performance.now() + budget
    do {
      const next = this.steps.next()
      if (next.done) {
        this.done = true
        this.shade()
        break
      }
      this.phase = next.value
      this.frames++
    } while (performance.now() < end)
    this.update()
    return !this.done
  }

  // How far along the drape is, 0 to 1 (an estimate until it's done).
  progress() {
    return this.done ? 1 : Math.min(0.97, this.frames / this.expected)
  }

  makeGeometry() {
    const { cloth } = this
    const n = cloth.points.length
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3 * n), 3).setUsage(THREE.DynamicDrawUsage))
    geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(3 * n), 3).setUsage(THREE.DynamicDrawUsage))
    geometry.setAttribute("uv", new THREE.BufferAttribute(Float32Array.from(cloth.points.flatMap(([x, y]) => [x / 100, y / 100])), 2))
    geometry.setAttribute("aEdge", new THREE.BufferAttribute(Float32Array.from(cloth.toEdge), 1))
    geometry.setAttribute("aHem", new THREE.BufferAttribute(Float32Array.from(cloth.toFree, d => Math.min(d, 99)), 1))
    const front = cloth.panels.indexOf("front"), back = cloth.panels.indexOf("back")
    const sleeveL = cloth.panels.indexOf("sleeve_L"), sleeveR = cloth.panels.indexOf("sleeve_R")
    geometry.setAttribute("aPiece", new THREE.BufferAttribute(Float32Array.from(cloth.panel, p => (p === front ? 1 : p === back ? 2 : p === sleeveL ? 3 : p === sleeveR ? 4 : 0)), 1))
    geometry.setAttribute("aShade", new THREE.BufferAttribute(new Float32Array(n).fill(1), 1))
    geometry.setAttribute("aHide", new THREE.BufferAttribute(new Float32Array(n).fill(-1), 1))
    geometry.setAttribute("aPhoto", new THREE.BufferAttribute(new Float32Array(3 * n), 3))
    // A dress's cut-outs and sheer parts, from its listing (see dressDetails).
    const { hole, sheer } = dressDetails(this.item, this.pattern, cloth)
    geometry.setAttribute("aHole", new THREE.BufferAttribute(hole, 1))
    geometry.setAttribute("aSheer", new THREE.BufferAttribute(sheer, 1))
    geometry.setAttribute("aCover", new THREE.BufferAttribute(new Float32Array(n), 1))
    geometry.setAttribute("aStrain", new THREE.BufferAttribute(new Float32Array(n), 1))
    geometry.setAttribute("aDown", new THREE.BufferAttribute(this.bottoms ? new Float32Array(n) : heightsDown(cloth, this.pattern), 1))
    geometry.setAttribute("aAcross", new THREE.BufferAttribute(this.bottoms ? new Float32Array(n) : widthsAcross(cloth, this.pattern), 1))
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(3 * n).fill(0.85), 3))
    // The cloth's own fabric first, then rib (cuffs, collars, waistbands): one material each.
    const rib = cloth.panelFabric.map(f => f === "rib")
    const main = [], ribbed = []
    for (const [a, b, c] of cloth.triangles) (rib[cloth.panel[a]] ? ribbed : main).push(a, b, c)
    geometry.setIndex([...main, ...ribbed])
    geometry.addGroup(0, main.length, 0)
    geometry.addGroup(main.length, ribbed.length, 1)
    return geometry
  }

  makeMaterials(renderer) {
    const { item, pattern } = this
    const surface = this.bottoms ? bottomSurface(item.style, item.fabric) : item.puffer ? "puffer" : surfaceFor(item.style, item.fabric)
    const knit = ["jersey", "fleece", "rib"].includes(surface)
    const details = {
      stitch: knit ? "hem" : "topstitch", closure: pattern.closure, pocket: item.style === "hoodie" ? "kangaroo" : null,
      neckDepth: pattern.measures.frontNeck, length: pattern.measures.length,
      // How much of a sheer cloth's colour shows: most of it, semi-sheer (it reads as the cloth's colour in a
      // photo, the skin only hinted); less, sheer; but a printed sheer one's print is what's seen.
      sheer: item.cut?.sheer ? (item.cut.sheer_kind === "semi" ? 0.9 : item.cut.printed ? 0.82 : 0.65) : 1,
      // A puffer's quilted baffles (see fabric.js's QUILT).
      quilt: Boolean(item.puffer)
    }
    return {
      main: clothMaterial({ color: item.color, cloth: surface, details, renderer }),
      rib: clothMaterial({ color: item.color, cloth: knit ? "rib" : surface, details: {}, renderer }),
      fitMain: clothMaterial({ color: "#ffffff", cloth: surface, details, fitMap: true, renderer }),
      fitRib: clothMaterial({ color: "#ffffff", cloth: knit ? "rib" : surface, fitMap: true, renderer })
    }
  }

  // Points a garment over this one covers (see coveredPoints), left undrawn; null shows them all.
  setCovered(covered) {
    const attribute = this.geometry.attributes.aCover
    if (covered) attribute.array.set(covered)
    else attribute.array.fill(0)
    attribute.needsUpdate = true
  }

  setColor(color) {
    for (const key of ["main", "rib"]) {
      this.materials[key].color.set(color)
      this.materials[key].sheenColor.copy(sheenTint(color))
      this.materials[key].userData.uniforms.uThread.value.set(color).offsetHSL(0, 0, 0.07)
    }
  }

  // A print from the shop's photo (print.js's readPhoto; null for none), laid on the front; and back: the
  // shop's photo of the back, read the same way ({ image }; null for none), laid on the back. A plain tee
  // can have a print on its back only.
  setPrint(print, back = null) {
    if (this.bottoms) print = back = null   // a print is read off a top's front and back
    if (print?.image === this.printImage && back?.image === this.backImage) return
    this.printImage = print?.image ?? null
    this.backImage = back?.image ?? null
    for (const texture of [this.printTexture, this.tileTexture, this.backTexture]) texture?.dispose()
    this.printTexture = this.tileTexture = this.backTexture = null
    const uniforms = this.materials.main.userData.uniforms
    const m = this.pattern.measures
    const band = this.pattern.panels.waistband ? Math.max(...this.pattern.panels.waistband.edges.flatMap(e => e.points).map(p => Math.abs(p[1]))) : 0
    // The photo shows one size (the shop's sample, about the middle of its chart): a print is that size on
    // every size, not stretched with the cloth, so it stays where it is on a bigger shirt, with more cloth
    // round it. photoSize: { chest, length } of that size (its chart's length, to the bottom of the hem band);
    // the drafted one's when not known (the body's length, which stops where the band starts).
    const shown = this.item.photoSize ?? { chest: m.chest, length: m.length + band }
    uniforms.uPrintHalf.value = shown.chest / 4
    uniforms.uPrintLength.value = shown.length
    const texture = (canvas, wrap = false) => {
      const t = new THREE.CanvasTexture(canvas)
      t.colorSpace = THREE.SRGBColorSpace
      t.anisotropy = 4
      if (wrap) t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping
      return t
    }
    const striped = Boolean(print?.strip)
    if (print) {
      this.printTexture = uniforms.uPrint.value = texture(print.image)
      // An all-over print goes on the back, sleeves and collar too: its cloth, mirrored at its edges so the
      // repeats meet without a seam.
      if (print.tile && !striped) {
        this.tileTexture = uniforms.uPrintTile.value = texture(print.tile.image, true)
        const front = shown.chest / 2   // the front's width (cm), which the photo's front spans
        uniforms.uTile.value.set(print.tile.across * front, print.tile.down * front, print.tile.from * front)
      }
      // Stripes go on every piece (the cuffs and hem too) by height down the garment, so they run on round
      // the body and meet the sleeves' at the shoulder seams (see heightsDown); vertical ones by how far
      // across it each piece is (see widthsAcross), repeated mirrored past the photo's front, so a bigger
      // size's wider back carries on striped without a jump.
      if (striped) {
        this.tileTexture = texture(print.strip)
        this.tileTexture.generateMipmaps = false
        this.tileTexture.minFilter = THREE.LinearFilter
        if (print.vertical) this.tileTexture.wrapS = THREE.MirroredRepeatWrapping
      }
    }
    if (back) this.backTexture = uniforms.uBack.value = texture(back.image)
    uniforms.uPrintOn.value = print ? 1 : 0
    uniforms.uAllOver.value = print?.tile && !striped ? 1 : 0
    uniforms.uBackOn.value = back ? 1 : 0
    for (const key of ["main", "rib"]) {
      const u = this.materials[key].userData.uniforms
      u.uStripeOn.value = striped ? 1 : 0
      u.uStripeLength.value = uniforms.uPrintLength.value * (print?.stripSpan ?? 1)
      const across = print?.vertical ? print.stripAcross ?? { from: 0, span: 1 } : null
      u.uStripeAcross.value.set(across ? 1 : 0, shown.chest / 4, across?.from ?? 0, across?.span ?? 1)
      if (striped) u.uStripe.value = this.tileTexture
    }
  }

  // Graphics on the sleeves from the shop's photos: { right: { front, back }, left: { front, back } }, each a
  // canvas (print.js's sleevePrint, by the wearer's side) or null; null for none. Laid down each sleeve from
  // the top of its cap to its hem, across from its top line to the underarm seam.
  setSleeves(sleeves) {
    if (this.bottoms || !this.pattern.panels.sleeve_R) sleeves = null
    const parts = [sleeves?.right?.front, sleeves?.left?.front, sleeves?.right?.back, sleeves?.left?.back].map(c => c ?? null)
    if (this.sleeveCanvases && parts.every((c, i) => c === this.sleeveCanvases[i])) return
    this.sleeveCanvases = parts
    this.sleeveTexture?.dispose()
    this.sleeveTexture = null
    const u = this.materials.main.userData.uniforms
    const m = this.pattern.measures
    if (parts.some(Boolean)) {
      // The four strips side by side in one texture (see fabric.js's uSleeves).
      const width = Math.max(...parts.map(c => c?.width ?? 0)), height = Math.max(...parts.map(c => c?.height ?? 0))
      const atlas = document.createElement("canvas")
      atlas.width = 4 * width
      atlas.height = height
      const context = atlas.getContext("2d")
      parts.forEach((canvas, i) => { if (canvas) context.drawImage(canvas, i * width, 0, width, height) })
      const t = this.sleeveTexture = new THREE.CanvasTexture(atlas)
      t.colorSpace = THREE.SRGBColorSpace
      t.generateMipmaps = false
      t.minFilter = THREE.LinearFilter
    }
    u.uSleeves.value = this.sleeveTexture ?? BLANK_TEXTURE
    u.uSleeveHave.value.set(...parts.map(c => (c ? 1 : 0)))
    u.uSleeveSize.value.set((m.bicep ?? 32) / 2, (m.opening ?? (m.bicep ?? 32) - 3) / 2, m.sleeve ?? 60)
    u.uSleeveOn.value = parts.some(Boolean) ? 1 : 0
  }


  // Pants' or a skirt's shop photo (print.js's readBottomPhoto: { image, soft, layout }; null for none),
  // laid on the cloth: the photo on the front, its softened copy on the back.
  setPhotoMap(map) {
    if (!this.bottoms) map = null
    if (map?.image === this.photoImage) return
    this.photoImage = map?.image ?? null
    for (const texture of this.photoTextures ?? []) texture.dispose()
    this.photoTextures = []
    if (map) {
      const uv = bottomsPhotoUV(this.cloth, this.pattern, map.layout, map.back?.layout ?? null)
      this.geometry.attributes.aPhoto.array.set(uv)
      this.geometry.attributes.aPhoto.needsUpdate = true
      this.photoTextures = [map.image, map.soft, map.back?.image ?? map.soft].map(canvas => {
        const texture = new THREE.CanvasTexture(canvas)
        texture.colorSpace = THREE.SRGBColorSpace
        texture.anisotropy = 8
        return texture
      })
    }
    for (const key of ["main", "rib"]) {
      const uniforms = this.materials[key].userData.uniforms
      uniforms.uPhoto.value = this.photoTextures[0] ?? uniforms.uPhoto.value
      uniforms.uPhotoSoft.value = this.photoTextures[1] ?? uniforms.uPhotoSoft.value
      uniforms.uPhotoBack.value = this.photoTextures[2] ?? uniforms.uPhotoBack.value
      uniforms.uPhotoOn.value = map ? 1 : 0
    }
  }

  setFitMap(on) {
    this.mesh.material = on ? [this.materials.fitMain, this.materials.fitRib] : [this.materials.main, this.materials.rib]
  }

  // Positions and normals from the drape. Normals are worked out on the joined cloth, so they run smoothly
  // across the seams.
  update() {
    const { drape, geometry } = this
    const map = drape.map
    const position = geometry.attributes.position.array, normal = geometry.attributes.normal.array
    const x = drape.x
    const m = x.length / 3
    const acc = this.normalScratch?.length === 3 * m ? this.normalScratch.fill(0) : (this.normalScratch = new Float32Array(3 * m))
    addFaceNormals(x, this.triangles, acc, map)
    normalizeAll(acc)
    const n = this.cloth.points.length
    for (let i = 0; i < n; i++) {
      const j = map ? map[i] : i
      position[3 * i] = x[3 * j]; position[3 * i + 1] = x[3 * j + 1]; position[3 * i + 2] = x[3 * j + 2]
      normal[3 * i] = acc[3 * j]; normal[3 * i + 1] = acc[3 * j + 1]; normal[3 * i + 2] = acc[3 * j + 2]
    }
    geometry.attributes.position.needsUpdate = true
    geometry.attributes.normal.needsUpdate = true
    geometry.computeBoundingSphere()
    if (drape.tuck) this.hideTucked()
    if (this.done) this.markStrain()
  }

  // How squeezed the cloth is at each point (0 to 1): its edges shorter than cut, as at the inside of an
  // elbow, a waist gathered in, the back of a knee. The fabric's surface texture shows deeper there, as
  // fine creases (see fabric.js), where the drape alone is too coarse to fold.
  markStrain() {
    const { drape, cloth, triangles } = this
    const map = drape.map, x = drape.x, pts = cloth.points
    const n = pts.length, squeeze = new Float32Array(n)
    const edge = (a, b) => {
      const rest = Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]) / 100
      if (rest < 1e-4) return
      const ja = map ? map[a] : a, jb = map ? map[b] : b
      const now = Math.hypot(x[3 * ja] - x[3 * jb], x[3 * ja + 1] - x[3 * jb + 1], x[3 * ja + 2] - x[3 * jb + 2])
      const c = 1 - now / rest
      if (c > squeeze[a]) squeeze[a] = c
      if (c > squeeze[b]) squeeze[b] = c
    }
    for (let t = 0; t < triangles.length; t += 3) {
      edge(triangles[t], triangles[t + 1]); edge(triangles[t + 1], triangles[t + 2]); edge(triangles[t + 2], triangles[t])
    }
    const strain = this.geometry.attributes.aStrain
    for (let i = 0; i < n; i++) {
      const t = Math.min(1, Math.max(0, (squeeze[i] - 0.03) / 0.17))
      strain.array[i] = t * t * (3 - 2 * t)
    }
    strain.needsUpdate = true
  }

  // A tucked top isn't drawn from a little below the waistband's top down: it's inside the pants there,
  // pressed so close to the body that, drawn, it would show through them in places.
  hideTucked() {
    this.geometry.attributes.aHide.array.set(this.tuckedAway(this.drape.x, TUCK_HIDDEN, this.rim))
    this.geometry.attributes.aHide.needsUpdate = true
  }

  // Where the pants' waistband's top edge lies (its points, in m), once they're draped: the top isn't drawn
  // below a little under it, wherever the pants settled.
  setRim(points) {
    const table = this.drape.tuck.table
    const rim = points.map(([x, y, z]) => [Math.atan2(x, z - table.centreAt(y)), y]).sort((a, b) => a[0] - b[0])
    this.rim = rim.length >= 8 ? rim : null
    this.hideTucked()
  }

  // How far (m) each pattern point of a tucked top is inside the pants, with the cloth at x (the drape's
  // joined points): above 0 where it's out of sight there, below 0 where it shows, so the line between
  // falls smoothly across the cloth. Null when it isn't tucked. below: how far below the tuck's top (m)
  // that starts.
  // rim: the pants' waistband's top edge ([angle round the body, height] pairs, by angle), to go by instead
  // of where the pants were expected to sit, when they lie lower.
  tuckedAway(x, below = TUCK_HIDDEN, rim = null) {
    const { drape } = this
    if (!drape.tuck) return null
    const { table, top, raise = 0 } = drape.tuck
    const map = drape.map, n = this.cloth.points.length
    const away = new Float32Array(n).fill(-1)
    for (let i = 0; i < n; i++) {
      if (!drape.tucks[i]) continue
      const j = map ? map[i] : i
      const px = x[3 * j], py = x[3 * j + 1], pz = x[3 * j + 2] - table.centreAt(py)
      const angle = Math.atan2(px, pz)
      let line = top - below + raise * Math.max(0, -Math.cos(angle))
      if (rim) line = rimAt(rim, angle) + RIM_SHOWN
      away[i] = line - py
    }
    return away
  }

  // How much of the room each point of the cloth sees: rays out from it over the side it faces, stopped by
  // the cloth itself (its folds, the hood) or the body. Cloth and body are filed in a coarse grid first.
  shade() {
    const { drape, field, geometry } = this
    const x = drape.x, m = x.length / 3
    const cell = 0.015
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < m; i++) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], x[3 * i + c]); hi[c] = Math.max(hi[c], x[3 * i + c]) }
    lo = lo.map(v => v - 0.15); hi = hi.map(v => v + 0.15)
    const dims = lo.map((v, c) => Math.ceil((hi[c] - v) / cell) + 1)
    const solid = new Uint8Array(dims[0] * dims[1] * dims[2])
    const cellOf = (px, py, pz) => {
      const ix = Math.floor((px - lo[0]) / cell), iy = Math.floor((py - lo[1]) / cell), iz = Math.floor((pz - lo[2]) / cell)
      if (ix < 0 || iy < 0 || iz < 0 || ix >= dims[0] || iy >= dims[1] || iz >= dims[2]) return -1
      return (iz * dims[1] + iy) * dims[0] + ix
    }
    for (let i = 0; i < m; i++) { const k = cellOf(x[3 * i], x[3 * i + 1], x[3 * i + 2]); if (k >= 0) solid[k] = 1 }
    // The body: grid cells inside it (the field is negative there, within its band).
    for (let iz = 0; iz < dims[2]; iz++) for (let iy = 0; iy < dims[1]; iy++) for (let ix = 0; ix < dims[0]; ix++) {
      if (field.at(lo[0] + (ix + 0.5) * cell, lo[1] + (iy + 0.5) * cell, lo[2] + (iz + 0.5) * cell) < 0) solid[(iz * dims[1] + iy) * dims[0] + ix] = 2
    }
    const normal = this.normalScratch
    const rays = hemisphere(14)
    const shadeJoined = new Float32Array(m)
    for (let i = 0; i < m; i++) {
      const nx = normal[3 * i], ny = normal[3 * i + 1], nz = normal[3 * i + 2]
      // A frame round the normal.
      const ax = Math.abs(nx) < 0.9 ? [1, 0, 0] : [0, 1, 0]
      let tx = ny * ax[2] - nz * ax[1], ty = nz * ax[0] - nx * ax[2], tz = nx * ax[1] - ny * ax[0]
      const tl = Math.hypot(tx, ty, tz); tx /= tl; ty /= tl; tz /= tl
      const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx
      let open = 0, total = 0
      for (const [rx, ry, rz] of rays) {
        const dx = tx * rx + bx * ry + nx * rz, dy = ty * rx + by * ry + ny * rz, dz = tz * rx + bz * ry + nz * rz
        let blocked = 0
        for (let s = 1; s <= 8; s++) {
          const t = 0.012 + s * 0.014
          const k = cellOf(x[3 * i] + dx * t, x[3 * i + 1] + dy * t, x[3 * i + 2] + dz * t)
          if (k >= 0 && solid[k]) { blocked = 1 - (s - 1) / 10; break }
        }
        open += rz * (1 - blocked)
        total += rz
      }
      shadeJoined[i] = 0.35 + 0.65 * (open / total)
    }
    const shade = geometry.attributes.aShade.array
    const map = drape.map
    for (let i = 0; i < shade.length; i++) shade[i] = shadeJoined[map ? map[i] : i]
    geometry.attributes.aShade.needsUpdate = true
  }

  // The fit map: each point coloured by the verdict for the part of the top it's on (checks: the API's for
  // the chosen size; colors: status -> colour), blending between parts.
  paintFit(checks, colors) {
    const status = Object.fromEntries(checks.map(c => [c.part, c.status]))
    const colorOf = part => new THREE.Color(colors[status[part] ?? "unknown"] ?? colors.unknown)
    const parts = { shoulders: colorOf("shoulders"), chest: colorOf("chest"), waist: colorOf("waist"), sleeve: colorOf("sleeve"), length: colorOf("length") }
    const neutral = new THREE.Color("#e4e2dd")
    const m = this.pattern.measures
    const { cloth } = this
    const out = this.geometry.attributes.color.array
    if (this.bottoms) {
      // Pants: the waist (and waistband), the seat, the thigh, then down the leg to the hem (its length).
      const legs = { waist: colorOf("waist"), seat: colorOf("seat"), thigh: colorOf("thigh"), inseam: colorOf("inseam"), leg_opening: colorOf("leg_opening") }
      for (let i = 0; i < cloth.points.length; i++) {
        const name = cloth.panels[cloth.panel[i]]
        const py = cloth.points[i][1]
        const part = name === "waistband" ? "waist" : name.startsWith("cuff") ? "leg_opening"
          : py > -6 ? "waist" : py > -m.rise ? "seat" : py > -(m.rise + m.kneeAt * 0.6) ? "thigh" : py > -(m.length - 10) ? "inseam" : "leg_opening"
        const c = status[part] ? legs[part] : neutral
        out[3 * i] = c.r; out[3 * i + 1] = c.g; out[3 * i + 2] = c.b
      }
      this.geometry.attributes.color.needsUpdate = true
      return
    }
    const mixed = new THREE.Color()
    for (let i = 0; i < cloth.points.length; i++) {
      const name = cloth.panels[cloth.panel[i]]
      const [px, py] = cloth.points[i]
      let weights
      if (name.startsWith("sleeve") || name.startsWith("cuff")) weights = { sleeve: 1 }
      else if (name === "front" || name === "back") {
        const fromHem = py + m.length
        weights = {
          shoulders: Math.abs(px) > m.neckWidth + 1 ? ramp(py, -m.shoulderDrop - 7, -m.shoulderDrop - 2) : 0,
          chest: ramp(py, -m.armhole - 16, -m.armhole - 8) * (1 - ramp(py, -m.shoulderDrop - 6, -m.shoulderDrop - 1) * 0.7),
          waist: ramp(py, -m.armhole - 8, -m.armhole - 16) * ramp(fromHem, 4, 12),
          length: ramp(fromHem, 12, 4)
        }
      } else if (name === "waistband") weights = { length: 1 }
      else weights = {}
      let total = 0
      mixed.setRGB(0, 0, 0)
      for (const [part, w] of Object.entries(weights)) {
        if (w <= 0) continue
        mixed.r += parts[part].r * w; mixed.g += parts[part].g * w; mixed.b += parts[part].b * w
        total += w
      }
      const color = total > 0 ? mixed.multiplyScalar(1 / total) : neutral
      out[3 * i] = color.r; out[3 * i + 1] = color.g; out[3 * i + 2] = color.b
    }
    this.geometry.attributes.color.needsUpdate = true
  }

  dispose() {
    this.printTexture?.dispose()
    this.tileTexture?.dispose()
    this.backTexture?.dispose()
    for (const texture of this.photoTextures ?? []) texture.dispose()
    this.geometry.dispose()
    for (const material of Object.values(this.materials)) {
      material.normalMap?.dispose()
      material.dispose()
    }
  }
}

// 0 below `from`, 1 above `to` (or the other way round when from > to), smooth between.
function ramp(value, from, to) {
  const t = Math.min(Math.max((value - from) / (to - from), 0), 1)
  return t * t * (3 - 2 * t)
}

// Directions over a hemisphere round +z, spread evenly and weighted towards the top (cosine).
function hemisphere(count) {
  const out = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i++) {
    const r = Math.sqrt((i + 0.5) / count), a = i * golden
    out.push([r * Math.cos(a), r * Math.sin(a), Math.sqrt(1 - r * r)])
  }
  return out
}

// The frame and collision field for a body snapshot, with the egg in place of the head. over: snapshots of
// garments already on the body (trousers) for the cloth to lie over as well.
export function prepareBody(body, egg, over = [], { arms = true } = {}) {
  const frame = bodyFrame(body)
  if (egg) frame.head = { centre: egg.centre, rx: egg.radii[0], rz: egg.radii[2], top: egg.centre[1] + egg.radii[1] }
  const merged = merge(body, over)
  // Which merged points are pants or a skirt worn under (clothSnapshot marks them).
  const bottoms = new Uint8Array(merged.positions.length / 3)
  let at = body.positions.length / 3
  const sleeves = new Uint8Array(merged.positions.length / 3)
  for (const o of over) {
    const n = o.positions.length / 3
    if (o.bottoms) bottoms.fill(1, at, at + n)
    if (o.sleeves) sleeves.set(o.sleeves, at)
    at += n
  }
  const field = collisionBody(merged, frame, egg, body.positions.length / 3, { arms, bottoms, sleeves })
  return { frame, field }
}

// One triangle mesh of a body snapshot and others, the body's vertices first.
function merge(body, others) {
  if (others.length === 0) return body
  const all = [body, ...others]
  const count = all.reduce((sum, b) => sum + b.positions.length, 0)
  const positions = new Float32Array(count), normals = new Float32Array(count)
  const index = new Uint32Array(all.reduce((sum, b) => sum + b.index.length, 0))
  let offset = 0, at = 0
  for (const b of all) {
    positions.set(b.positions, offset); normals.set(b.normals, offset)
    for (let k = 0; k < b.index.length; k++) index[at + k] = b.index[k] + offset / 3
    offset += b.positions.length; at += b.index.length
  }
  return { ...body, positions, normals, index }
}

// Skin weights for the garment's points, so it can follow the mannequin into a pose: each point takes the
// weights of the nearest skin of the part its pattern piece is on (a sleeve its arm, a hood the head and
// neck, the rest the torso and hips). points: world positions in the rest pose; pieces: each point's panel
// name; body and frame: the rest pose's.
// still: bones the body panels shouldn't follow (a sleeveless dress's straps stay on the shoulders when the
// arms move), with `fallback`, the bone a point follows when all it had was those.
// legs: the garment is pants, whose cuffs are at the ankles (a top's are at the wrists, on the arms).
export function garmentWeights(points, pieces, body, frame, { still = null, fallback = 0, legs = false } = {}) {
  // (A hood lies on the back and shoulders when it's down, so it takes the nearer of the torso and the head.)
  const parts = name => (legs ? [0, 4] : name.endsWith("_L") && /^(sleeve|cuff)/.test(name) ? [1] : name.endsWith("_R") && /^(sleeve|cuff)/.test(name) ? [2] : name.startsWith("hood") ? [0, 3] : [0, 4])
  const cell = 0.04
  const grids = [new Map(), new Map(), new Map(), new Map(), new Map()]
  const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`
  const P = body.positions
  for (let i = 0; i < P.length / 3; i++) {
    const grid = grids[frame.part[i]]
    const k = key(P[3 * i], P[3 * i + 1], P[3 * i + 2])
    if (!grid.has(k)) grid.set(k, [])
    grid.get(k).push(i)
  }
  const n = points.length / 3
  const skinIndex = new Uint16Array(4 * n), skinWeight = new Float32Array(4 * n)
  for (let j = 0; j < n; j++) {
    const x = points[3 * j], y = points[3 * j + 1], z = points[3 * j + 2]
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell)
    let best = -1, bestD = Infinity
    for (let r = 0; r <= 4 && (best < 0 || r <= 1); r++) {
      for (const part of parts(pieces[j])) {
        const grid = grids[part]
        for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue
          for (const i of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            const d = (P[3 * i] - x) ** 2 + (P[3 * i + 1] - y) ** 2 + (P[3 * i + 2] - z) ** 2
            if (d < bestD) { bestD = d; best = i }
          }
        }
      }
    }
    if (best < 0) { skinWeight[4 * j] = 1; continue }
    let total = 0
    for (let k = 0; k < 4; k++) {
      const bone = body.skinIndex[4 * best + k]
      const w = still?.has(bone) && (legs || !/^(sleeve|cuff)/.test(pieces[j])) ? 0 : body.skinWeight[4 * best + k]
      skinIndex[4 * j + k] = bone; skinWeight[4 * j + k] = w
      total += w
    }
    if (total < 1e-3) { skinIndex.fill(0, 4 * j, 4 * j + 4); skinWeight.fill(0, 4 * j, 4 * j + 4); skinIndex[4 * j] = fallback; skinWeight[4 * j] = 1 }
    else for (let k = 0; k < 4; k++) skinWeight[4 * j + k] /= total
  }
  return { skinIndex, skinWeight }
}
