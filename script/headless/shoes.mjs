// For render.mjs --script: shoes on the mannequin from a side photo, read as the page reads it (print.js's
// readShoe) and lofted from its last (lasts.js). ?photo=URL (default: the fixture boot; none: from the style
// and words alone), ?style=boot|sneaker|loafer|sandal|hightop, ?words=... (the listing's words), ?name=...,
// ?fabric=leather|suede|canvas.
// Returns the last (family, params, what the photo measured), where the shoe stands, and two checks:
//   iou    the shoe's side silhouette against the photo's outline, in the shoe's own frame (1 is exact);
//   front  the shaft's width over the leg's at heights up the shaft (1 is a shaft that hugs the leg; a
//          low shoe reports its width over the ankle's).
export default async function (stage) {
  const P = new URL(import.meta.url).searchParams
  const photo = P.get("photo") ?? "/fixtures/photos/beige-boot-side.jpg"
  const style = P.get("style") ?? "boot"
  const print = window.print
  const THREE = await import("three")
  const { lastFor, measureSide } = await import("lib/garments/lasts")
  const read = photo === "none" ? null : await print.readShoe(photo)
  // The shop's other photos (?views=url,url: from the front, behind, above), for the hull.
  const views = []
  for (const src of (P.get("views") ?? "").split(",").filter(Boolean)) {
    const view = read?.side ? await print.readShoeView(src, read.side).catch(() => null) : null
    if (view) views.push(view); else console.warn("view not read:", src)
  }
  const words = P.get("words") ?? P.get("name") ?? ""
  const last = lastFor(words, style, read?.side)
  // The side photo's depth (depth.js), for the shoe's relief; ?depth=off skips it.
  const { depthForSide } = await import("lib/garments/depth")
  const tDepth = performance.now()
  const depth = read?.side && P.get("depth") !== "off" ? await depthForSide(photo, read.side) : null
  const depthMs = Math.round(performance.now() - tDepth)
  stage.setOutfit([
    { kind: "top", style: "tee", size: { chest: 106, shoulders: 47, sleeve: 21, length: 72 }, color: "#b33a3a", fabric: "cotton" },
    { kind: "shoes", style, fabric: P.get("fabric") ?? "leather", color: read?.color ?? "#c9a66b", sole: read?.sole ?? null, collar: read?.collar ?? null,
      size: {}, name: P.get("name") ?? "", words, shoeSide: read?.side ?? null, shoePhoto: read?.side ? photo : null, shoeViews: views, shoeDepth: depth }
  ])
  const deadline = Date.now() + 240000
  while (!stage.settled && Date.now() < deadline) { stage.advanceDrape(); await new Promise(r => setTimeout(r, 0)) }
  for (let i = 0; i < 30; i++) { stage.draw(); await new Promise(r => setTimeout(r, 50)) }
  const m = measureSide(read?.side)
  const round = (v, d = 4) => (typeof v === "number" ? +v.toFixed(d) : v)
  const rise = stage.feet.rise && { angle: round(stage.feet.rise.angle, 3), lift: round(stage.feet.rise.lift) }
  const shoe = stage.feet.shoes.L
  const out = {
    family: last.family, rise, depth: depth ? { size: [depth.w, depth.h], ms: depthMs } : null,
    params: Object.fromEntries(Object.entries(last.params).map(([k, v]) => [k, round(v)])),
    measured: m && { sole: m.sole, collar: m.collar, taper: round(m.taper, 3), heelRise: round(m.heelRise, 3) }
  }
  if (!shoe) return out
  // The shoe's triangles in the scene.
  shoe.updateMatrixWorld(true)
  const p = shoe.geometry.attributes.position, index = shoe.geometry.index.array
  const world = Array.from({ length: p.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(shoe.matrixWorld))
  const box = new THREE.Box3().setFromPoints(world)
  out.debug = shoe.geometry.userData.photo?.debug ?? shoe.geometry.userData.photo?.hull
  {
    const g = shoe.geometry, nrm = g.attributes.normal, av = g.attributes.aViews, ap = g.attributes.aPlain
    if (nrm && av) {
      let n = 0, sx = 0, sy = 0, sz = 0, sw = 0, plain = [0, 0, 0]
      for (let i = 0; i < nrm.count; i++) if (nrm.getZ(i) > 0.8) { n++; sx += av.getX(i); sy += av.getY(i); sz += av.getZ(i); sw += av.getW(i); if (ap) for (let c = 0; c < 3; c++) plain[c] += ap.array[3 * i + c] }
      const cx = (box.min.x + box.max.x) / 2, prof = []
      for (let i = 0; i < nrm.count; i++) if (nrm.getZ(i) > 0.5 && Math.abs(world[i].x - cx) < 0.004) prof.push([round(world[i].y, 3), round(world[i].z, 4), round(nrm.getY(i), 2)])
      prof.sort((a, b) => a[0] - b[0])
      out.profile = prof.filter((_, k) => k % 2 === 0).slice(0, 60)
      out.frontFaces = { n, side: round(sx / n, 3), top: round(sy / n, 3), back: round(sz / n, 3), front: round(sw / n, 3), plain: plain.map(v => round(v / n, 3)) }
    }
  }
  out.views = views.map(v => [v.kind, v.shoes?.[0]?.toeUp, v.shoes?.length])
  out.where = { y: [round(box.min.y), round(box.max.y)], z: [round(box.min.z), round(box.max.z)], x: [round(box.min.x), round(box.max.x)] }

  // A raster of a projection of the triangles: cell (mm) over the axes a (across) and b (up).
  const raster = (a, b, lo, hi, cell) => {
    const w = Math.ceil((hi[0] - lo[0]) / cell) + 1, h = Math.ceil((hi[1] - lo[1]) / cell) + 1
    const grid = new Uint8Array(w * h)
    const fill = (pts) => {
      const xs = pts.map(q => (q[a] - lo[0]) / cell), ys = pts.map(q => (q[b] - lo[1]) / cell)
      const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(w - 1, Math.ceil(Math.max(...xs)))
      const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)))
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const cx = x + 0.5, cy = y + 0.5
        let neg = false, pos = false
        for (let k = 0; k < 3; k++) {
          const d = (xs[(k + 1) % 3] - xs[k]) * (cy - ys[k]) - (ys[(k + 1) % 3] - ys[k]) * (cx - xs[k])
          if (d < 0) neg = true; if (d > 0) pos = true
        }
        if (!(neg && pos)) grid[y * w + x] = 1
      }
    }
    return { grid, w, h, fill }
  }
  const lo = [box.min.z - 0.01, box.min.y - 0.005], hi = [box.max.z + 0.01, box.max.y + 0.01]
  const side = raster("z", "y", lo, hi, 0.002)
  for (let t = 0; t < index.length; t += 3) side.fill([world[index[t]], world[index[t + 1]], world[index[t + 2]]])

  // The photo's outline in the same frame: each column's top and bottom, in metres over the floor, along the
  // sole's span (userData.photo: how the loft placed the photo).
  const exact = shoe.geometry.userData.photo
  if (read?.side && exact) {
    const { top, bottom } = read.side, bins = top.length
    const floorLine = Math.max(...bottom)
    const mesh = raster("z", "y", lo, hi, 0.002)
    for (let b = 0; b < bins; b++) {
      const z0 = exact.back + (b / bins) * exact.length, z1 = exact.back + ((b + 1) / bins) * exact.length
      const yb = exact.floor + (floorLine - bottom[b]) * exact.metres, yt = exact.floor + (floorLine - top[b]) * exact.metres
      // (With a heel the shoe is pitched in the scene; the photo's outline is of it flat. Compared flat.)
      const q = (z, y) => ({ z, y })
      mesh.fill([q(z0, yb), q(z1, yb), q(z1, yt)]); mesh.fill([q(z0, yb), q(z1, yt), q(z0, yt)])
    }
    let inter = 0, union = 0
    for (let i = 0; i < side.grid.length; i++) { const a = side.grid[i], c = mesh.grid[i]; inter += a & c; union += a | c }
    out.iou = round(inter / (union || 1), 3)
    out.silhouette = { shoe: side.grid.reduce((s, v) => s + v, 0), photo: mesh.grid.reduce((s, v) => s + v, 0) }
  }

  // Front flatness: the shoe's width across at heights up it, over the leg's there (the body's left leg's
  // extent in x within 4 mm of the height).
  const { bodySnapshot } = await import("lib/garments/dress")
  const { bodyFrame } = await import("lib/garments/body")
  const { legSlices } = await import("lib/garments/accessories")
  const snap = bodySnapshot(stage.meshes.body), frame = bodyFrame(snap)
  // Where the left foot is (its skin below 12 cm, on the shoe's side), against the shoe: a seated foot's box
  // sits inside the shoe's, and its toes don't reach past the shoe's.
  {
    const fb = new THREE.Box3()
    for (let i = 0; i < snap.positions.length / 3; i++) {
      const x = snap.positions[3 * i], y = snap.positions[3 * i + 1], z = snap.positions[3 * i + 2]
      if (y < frame.floor + 0.12 && x > 0) fb.expandByPoint(new THREE.Vector3(x, y, z))
    }
    out.foot = { y: [round(fb.min.y), round(fb.max.y)], z: [round(fb.min.z), round(fb.max.z)], x: [round(fb.min.x), round(fb.max.x)], floor: round(frame.floor) }
    // How much of the foot's skin is outside the shoe's side silhouette (y–z), over the toes and the vamp.
    let outside = 0, all = 0
    for (let i = 0; i < snap.positions.length / 3; i++) {
      const x = snap.positions[3 * i], y = snap.positions[3 * i + 1], z = snap.positions[3 * i + 2]
      if (!(y < frame.floor + 0.08 && x > 0)) continue
      all++
      const gx = Math.floor((z - lo[0]) / 0.002), gy = Math.floor((y - lo[1]) / 0.002)
      if (gx < 0 || gy < 0 || gx >= side.w || gy >= side.h || !side.grid[gy * side.w + gx]) outside++
    }
    out.foot.outsideShare = round(outside / (all || 1), 3)
  }
  const slices = legSlices(snap, frame, "L", frame.floor + 0.5)
  const legWidth = y => {
    const k = Math.round((y - frame.floor) / 0.005)
    if (k < 0 || k >= slices.rows) return null
    let lo2 = Infinity, hi2 = -Infinity
    for (let j = 0; j < slices.reach[k].length; j++) { const x = slices.centres[k][0] + slices.reach[k][j] * Math.sin((j / slices.reach[k].length) * 2 * Math.PI); lo2 = Math.min(lo2, x); hi2 = Math.max(hi2, x) }
    return hi2 > lo2 ? hi2 - lo2 : null
  }
  const widthAt = (pts, y, tol) => { let lo2 = Infinity, hi2 = -Infinity; for (const [x, py] of pts) if (Math.abs(py - y) <= tol) { lo2 = Math.min(lo2, x); hi2 = Math.max(hi2, x) } return hi2 > lo2 ? hi2 - lo2 : null }
  const shoeXY = world.map(v => [v.x, v.y])
  out.front = {}
  for (const h of [0.08, 0.15, 0.25, 0.35]) {
    const y = frame.floor + h
    if (y > box.max.y - 0.01) continue
    const sw = widthAt(shoeXY, y, 0.01), lw = legWidth(y)
    if (sw && lw) out.front[`${Math.round(h * 100)}cm`] = round(sw / lw, 2)
  }
  return out
}
