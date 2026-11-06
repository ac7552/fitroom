// The render mesh: the drape's cloth subdivided once or twice, so what's drawn is smooth where the drape is
// faceted (its points are 1.6 to 2 cm apart) and fine enough to carry the folds of wrinkles.js (a fold 4 cm
// wide needs points well under 1 cm apart, or it's a zigzag).
//
// Subdivision is interpolating (the butterfly scheme): the drape's own points stay where they are, so the
// cloth stays as clear of the body as the drape left it, and each edge's new point is placed from the eight
// points round it. Edges on a panel's outline take their plain midpoint, so the two sides of a seam (separate
// panels, sewn by the drape to the same places) meet exactly. Everything else the shader reads per point
// (which piece, where in the photo, the fit colour) is carried to the new points by averaging its two ends,
// or, for what's a label rather than an amount (the piece number), the first end's.
//
// Built once from the drape's geometry (the topology never changes); each frame, the positions are refined
// again (a few hundred thousand multiply-adds), the wrinkles laid on, and the normals taken from the fine
// triangles. Other attributes are refined again only when the drape's copy changed (its version).
import * as THREE from "three"
import { subdivide } from "lib/garments/subdivide"

// Attribute components that are labels, not amounts (which piece, which photo, which graphic, shown or
// hidden): a new point takes its first end's. Everything else (a place in a photo, a share) is averaged.
const LABELS = { aPiece: [0], aPhoto: [2], aLegPrint: [2], aHide: [0], aCover: [0], aHole: [0] }
// How many times to subdivide: twice (points a quarter as far apart) unless the cloth is already large.
export const FINE_LEVELS = 2
const MOST_FINE_POINTS = 90000
// ?foldgain=N scales the folds (for looking at where they lie).
const FOLD_GAIN = Number(typeof location !== "undefined" && new URLSearchParams(location.search).get("foldgain")) || 1

export class FineCloth {
  // coarse: the drape's BufferGeometry (indexed, with its two groups: the cloth's fabric, then rib).
  constructor(coarse, levels = FINE_LEVELS) {
    this.coarse = coarse
    const n = coarse.attributes.position.count
    const index = Array.from(coarse.index.array)
    const groups = coarse.groups.map(g => ({ ...g }))
    // Each level's recipe for its new points, from the level before: for every new point, its stencil (point
    // indices and weights for the position) and its two ends (for everything else).
    this.levels = []
    let count = n, tris = index, groupOf = new Uint8Array(index.length / 3)
    for (const g of groups) for (let t = g.start / 3; t < (g.start + g.count) / 3; t++) groupOf[t] = g.materialIndex
    for (let level = 0; level < levels; level++) {
      if (count + tris.length / 2 > MOST_FINE_POINTS && level > 0) break
      const built = subdivide(count, tris, groupOf)
      this.levels.push(built)
      count = built.count; tris = built.index; groupOf = built.groupOf
    }
    this.count = count
    this.triangles = Uint32Array.from(tris)
    this.geometry = new THREE.BufferGeometry()
    // The fine index with the fabric's triangles first, then rib's, as the drape's is grouped.
    const main = [], ribbed = []
    for (let t = 0; t < tris.length; t += 3) (groupOf[t / 3] ? ribbed : main).push(tris[t], tris[t + 1], tris[t + 2])
    this.geometry.setIndex([...main, ...ribbed])
    this.geometry.addGroup(0, main.length, 0)
    this.geometry.addGroup(main.length, ribbed.length, 1)
    this.versions = {}
    for (const [name, attribute] of Object.entries(coarse.attributes)) {
      const fine = new THREE.BufferAttribute(new Float32Array(attribute.itemSize * count), attribute.itemSize)
      if (name === "position" || name === "normal") fine.setUsage(THREE.DynamicDrawUsage)
      this.geometry.setAttribute(name, fine)
    }
    this.faceScratch = new Float32Array(3 * count)
    // The folds (wrinkles.js): a phase and an amplitude per coarse point, refined like any amount.
    this.phase = null
    this.amp = null
    // How much of its folds each coarse point keeps (dress.js's setFoldKeep), or null for all.
    this.keep = null
    this.kept = null
    this.finePhase = new Float32Array(count)
    this.fineAmp = new Float32Array(count)
    this.sync(true)
  }

  // Everything but the positions and normals, where the drape's copy changed (all of it at first).
  sync(all = false) {
    for (const [name, attribute] of Object.entries(this.coarse.attributes)) {
      if (name === "position" || name === "normal") continue
      if (!all && this.versions[name] === attribute.version) continue
      this.versions[name] = attribute.version
      const fine = this.geometry.attributes[name]
      this.refine(attribute.array, fine.array, attribute.itemSize, "mean", LABELS[name])
      fine.needsUpdate = true
    }
  }

  // from (the coarse values, size per point) into to (the fine ones): the coarse points first, then each
  // level's new points by `how`: "mean" of the two ends (but the first end's for the components in `labels`),
  // or "stencil" (the position's).
  refine(from, to, size, how, labels = null) {
    to.set(from.subarray(0, size * this.coarse.attributes.position.count))
    for (const level of this.levels) {
      const { ends, stencilStart, stencilIndex, stencilWeight, first } = level
      const m = ends.length / 2
      for (let k = 0; k < m; k++) {
        const o = size * (first + k)
        if (how === "stencil") {
          for (let c = 0; c < size; c++) to[o + c] = 0
          for (let s = stencilStart[k]; s < stencilStart[k + 1]; s++) {
            const j = size * stencilIndex[s], w = stencilWeight[s]
            for (let c = 0; c < size; c++) to[o + c] += w * to[j + c]
          }
        } else {
          const a = size * ends[2 * k], b = size * ends[2 * k + 1]
          for (let c = 0; c < size; c++) to[o + c] = labels?.includes(c) ? to[a + c] : 0.5 * (to[a + c] + to[b + c])
        }
      }
    }
  }

  // The fine positions from the coarse ones (already in the coarse geometry), the folds laid on, and the
  // normals. Call after the coarse positions are set each frame.
  update() {
    const position = this.geometry.attributes.position, normal = this.geometry.attributes.normal
    this.refine(this.coarse.attributes.position.array, position.array, 3, "stencil")
    if (this.amp) {
      // Along the surface's own normal before the folds, so a fold lifts the cloth, not slides it.
      this.normals(position.array, normal.array)
      this.refine(this.phase, this.finePhase, 1, "mean")
      let amp = this.amp
      if (this.keep && this.keep.length === amp.length) {
        if (this.kept?.length !== amp.length) this.kept = new Float32Array(amp.length)
        for (let i = 0; i < amp.length; i++) this.kept[i] = amp[i] * this.keep[i]
        amp = this.kept
      }
      this.refine(amp, this.fineAmp, 1, "mean")
      const p = position.array, nn = normal.array
      for (let i = 0; i < this.count; i++) {
        const a = this.fineAmp[i]
        if (a <= 0) continue
        // A fold's profile: a narrow ridge and a broad, shallow valley (cloth buckles into ridges, not a
        // sine), and mostly outward: the drape left the cloth just clear of the body, and a deep inward half
        // would sink into it.
        const s = 0.5 + 0.5 * Math.sin(this.finePhase[i])
        const d = a * FOLD_GAIN * (1.6 * s * s * s - 0.35)
        p[3 * i] += nn[3 * i] * d; p[3 * i + 1] += nn[3 * i + 1] * d; p[3 * i + 2] += nn[3 * i + 2] * d
      }
    }
    this.normals(position.array, normal.array)
    position.needsUpdate = true
    normal.needsUpdate = true
    this.sync()
  }

  // Folds from wrinkles.js: phase (radians) and amplitude (m) per coarse point; null for none.
  setWrinkles(phase, amp) {
    this.phase = phase
    this.amp = amp
  }

  // How much of its folds each coarse point keeps (0 to 1), or null for all; laid on at the next update.
  setKeep(keep) {
    this.keep = keep
  }

  normals(p, out) {
    const acc = this.faceScratch.fill(0)
    const tris = this.triangles
    for (let t = 0; t < tris.length; t += 3) {
      const a = 3 * tris[t], b = 3 * tris[t + 1], c = 3 * tris[t + 2]
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2]
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2]
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
      acc[a] += nx; acc[a + 1] += ny; acc[a + 2] += nz
      acc[b] += nx; acc[b + 1] += ny; acc[b + 2] += nz
      acc[c] += nx; acc[c + 1] += ny; acc[c + 2] += nz
    }
    for (let i = 0; i < acc.length; i += 3) {
      const l = Math.hypot(acc[i], acc[i + 1], acc[i + 2]) || 1
      out[i] = acc[i] / l; out[i + 1] = acc[i + 1] / l; out[i + 2] = acc[i + 2] / l
    }
  }

  dispose() {
    this.geometry.dispose()
  }
}

