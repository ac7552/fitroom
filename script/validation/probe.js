// Probing helpers for the page (development only): a large picture of the figure, and crops of pictures shown
// over the page, side by side.
export async function bigShot(angle = 0, w = 900, h = 1200) {
  const s = window.VAL.s
  const facing = s.faceFront()
  const target = s.controls.target.clone()
  try {
    if (angle) { s.turnCamera(angle); s.controls.update() }
    s.draw()
    const { image } = await s.photoPasses({ width: w, height: h, guides: false, front: !angle, record: false, close: true })
    return URL.createObjectURL(image)
  } finally { s.controls.target.copy(target); s.camera.position.copy(facing.position); s.controls.update(); s.draw() }
}

// items: [[src, [x0, y0, x1, y1] (shares) or null], ...]
export async function showCrops(items, H = 1000) {
  document.getElementById("probe-ov")?.remove()
  const ims = await Promise.all(items.map(([src]) => new Promise(res => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src })))
  const c = document.createElement("canvas")
  const ws = items.map(([, r], k) => { const im = ims[k]; if (!im) return 0; const [x0, y0, x1, y1] = r ?? [0, 0, 1, 1]; return (x1 - x0) * im.width / ((y1 - y0) * im.height) * H })
  c.width = Math.max(1, Math.round(ws.reduce((a, b) => a + b, 0))); c.height = H
  const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, H)
  let at = 0
  ims.forEach((im, k) => { if (im) { const [x0, y0, x1, y1] = items[k][1] ?? [0, 0, 1, 1]; x.drawImage(im, x0 * im.width, y0 * im.height, (x1 - x0) * im.width, (y1 - y0) * im.height, at, 0, ws[k], H) } at += ws[k] })
  // Written to the Mac (window.__snap = "name": posted to the dev log, taken out by collect_log.py snaps into
  // tmp/kith/snaps/raw/<name>.jpg), or shown in the viewer tab, or over this page.
  if (window.__snap) {
    const body = JSON.stringify({ probe_marker: "FITROOM_RUN snaps", key: window.__snap, sheet: c.toDataURL("image/jpeg", 0.85) })
    await fetch("/api/v1/garment_imports", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body }).catch(() => null)
    return [c.width, c.height, "snapped " + window.__snap]
  }
  if (window.__probeRemote) { new BroadcastChannel("probe").postMessage(c.toDataURL("image/jpeg", 0.88)); return [c.width, c.height, "sent"] }
  showCanvas(c)
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
  return [c.width, c.height]
}

function showCanvas(c) {
  document.getElementById("probe-ov")?.remove()
  const ov = document.createElement("div"); ov.id = "probe-ov"; ov.style.cssText = "position:fixed;inset:0;z-index:99999;background:#fff"
  c.style.cssText = "max-width:100%;max-height:100%"; ov.appendChild(c); document.body.appendChild(ov)
}

// In an idle tab: shows what other tabs' showCrops send (they set window.__probeRemote = true).
export function viewer() {
  const channel = new BroadcastChannel("probe")
  channel.onmessage = ({ data }) => { const im = new Image(); im.onload = () => { const c = document.createElement("canvas"); c.width = im.width; c.height = im.height; c.getContext("2d").drawImage(im, 0, 0); showCanvas(c); window.__shown = Date.now() }; im.src = data }
  return "listening"
}

// The garment's photo beside the figure from the front, cropped to the torso.
export async function compareFront(photoCrop = [0.1, 0.1, 0.9, 0.9], shotCrop = [0.22, 0.06, 0.78, 0.5]) {
  const g = window.VAL.c.outfit.top?.garment ?? window.VAL.c.outfit.outer?.garment
  const shot = await bigShot(0)
  window.lastShot = shot
  return showCrops([[g.photo, photoCrop], [shot, shotCrop]])
}

// Waits for a run started with one.js (window.oneRun), up to ms.
export async function waitRun(ms = 40000) {
  const r = await Promise.race([window.oneRun, new Promise(res => setTimeout(() => res("pending"), ms))])
  return typeof r === "string" ? r : JSON.stringify(r)
}

Object.assign(window, { bigShot, showCrops, compareFront, waitRun, viewer })

// Runs a list of run keys through the runner (in the background: poll window.batch.done).
export async function runKeys(keys, { pic = [600, 900] } = {}) {
  const VAL = (await import(`/validation/runner.js?v=${Date.now()}`)).default
  window.VAL = VAL; VAL.picSize = pic; VAL.photoThumb = 480
  const all = [...(await fetch("/validation/runs_apparel.json").then(r => r.json()).catch(() => [])), ...(await fetch("/validation/kith_runs_apparel.json").then(r => r.json()).catch(() => []))]
  const runs = keys.map(key => {
    delete VAL.results[key]
    const run = all.find(r => r.key === key)
    if (run) return run
    const [group, handle] = key.split(":")
    return { key, body: group.startsWith("w_") ? "women" : "men", group, items: [{ handle, cat: /hoodie|tee|sweat|shirt|knit/.test(group) ? "top" : "outerwear" }] }
  })
  VAL.load(runs)
  window.batch = { keys, done: false, started: Date.now() }
  VAL.start().then(() => { window.batch.done = true; window.batch.ms = Date.now() - window.batch.started })
  return runs.length
}

// A finished run's photo and its three pictures, side by side.
export async function showRun(key, crop = null) {
  const r = window.VAL.results[key]
  if (!r) return "no result"
  return showCrops([[r.items[0]?.photoThumb, null], [r.pics?.front, crop], [r.pics?.side, crop], [r.pics?.back, crop]], 900)
}
Object.assign(window, { runKeys, showRun })

// Runs as a grid, one row each: its photo, then the figure from the front, the side and behind (cropped to
// the torso), written to tmp/kith/snaps/raw/<name>.jpg (see showCrops).
export async function snapRuns(name, keys, { H = 360, crop = [0.2, 0.05, 0.8, 0.55] } = {}) {
  const load = src => new Promise(res => { if (!src) return res(null); const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src })
  const rows = []
  for (const key of keys) {
    const r = window.VAL.results[key]
    if (!r) continue
    rows.push({ key, ims: await Promise.all([r.items[0]?.photoThumb, r.pics?.front, r.pics?.side, r.pics?.back].map(load)) })
  }
  const cell = (im, k) => { if (!im) return [0, null]; const [x0, y0, x1, y1] = k ? crop : [0.05, 0.05, 0.95, 0.95]; return [(x1 - x0) * im.width / ((y1 - y0) * im.height) * H, [x0, y0, x1, y1]] }
  const W = Math.max(...rows.map(r => r.ims.reduce((a, im, k) => a + cell(im, k)[0], 0)), 1)
  const c = document.createElement("canvas"); c.width = Math.round(W); c.height = rows.length * (H + 22)
  const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.font = "15px sans-serif"
  rows.forEach((r, n) => {
    const y = n * (H + 22); let x = 0
    g.fillStyle = "#000"; g.fillText(r.key, 4, y + 16)
    r.ims.forEach((im, k) => { const [w, box] = cell(im, k); if (!im) return; g.drawImage(im, box[0] * im.width, box[1] * im.height, (box[2] - box[0]) * im.width, (box[3] - box[1]) * im.height, x, y + 22, w, H); x += w })
  })
  const body = JSON.stringify({ probe_marker: "FITROOM_RUN snaps", key: name, sheet: c.toDataURL("image/jpeg", 0.85) })
  await fetch("/api/v1/garment_imports", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body }).catch(() => null)
  return [c.width, c.height, rows.length]
}
Object.assign(window, { snapRuns })
