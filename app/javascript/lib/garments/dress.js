import * as THREE from "three"
import { bodyFrame, SkinField } from "lib/garments/body"
import { STYLES, draftTop } from "lib/garments/pattern"
import { BOTTOM_STYLES, draftBottoms } from "lib/garments/pants"
import { buildCloth } from "lib/garments/cloth"
import { placeCloth } from "lib/garments/place"
import { Drape } from "lib/garments/drape"
import { clothMaterial } from "lib/garments/fabric"

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
// collision field around it, so it's kept well below any hem), without the hands (sleeves end at the wrist),
// and the display mannequin's egg in place of the head.
// bodyCount: how many of the vertices are the body's own (the rest, garments under the cloth, all count).
// arms: false for pants (hands rest on the outside of them; an arm coming down into a pose would trap the
// cloth against the hips).
export function collisionBody(body, frame, egg, bodyCount = body.positions.length / 3, { arms = true } = {}) {
  const n = body.positions.length / 3
  const keep = new Uint8Array(n)
  const knee = frame.floor + 0.1
  for (let i = 0; i < n; i++) {
    const p = body.positions
    if (p[3 * i + 1] < knee) continue
    if (i >= bodyCount) { keep[i] = 1; continue }
    if (egg && body.head && body.head[i] > 0.5) continue
    const part = frame.part[i]
    if (part === 1 || part === 2) {
      if (!arms) continue
      const arm = frame.arms[part === 1 ? "L" : "R"]
      if (arm.locate([p[3 * i], p[3 * i + 1], p[3 * i + 2]]).t > arm.lengths[2] + 0.02) continue
    }
    keep[i] = 1
  }
  return new SkinField(body.positions, body.normals, body.index, { keep, ellipsoids: egg ? [egg] : [] })
}

// The look of a style in a shop's fabric: the drape's cloth is the style's, the surface the fabric's when it
// says something different (a denim shirt, a nylon bomber).
function surfaceFor(style, fabric) {
  // A dress's own cloth (see GarmentImport::DressCut): leather, silk, stretch or jersey.
  if (style === "dress" && ["stretch", "jersey"].includes(fabric)) return fabric
  // Silk and leather look like themselves on any top (a silk shirt, a leather tee).
  if (fabric === "silk" || (fabric === "leather" && style !== "zip" && style !== "bomber")) return fabric
  // Knitwear's own knit.
  if (STYLES[style]?.surface && !["silk", "leather", "nylon"].includes(fabric)) return STYLES[style].surface
  const own = STYLES[style]?.fabric ?? "jersey"
  if (fabric === "denim") return "twill"
  if (fabric === "nylon" || fabric === "leather") return "shell"
  if (fabric === "wool" && own !== "shell") return own === "jersey" ? "jersey" : "wool"
  return own
}

// How pants look: jeans in denim twill, joggers in fleece, leggings in a fine stretch knit, the rest in
// their shop's fabric (a nylon pant in a matte shell, wool in wool, cotton in twill).
function bottomSurface(style, fabric) {
  if (style === "leggings") return "stretch"
  if (style === "joggers") return fabric === "nylon" ? "satin" : "fleece"
  if (style === "jeans" || fabric === "denim") return "twill"
  if (fabric === "nylon") return "satin"
  if (fabric === "wool") return "wool"
  if (fabric === "leather") return "leather"
  if (fabric === "silk") return "silk"
  return BOTTOM_STYLES[style]?.fabric === "fleece" ? "fleece" : "twill"
}

// One top on the mannequin: drafted, sewn and settled a few frames at a time.
// item: { style, size (cm), color, fabric }. body: bodySnapshot; frame: bodyFrame of it; field: its
// collision field; measures: the wearer in cm (for the parts a chart doesn't give).
export class DrapedTop {
  constructor({ item, body, frame, field, measures, renderer }) {
    this.item = item
    this.bottoms = item.kind === "trousers"
    const wearer = { ...measures, ...frame.measures }
    if (this.bottoms) {
      // From the crotch up to the natural waist (about at the navel), on this body.
      wearer.rise = (frame.hps[1] - (measures.height ?? 175) * 0.00235 - frame.crotch) * 100
    }
    this.pattern = this.bottoms ? draftBottoms(item.style, item.size, wearer, item.cut ?? null) : draftTop(item.style, item.size, wearer, item.cut ?? null)
    this.cloth = buildCloth(this.pattern, this.bottoms ? BOTTOM_SPACING : SPACING)
    const { positions, attach } = placeCloth(this.cloth, this.pattern, frame)
    // A skirt hangs round both legs; pants go round each.
    const envelope = this.bottoms && item.style !== "skirt" ? null : { table: frame.torso, top: frame.crotch + 0.03, bottom: frame.floor }
    // A dress held up by straps or round the bust grips where it rests (as straps and boning do, rather than
    // sliding off the shoulders' slope); pants grip at the waist; others slide over the body as usual.
    const holds = ["strapless", "one_shoulder", "straps", "thin_straps", "none"].includes(item.cut?.sleeves)
    // Pants' waist: the top edges of the leg pieces, as long round as the pants' waist.
    const ring = this.bottoms ? {
      points: Object.entries(this.cloth.edges).filter(([key]) => /^(front|back)(_[LR])?\/waist$/.test(key)).flatMap(([, idx]) => idx),
      length: this.pattern.measures.waist / 100
    } : null
    this.drape = new Drape(this.cloth, positions, { ...body, field }, {
      fabric: this.pattern.fabric, envelope, attach, friction: holds ? 0.12 : 0.7, floor: this.bottoms ? frame.floor + 0.004 : null, ring
    })
    // A long garment (a dress, pants) has further to fall, so it settles for longer.
    const long = this.pattern.style === "dress" || this.pattern.measures.length > 85
    // Pants are sewn without gravity (nothing holds them up until they're closed); a skirt, held at its
    // waistband, is sewn hanging, so it falls straight.
    const skirt = this.bottoms && item.style === "skirt"
    this.steps = this.drape.phases(skirt ? { settleFrames: 280, calmFrames: 60, sewGravity: 0.4, relaxFrames: 12 }
      : this.bottoms ? { settleFrames: long ? 240 : 160, calmFrames: 60, sewGravity: 0 }
      : long ? { settleFrames: 280, calmFrames: 60, sewGravity: holds ? 0 : 0.4 } : { settleFrames: 140, calmFrames: 45 })
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

  // Runs the drape for up to `budget` milliseconds. Returns true while there's more to do.
  advance(budget = 10) {
    if (this.done) return false
    const end = performance.now() + budget
    do {
      const next = this.steps.next()
      if (next.done) {
        this.done = true
        this.shade()
        break
      }
      this.phase = next.value
    } while (performance.now() < end)
    this.update()
    return !this.done
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
    const front = cloth.panels.indexOf("front")
    geometry.setAttribute("aPiece", new THREE.BufferAttribute(Float32Array.from(cloth.panel, p => (p === front ? 1 : 0)), 1))
    geometry.setAttribute("aShade", new THREE.BufferAttribute(new Float32Array(n).fill(1), 1))
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
    const surface = this.bottoms ? bottomSurface(item.style, item.fabric) : surfaceFor(item.style, item.fabric)
    const knit = ["jersey", "fleece", "rib"].includes(surface)
    const details = {
      stitch: knit ? "hem" : "topstitch", closure: pattern.closure, pocket: item.style === "hoodie" ? "kangaroo" : null,
      neckDepth: pattern.measures.frontNeck, length: pattern.measures.length
    }
    return {
      main: clothMaterial({ color: item.color, cloth: surface, details, renderer }),
      rib: clothMaterial({ color: item.color, cloth: knit ? "rib" : surface, details: {}, renderer }),
      fitMain: clothMaterial({ color: "#ffffff", cloth: surface, details, fitMap: true, renderer }),
      fitRib: clothMaterial({ color: "#ffffff", cloth: knit ? "rib" : surface, fitMap: true, renderer })
    }
  }

  setColor(color) {
    for (const key of ["main", "rib"]) {
      this.materials[key].color.set(color)
      this.materials[key].sheenColor.set(color).offsetHSL(0, -0.1, 0.25)
      this.materials[key].userData.uniforms.uThread.value.set(color).offsetHSL(0, 0, 0.07)
    }
  }

  // A print from the shop's photo (print.js's readPhoto; null for none), laid on the front.
  setPrint(print) {
    if (this.bottoms) print = null   // a print is read off a top's front
    if (print?.image === this.printImage) return
    this.printImage = print?.image ?? null
    this.printTexture?.dispose()
    this.printTexture = null
    const uniforms = this.materials.main.userData.uniforms
    if (print) {
      this.printTexture = new THREE.CanvasTexture(print.image)
      this.printTexture.colorSpace = THREE.SRGBColorSpace
      this.printTexture.anisotropy = 4
      const m = this.pattern.measures
      const band = this.pattern.panels.waistband ? Math.max(...this.pattern.panels.waistband.edges.flatMap(e => e.points).map(p => Math.abs(p[1]))) : 0
      uniforms.uPrint.value = this.printTexture
      uniforms.uPrintHalf.value = m.chest / 4
      uniforms.uPrintLength.value = m.length + band
    }
    uniforms.uPrintOn.value = print ? 1 : 0
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
  const field = collisionBody(merge(body, over), frame, egg, body.positions.length / 3, { arms })
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
export function garmentWeights(points, pieces, body, frame, { still = null, fallback = 0 } = {}) {
  const parts = name => (name.endsWith("_L") && /^(sleeve|cuff)/.test(name) ? [1] : name.endsWith("_R") && /^(sleeve|cuff)/.test(name) ? [2] : name.startsWith("hood") ? [3] : [0, 4])
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
      const w = still?.has(bone) && !/^(sleeve|cuff)/.test(pieces[j]) ? 0 : body.skinWeight[4 * best + k]
      skinIndex[4 * j + k] = bone; skinWeight[4 * j + k] = w
      total += w
    }
    if (total < 1e-3) { skinIndex.fill(0, 4 * j, 4 * j + 4); skinWeight.fill(0, 4 * j, 4 * j + 4); skinIndex[4 * j] = fallback; skinWeight[4 * j] = 1 }
    else for (let k = 0; k < 4; k++) skinWeight[4 * j + k] /= total
  }
  return { skinIndex, skinWeight }
}
