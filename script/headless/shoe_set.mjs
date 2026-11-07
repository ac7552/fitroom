// For render.mjs --script: every shoe in a set, scored. The set is tmp/kith/shoes/manifest.json (served at
// /tmp/kith/shoes/): each product's listing words and photos, as pulled from the shop. Each product is read as the
// page reads a listing (the first photo that reads as a side view is the side, the others are tried as views from
// above, behind and in front), put on the mannequin alone, and scored:
//   iou     the shoe's side silhouette against the photo's outline (1 is exact);
//   front   the shoe's width over the leg's at 8 and 15 cm up (1 hugs the leg);
//   heel    the heel height the page read (m), and whether the foot was pitched;
//   ms      the time from setOutfit to settled.
// ?from=N&to=M picks a slice of the set; ?depth=off builds without the side photo's depth (depth.js).
// Returns { scored, mean, pass, rows }.
export default async function (stage) {
  const P = new URL(import.meta.url).searchParams
  const print = window.print
  const THREE = await import("three")
  const { lastFor } = await import("lib/garments/lasts")
  const { bodySnapshot } = await import("lib/garments/dress")
  const { bodyFrame } = await import("lib/garments/body")
  const { legSlices } = await import("lib/garments/accessories")
  const { depthForSide } = await import("lib/garments/depth")
  const withDepth = P.get("depth") !== "off"
  const manifest = await (await fetch("/tmp/kith/shoes/manifest.json")).json()
  const from = Number(P.get("from") ?? 0), to = Number(P.get("to") ?? manifest.length)
  const rows = []
  for (const product of manifest.slice(from, to)) {
    const t0 = performance.now()
    const row = { handle: product.handle, collection: product.collection, title: product.title }
    try {
      const urls = product.images.map((_, k) => `/tmp/kith/shoes/${product.handle}/${product.handle}-${k + 1}.jpg`)
      let photo = null, read = null
      for (const url of urls) { const r = await print.readShoe(url).catch(() => null); if (r?.side) { photo = url; read = r; break } }
      row.side = Boolean(read?.side)
      if (!read?.side) { row.error = "no side view"; rows.push(row); continue }
      const views = []
      for (const url of urls) {
        if (url === photo) continue
        const view = await print.readShoeView(url, read.side).catch(() => null)
        if (view && !views.some(v => v.kind === view.kind)) views.push(view)
      }
      row.views = views.map(v => v.kind)
      const words = `${product.title} ${product.type ?? ""} ${product.description ?? ""}`
      const style = /boot/i.test(`${product.title} ${product.type}`) ? "boot" : /sandal|slide|thong|flip/i.test(words) ? "sandal" : /loafer|derby|oxford|moc|wallabee|flat|ballerina|ballet|pump|heel|mule|slipper/i.test(words) ? "loafer" : /high[- ]?top/i.test(words) ? "hightop" : "sneaker"
      const last = lastFor(words, style, read.side)
      row.family = last.family
      const fabric = /suede|nubuck/i.test(words) ? "suede" : /leather|patent|croc|eel/i.test(words) ? "leather" : "canvas"
      const tD = performance.now()
      const depth = withDepth ? await depthForSide(photo, read.side) : null
      row.depthMs = withDepth ? Math.round(performance.now() - tD) : null
      row.depth = Boolean(depth)
      const t1 = performance.now()
      stage.setOutfit([{ kind: "shoes", style, fabric, color: read.color ?? "#888888", sole: read.sole ?? null, collar: read.collar ?? null,
        size: {}, name: product.title, words, shoeSide: read.side, shoePhoto: photo, shoeViews: views, shoeDepth: depth }])
      const deadline = Date.now() + 120000
      while (!stage.settled && Date.now() < deadline) { stage.advanceDrape(); await new Promise(r => setTimeout(r, 0)) }
      for (let i = 0; i < 10; i++) { stage.draw(); await new Promise(r => setTimeout(r, 30)) }
      row.ms = Math.round(performance.now() - t1)
      row.readMs = Math.round(tD - t0)
      const shoe = stage.feet.shoes.L
      if (!shoe) { row.error = "no shoe mesh"; rows.push(row); continue }
      row.rise = stage.feet.rise ? { angle: +stage.feet.rise.angle.toFixed(3), lift: +stage.feet.rise.lift.toFixed(3) } : null
      row.heel = +(last.params.heel ?? 0).toFixed(3)
      Object.assign(row, score(shoe, read.side, stage, THREE, { bodySnapshot, bodyFrame, legSlices }))
    } catch (e) { row.error = String(e?.message ?? e) }
    rows.push(row)
  }
  const scored = rows.filter(r => typeof r.iou === "number")
  const mean = k => +(scored.reduce((s, r) => s + (r[k] ?? 0), 0) / (scored.length || 1)).toFixed(3)
  return {
    scored: scored.length, of: rows.length, noSide: rows.filter(r => r.error === "no side view").length,
    mean: { iou: mean("iou"), ms: mean("ms"), readMs: mean("readMs"), depthMs: mean("depthMs") },
    pass: { iou09: scored.filter(r => r.iou >= 0.9).length, iou08: scored.filter(r => r.iou >= 0.8).length },
    rows
  }
}

// The side silhouette IoU and the front width ratios, as shoes.mjs measures them.
function score(shoe, side, stage, THREE, lib) {
  shoe.updateMatrixWorld(true)
  const p = shoe.geometry.attributes.position, index = shoe.geometry.index.array
  const world = Array.from({ length: p.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(shoe.matrixWorld))
  const box = new THREE.Box3().setFromPoints(world)
  const raster = (a, b, lo, hi, cell) => {
    const w = Math.ceil((hi[0] - lo[0]) / cell) + 1, h = Math.ceil((hi[1] - lo[1]) / cell) + 1
    const grid = new Uint8Array(w * h)
    const fill = pts => {
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
  const out = {}
  const exact = shoe.geometry.userData.photo
  if (exact) {
    // Compared as it stands: a photo-shaped shoe is built in the scene round the foot as it stands (pitched
    // on a heel), with the photo's outline placed there (userData.photo), as shoes.mjs compares them.
    const pts = world
    const bb = new THREE.Box3().setFromPoints(pts)
    const lo = [Math.min(bb.min.z, exact.back) - 0.01, Math.min(bb.min.y, exact.floor) - 0.005], hi = [Math.max(bb.max.z, exact.back + exact.length) + 0.01, bb.max.y + 0.05]
    const sideR = raster("z", "y", lo, hi, 0.002), photoR = raster("z", "y", lo, hi, 0.002)
    for (let t = 0; t < index.length; t += 3) sideR.fill([pts[index[t]], pts[index[t + 1]], pts[index[t + 2]]])
    const { top, bottom } = side, bins = top.length, floorLine = Math.max(...bottom)
    for (let b = 0; b < bins; b++) {
      const z0 = exact.back + (b / bins) * exact.length, z1 = exact.back + ((b + 1) / bins) * exact.length
      const yb = exact.floor + (floorLine - bottom[b]) * exact.metres, yt = exact.floor + (floorLine - top[b]) * exact.metres
      const qd = (z, y) => ({ z, y })
      photoR.fill([qd(z0, yb), qd(z1, yb), qd(z1, yt)]); photoR.fill([qd(z0, yb), qd(z1, yt), qd(z0, yt)])
    }
    let inter = 0, union = 0
    for (let i = 0; i < sideR.grid.length; i++) { const a = sideR.grid[i], c = photoR.grid[i]; inter += a & c; union += a | c }
    out.iou = +(inter / (union || 1)).toFixed(3)
  }
  const snap = lib.bodySnapshot(stage.meshes.body), frame = lib.bodyFrame(snap)
  const slices = lib.legSlices(snap, frame, "L", frame.floor + 0.5)
  const legWidth = y => {
    const k = Math.round((y - frame.floor) / 0.005)
    if (k < 0 || k >= slices.rows) return null
    let lo2 = Infinity, hi2 = -Infinity
    for (let j = 0; j < slices.reach[k].length; j++) { const x = slices.centres[k][0] + slices.reach[k][j] * Math.sin((j / slices.reach[k].length) * 2 * Math.PI); lo2 = Math.min(lo2, x); hi2 = Math.max(hi2, x) }
    return hi2 > lo2 ? hi2 - lo2 : null
  }
  const widthAt = (y, tol) => { let lo2 = Infinity, hi2 = -Infinity; for (const v of world) if (Math.abs(v.y - y) <= tol) { lo2 = Math.min(lo2, v.x); hi2 = Math.max(hi2, v.x) } return hi2 > lo2 ? hi2 - lo2 : null }
  out.front = {}
  for (const h of [0.08, 0.15]) {
    const y = frame.floor + h
    if (y > box.max.y - 0.01) continue
    const sw = widthAt(y, 0.01), lw = legWidth(y)
    if (sw && lw) out.front[`${Math.round(h * 100)}cm`] = +(sw / lw).toFixed(2)
  }
  out.height = +(box.max.y - frame.floor).toFixed(3)
  return out
}
