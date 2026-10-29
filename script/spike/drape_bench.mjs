// Times the drape on the page against the drape in a Web Worker (?drape=worker, lib/garments/remote_drape.js),
// in the running app, on the Mac, in headless Chrome (a real foreground page: a hidden tab runs slowly), and
// checks the two come out the same:
//
//   bin/dev
//   node script/spike/drape_bench.mjs [--runs 2] [--gpu] [--headed] [--base http://localhost:3000] [--out tmp/drape_bench] link-or-handle ...
//
// --gpu: also times the drape's core solver on the GPU (WebGPU, lib/garments/gpu_drape.js) against drape.js
// on each garment, once it's on (--headed runs Chrome in a window, where headless Chrome has no GPU).
// For each mode and run, on the men's example body: the outfit cleared, the links added in order, and the
// time from the first import to everything sewn, posed and shown; each garment's sewn and posed times; and
// how smooth the page stayed meanwhile (frames the page drew, and how many took over 50 ms). It saves each
// garment's final cloth points per mode, and prints how far apart the two modes' cloth ends up (it should
// be the same drape: the same code on the same numbers).
import { createRequire } from "node:module"
import { execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { checkAppRunning } from "./inputs.mjs"

const CONTROLLER = `Stimulus.getControllerForElementAndIdentifier(document.querySelector('[data-controller=fitting-room]'), 'fitting-room')`
const sleep = ms => new Promise(r => setTimeout(r, ms))

function loadPlaywright() {
  const require = createRequire(import.meta.url)
  const candidates = [process.env.PLAYWRIGHT_MODULE, "playwright"]
  try { candidates.push(path.join(execSync("npm root -g", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(), "playwright")) } catch {}
  for (const candidate of candidates.filter(Boolean)) {
    try { return require(candidate) } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error }
  }
  throw new Error("Playwright isn't installed. Once: npm i -g playwright@1.64.1")
}

export function parseBenchArgs(argv) {
  const options = { base: "http://localhost:3000", out: "tmp/drape_bench", runs: 2, links: [], gpu: false, headed: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") options.base = argv[++i]
    else if (argv[i] === "--out") options.out = argv[++i]
    else if (argv[i] === "--runs") options.runs = Number(argv[++i])
    else if (argv[i] === "--gpu") options.gpu = true
    else if (argv[i] === "--headed") options.headed = true
    else options.links.push(argv[i].startsWith("http") ? argv[i] : `https://kith.com/products/${argv[i]}`)
  }
  if (!options.links.length) options.links = ["https://kith.com/products/unduc2f4807-2", "https://kith.com/products/g105-ogt-brn"]
  return options
}

// One run in the page: returns { marks (ms from the first import), frames, slow, worst, cloth: { slot: [x...] } }.
const RUN = links => `(async () => {
  const c = ${CONTROLLER}, s = c.stage
  for (let i = 0; i < 40 && s.remote && !s.remote.ready && !s.remote.failed; i++) await new Promise(r => setTimeout(r, 250))
  document.querySelector("#fit").scrollIntoView({ block: "start" })
  const radio = document.querySelector('input[name="body-type"][value="men"]'); if (radio && !radio.checked) radio.click()
  c.fillExample()
  for (let i = 0; i < 8; i++) { const b = document.querySelector(".rail-remove"); if (!b) break; b.click(); await new Promise(r => setTimeout(r, 100)) }
  await new Promise(r => setTimeout(r, 1500))
  const m = { marks: {}, frames: 0, slow: 0, worst: 0, remote: Boolean(s.remote && !s.remote.failed) }
  const t0 = performance.now()
  let last = t0, finished = null
  const done = new Promise(resolve => { finished = resolve })
  const frame = () => {
    const now = performance.now(), dt = now - last; last = now
    m.frames++; if (dt > 50) m.slow++; m.worst = Math.max(m.worst, Math.round(dt))
    for (const [k, d] of Object.entries(s.slots)) if (d) {
      if (d.top.done && !((k + " sewn") in m.marks)) m.marks[k + " sewn"] = Math.round(now - t0)
      if (d.final && !d.posing && !((k + " posed") in m.marks)) m.marks[k + " posed"] = Math.round(now - t0)
    }
    if (s.settled && Object.values(s.slots).filter(Boolean).length === ${links.length} && m.imported) { m.marks.all = Math.round(now - t0); finished(); return }
    if (now - t0 > 300000) { m.timedOut = true; finished(); return }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  for (const link of ${JSON.stringify(links)}) {
    const input = document.querySelector("#product-link"); input.value = link; input.dispatchEvent(new Event("input", { bubbles: true }))
    document.querySelector('[data-fitting-room-target="importButton"]').click()
    for (let i = 0; i < 240; i++) { await new Promise(r => setTimeout(r, 250)); if (!c.importButtonTarget.disabled) break }
  }
  m.imported = true
  await done
  m.cloth = Object.fromEntries(Object.entries(s.slots).filter(([, d]) => d).map(([k, d]) => [k, Array.from(d.top.drape.x, v => Math.round(v * 1e5) / 1e5)]))
  m.failed = s.remote?.failed ?? null
  return m
})()`

// Once everything's on: each garment's drape timed on the CPU and the GPU (gpu_drape.js's benchDrape).
const GPU = `(async () => {
  const s = ${CONTROLLER}.stage
  const { benchDrape } = await import("lib/garments/gpu_drape")
  const out = {}
  for (const [slot, d] of Object.entries(s.slots)) if (d) out[slot] = await benchDrape(d.top.drape, { frames: 120 })
  return out
})()`

export function rmsApart(a, b) {
  if (!a || !b || a.length !== b.length) return null
  let sum = 0, most = 0
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2])
    sum += d * d; most = Math.max(most, d)
  }
  return { rms: Math.sqrt(sum / (a.length / 3)), most }
}

async function main() {
  const options = parseBenchArgs(process.argv.slice(2))
  await checkAppRunning(options.base)
  fs.mkdirSync(options.out, { recursive: true })
  const { chromium } = loadPlaywright()
  const launch = { headless: !options.headed, args: ["--enable-unsafe-webgpu"] }
  const browser = await chromium.launch({ channel: "chrome", ...launch }).catch(() => chromium.launch(launch))
  const results = { page: [], worker: [] }
  try {
    for (let run = 0; run < options.runs; run++) {
      for (const mode of ["page", "worker"]) {
        const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
        page.on("console", message => { if (message.text().startsWith("[drape]")) console.log(`  (${mode}) ${message.text()}`) })
        await page.goto(`${options.base}/${mode === "worker" ? "?drape=worker" : ""}#fit`, { waitUntil: "load" })
        await page.waitForFunction(`window.Stimulus && ${CONTROLLER}?.stage`, null, { timeout: 60000 })
        const m = await page.evaluate(RUN(options.links))
        if (options.gpu && mode === "page" && run === 0) m.gpu = await page.evaluate(GPU)
        await page.close()
        results[mode].push(m)
        const marks = Object.entries(m.marks).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)} s`).join(", ")
        console.log(`${mode} run ${run + 1}: ${m.timedOut ? "timed out; " : ""}${marks}; ${m.frames} frames drawn, ${m.slow} over 50 ms (worst ${m.worst} ms)${m.failed ? `; worker failed: ${m.failed}` : ""}`)
        for (const [slot, g] of Object.entries(m.gpu ?? {})) {
          if (g.gpu?.unavailable) { console.log(`  GPU, ${slot}: not available (${g.gpu.unavailable})`); continue }
          console.log(`  ${slot} (${g.points} points): CPU ${g.cpu.msPerFrame.toFixed(1)} ms a frame (${g.cpu.withoutSelf.toFixed(1)} without the cloth touching itself); GPU ${g.gpu.msPerFrame.toFixed(2)} ms a frame on ${g.gpu.adapter || "the GPU"}, ${(g.cpu.withoutSelf / g.gpu.msPerFrame).toFixed(1)}x; the two ${(g.apart.rms * 1000).toFixed(1)} mm apart after ${g.frames} frames`)
        }
      }
    }
  } finally {
    await browser.close()
  }
  // How far apart the two modes' cloth ends up, garment by garment (first runs).
  const [p, w] = [results.page[0], results.worker[0]]
  for (const slot of Object.keys(p?.cloth ?? {})) {
    const apart = rmsApart(p.cloth[slot], w?.cloth?.[slot])
    console.log(apart ? `${slot}: page and worker cloth ${(apart.rms * 1000).toFixed(2)} mm apart on average, ${(apart.most * 1000).toFixed(1)} mm at most` : `${slot}: the two modes' cloth has different point counts`)
  }
  const median = list => { const s = [...list].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
  for (const mode of ["page", "worker"]) {
    const all = results[mode].map(m => m.marks.all).filter(Number.isFinite)
    if (all.length) console.log(`${mode}: everything on in ${(median(all) / 1000).toFixed(1)} s (median of ${all.length})`)
  }
  fs.writeFileSync(path.join(options.out, "results.json"), JSON.stringify(results))
  console.log(`Saved: ${path.join(options.out, "results.json")}`)
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(error => { console.error(error.message); process.exit(1) })
