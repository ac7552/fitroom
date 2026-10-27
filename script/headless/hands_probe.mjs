// For render.mjs --script: how the hands sit against the pants once draped. For each hand (the body's arm
// vertices past the wrist), the share of its vertices under the pants' cloth (on the body's side of the
// nearest cloth point, by that point's normal turned away from the body's middle), and the cloth points
// within 1 cm of the hand. Then frames the camera on the hips (?zoom=0 to keep the full figure).
// Also the waistband's top and the hems' heights. Exports default(stage) -> { L: { under, near, vertices }, R,
// rim, hemL, hemR }.
export default async function (stage) {
  const { bodyFrame } = await import("/lib/garments/body.js")
  const { bodySnapshot } = await import("/lib/garments/dress.js")
  const slot = stage.slots.bottom
  if (!slot) return { error: "no pants" }
  const body = bodySnapshot(stage.meshes.body)
  const frame = bodyFrame(body)
  const cloth = slot.top.geometry.attributes.position.array
  const normals = slot.top.geometry.attributes.normal.array
  const p = body.positions, n = p.length / 3, m = cloth.length / 3
  const out = {}
  for (const [side, part] of [["L", 1], ["R", 2]]) {
    const arm = frame.arms[side]
    let vertices = 0, under = 0
    const near = new Set()
    for (let i = 0; i < n; i++) {
      if (frame.part[i] !== part) continue
      const v = [p[3 * i], p[3 * i + 1], p[3 * i + 2]]
      if (arm.locate(v).t <= arm.lengths[2]) continue
      vertices++
      let best = Infinity, j = -1
      for (let k = 0; k < m; k++) {
        const d = (cloth[3 * k] - v[0]) ** 2 + (cloth[3 * k + 1] - v[1]) ** 2 + (cloth[3 * k + 2] - v[2]) ** 2
        if (d < best) { best = d; j = k }
        if (d < 0.0001) near.add(k)
      }
      if (j < 0 || best > 0.05 ** 2) continue
      // The cloth's normal there, facing away from the body's middle line.
      let nx = normals[3 * j], nz = normals[3 * j + 2]
      const ny = normals[3 * j + 1]
      const cz = frame.torso.centreAt(cloth[3 * j + 1])
      const sign = Math.sign(nx * cloth[3 * j] + nz * (cloth[3 * j + 2] - cz)) || 1
      const along = ((v[0] - cloth[3 * j]) * nx + (v[1] - cloth[3 * j + 1]) * ny + (v[2] - cloth[3 * j + 2]) * nz) * sign
      if (along < 0) under++
    }
    out[side] = { vertices, under: +(under / Math.max(1, vertices)).toFixed(3), near: near.size }
  }
  // Where the pants hang: the waistband's top and each leg's hem (lowest and middle height, cm), as drawn.
  const edges = slot.top.cloth.edges
  const heights = names => {
    const ys = names.flatMap(name => edges[name] ?? []).map(i => cloth[3 * i + 1] * 100).sort((a, b) => a - b)
    return ys.length ? [Math.round(ys[0] * 10) / 10, Math.round(ys[ys.length >> 1] * 10) / 10] : null
  }
  out.rim = heights(["waistband/rim"])
  out.hemL = heights(["front_L/hem", "back_L/hem"])
  out.hemR = heights(["front_R/hem", "back_R/hem"])
  if (new URL(import.meta.url).searchParams.get("zoom") !== "0") {
    const t = stage.controls.target, c = stage.camera.position
    const hips = frame.crotch - 0.02
    const dx = c.x - t.x, dz = c.z - t.z, d = Math.hypot(dx, dz)
    t.set(0, hips, frame.torso.centreAt(hips))
    c.set(t.x + (dx / d) * 1.6, hips + 0.05, t.z + (dz / d) * 1.6)
    stage.controls.update()
  }
  return out
}
