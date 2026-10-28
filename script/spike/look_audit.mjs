// The 3D view's check against the store photo (lib/garments/look_check.js), run over many tops in the running
// app, on the Mac, to see which fail and why:
//
//   bin/dev                                   # the app, on http://localhost:3000
//   node script/spike/look_audit.mjs [--out tmp/look_audit] [--base http://localhost:3000] [--limit N]
//                                    [--links handle-or-url,...] [--resume]
//
// The tops are every handle in docs/outfits.json (men's and women's) plus --links; anything that imports as
// something other than a top is skipped after its import. For each top, on the men's example body: the
// outfit is cleared, the link added, and the page's own check runs as a person would see it (up to three
// tries). Recorded in NAME.json: each try's checks and both readings (photo and render), how it ended
// (passed, passed on a later try, or "can't show"), and NAME.png: the store photo and the check's picture of
// the 3D garment side by side, each with the front it measured (green) and the graphic's box (red), for the
// first try's reading. report.json gathers them; index.html shows every top with its picture, and a summary
// counts each check's failures on the first try.
//
// Resilient as audit.mjs is: a top that fails never stops the run, a crashed page is reopened, imports are
// 2 s apart (Kith rate-limits), --resume skips tops already done. About a minute or two a top.
import { createRequire } from "node:module"
import { execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { checkAppRunning } from "./inputs.mjs"

const CHECK_TIMEOUT = Number(process.env.LOOK_AUDIT_TIMEOUT) || 360000
const POLL = 1000
const BETWEEN_IMPORTS = 2000
const CONTROLLER = `Stimulus.getControllerForElementAndIdentifier(document.querySelector('[data-controller=fitting-room]'), 'fitting-room')`
const OUTFITS_FILE = fileURLToPath(new URL("../../docs/outfits.json", import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))

export function parseLookArgs(argv) {
  const options = { base: "http://localhost:3000", out: "tmp/look_audit", limit: Infinity, links: [], resume: false }
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]]
    if (flag === "--resume") options.resume = true
    else if (flag === "--base") { options.base = value; i++ }
    else if (flag === "--out") { options.out = value; i++ }
    else if (flag === "--limit") { options.limit = Number(value); i++ }
    else if (flag === "--links") { options.links = value.split(",").map(s => s.trim()).filter(Boolean); i++ }
    else throw new Error(`Unknown option ${flag}. Usage: node script/spike/look_audit.mjs [--out DIR] [--base URL] [--limit N] [--links a,b] [--resume]`)
  }
  return options
}

// Every handle in the outfits, men's then women's, each once, then the extra links (handles or full links).
export function handlesFor(outfits, links = []) {
  const seen = new Set(), out = []
  const add = h => { const handle = String(h).replace(/^https?:\/\/[^/]+\/(?:collections\/[^/]+\/)?products\//, "").replace(/[?#].*$/, ""); if (handle && !seen.has(handle)) { seen.add(handle); out.push(handle) } }
  for (const handle of links) add(handle)
  for (const outfit of outfits) for (const body of ["men", "women"]) for (const handle of outfit[body] ?? []) add(handle)
  return out
}

// How a top's check went: "passed" (first try), "passed on try N", "can't show", or why it wasn't checked.
export function outcomeOf(record) {
  if (record.skipped) return record.skipped
  if (record.stuck) return "can't show"
  if (record.done) return record.tries.length ? `passed on try ${record.tries.length + 1}` : "passed"
  return "didn't finish"
}

// The summary: how many tops ended each way, and how often each check failed on the first try.
export function summarize(records) {
  const checked = records.filter(r => !r.skipped)
  const outcomes = {}, firstFailures = {}
  for (const r of checked) {
    const outcome = outcomeOf(r)
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
    for (const name of r.tries[0]?.failed ?? []) firstFailures[name] = (firstFailures[name] ?? 0) + 1
  }
  return { tops: checked.length, skipped: records.length - checked.length, outcomes, firstFailures }
}

function loadPlaywright() {
  const require = createRequire(import.meta.url)
  const candidates = [process.env.PLAYWRIGHT_MODULE, "playwright"]
  try { candidates.push(path.join(execSync("npm root -g", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(), "playwright")) } catch {}
  for (const candidate of candidates.filter(Boolean)) {
    try { return require(candidate) } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error }
  }
  throw new Error("Playwright isn't installed. Once: npm i -g playwright@1.64.1")
}

// In the page: the store photo and the check's picture of the 3D garment, side by side, each with its front
// (green) and graphic box (red), as one PNG (base64).
const SIDE_BY_SIDE = `(async () => {
  const c = ${CONTROLLER}
  const P = await import("lib/garments/print"), LC = await import("lib/garments/look_check")
  const g = c.outfit.top?.garment
  if (!g?.lookPhotos?.front) return null
  const mark = (canvas, found) => {
    if (!found) return canvas
    const x = canvas.getContext("2d"), [a, b, cc, d] = found.rect
    x.lineWidth = 3; x.strokeStyle = "#0a0"; x.strokeRect(a, b, cc - a, d - b)
    const B = found.look?.box
    if (B) { x.strokeStyle = "#e00"; const w = cc - a, h = d - b; x.strokeRect(a + B.left * w, b + B.top * h, (B.right - B.left) * w, (B.bottom - B.top) * h) }
    return canvas
  }
  const image = await P.loadImage(g.lookPhotos.front)
  const W = 480, H = Math.round(image.naturalHeight * W / image.naturalWidth)
  const photo = document.createElement("canvas"); photo.width = W; photo.height = H
  const px = photo.getContext("2d", { willReadFrequently: true }); px.drawImage(image, 0, 0, W, H)
  mark(photo, P.findPrint(px.getImageData(0, 0, W, H).data, W, H, null, LC.PLAIN))
  const shot = await c.stage.lookShot("top")
  const render = document.createElement("canvas"); render.width = shot.width; render.height = shot.height
  render.getContext("2d").putImageData(shot, 0, 0)
  mark(render, P.findPrint(shot.data, shot.width, shot.height, null, LC.PLAIN))
  const out = document.createElement("canvas"); out.width = W + render.width + 16; out.height = Math.max(H, render.height)
  const o = out.getContext("2d"); o.fillStyle = "#fff"; o.fillRect(0, 0, out.width, out.height)
  o.drawImage(photo, 0, (out.height - H) / 2); o.drawImage(render, W + 16, 0)
  return out.toDataURL("image/png").split(",")[1]
})()`

export async function lookAudit(options, say = console.log) {
  const outfits = JSON.parse(fs.readFileSync(OUTFITS_FILE, "utf8")).outfits
  const handles = handlesFor(outfits, options.links).slice(0, options.limit)
  await checkAppRunning(options.base)
  const { chromium } = loadPlaywright()
  fs.mkdirSync(options.out, { recursive: true })
  const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ headless: true }))
  let page = null

  async function openPage() {
    if (page && !page.isClosed()) await page.close().catch(() => {})
    page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1 })
    page.on("crash", () => { console.error("the page crashed; it will be reopened"); page.close().catch(() => {}) })
    await page.goto(options.base, { waitUntil: "load" })
    await page.waitForFunction(`window.Stimulus && ${CONTROLLER}?.stage`, null, { timeout: 60000 })
    await page.evaluate(`(() => {
      const c = ${CONTROLLER}
      document.querySelector("#fit").scrollIntoView({ block: "start" })
      const radio = document.querySelector('input[name="body-type"][value="men"]')
      if (radio && !radio.checked) radio.click()
      c.fillExample()
      // Every try's result, as the page logs it.
      window.__looks = []
      const info = console.info.bind(console)
      console.info = (...args) => { if (args[0] === "[look]") window.__looks.push(args[1]); info(...args) }
    })()`)
  }

  const records = []
  const began = Date.now()
  try {
    for (const [n, handle] of handles.entries()) {
      const file = path.join(options.out, `${handle}.json`)
      if (options.resume && fs.existsSync(file)) { records.push(JSON.parse(fs.readFileSync(file, "utf8"))); continue }
      const record = { handle, link: `https://kith.com/products/${handle}`, tries: [], done: false, stuck: false }
      try {
        if (!page || page.isClosed()) await openPage()
        await page.evaluate(`(async () => {
          for (let i = 0; i < 8; i++) { const b = document.querySelector(".rail-remove"); if (!b) break; b.click(); await new Promise(r => setTimeout(r, 100)) }
          window.__looks = []
        })()`)
        await page.fill("#product-link", record.link)
        await page.click('[data-fitting-room-target="importButton"]')
        const start = Date.now()
        for (;;) {
          await sleep(POLL)
          if (Date.now() - start > CHECK_TIMEOUT) { record.skipped = "didn't finish in time"; break }
          const state = await page.evaluate(`(() => {
            const c = ${CONTROLLER}
            const error = c.importErrorTarget.hidden ? null : c.importErrorTarget.textContent.trim()
            const kinds = Object.keys(c.outfit)
            const g = c.outfit.top?.garment
            return { error, kinds, name: g?.name ?? null, done: Boolean(g?.lookDone), stuck: Boolean(g && c.lookStuckOn === g), checks: g?.lookChecks ?? null, importing: c.importButtonTarget.disabled }
          })()`)
          if (state.error && !state.kinds.length) { record.skipped = `import failed: ${state.error}`; break }
          if (state.kinds.length && !state.kinds.includes("top") && !state.importing) { record.skipped = `not a top (${state.kinds.join(", ")})`; break }
          if (state.done || state.stuck) {
            Object.assign(record, { name: state.name, done: state.done, stuck: state.stuck, final: state.checks })
            break
          }
        }
        record.tries = await page.evaluate("window.__looks ?? []")
        if (!record.skipped) {
          // The side-by-side is of the first try's reading only when it passed first time; otherwise of the
          // reading it ended on (the first try's numbers are in tries[0]).
          const png = await page.evaluate(SIDE_BY_SIDE).catch(() => null)
          if (png) fs.writeFileSync(path.join(options.out, `${handle}.png`), Buffer.from(png, "base64"))
        }
      } catch (error) {
        record.skipped = `error: ${error.message.split("\n")[0]}`
        await openPage().catch(() => {})
      }
      record.outcome = outcomeOf(record)
      fs.writeFileSync(file, JSON.stringify(record, null, 2))
      records.push(record)
      const minutes = Math.round((Date.now() - began) / 60000)
      say(`${n + 1}/${handles.length} ${handle}: ${record.outcome}${record.tries[0] ? ` (first try: ${record.tries[0].failed.join(", ")})` : ""}  [${minutes} min]`)
      await sleep(BETWEEN_IMPORTS)
    }
  } finally {
    await browser.close().catch(() => {})
  }
  const summary = summarize(records)
  fs.writeFileSync(path.join(options.out, "report.json"), JSON.stringify({ when: new Date().toISOString(), summary, records }, null, 2))
  fs.writeFileSync(path.join(options.out, "index.html"), reportHtml(summary, records))
  say(`\n${summary.tops} tops checked (${summary.skipped} skipped). ${Object.entries(summary.outcomes).map(([k, v]) => `${k}: ${v}`).join(", ")}`)
  say(`First-try failures by check: ${Object.entries(summary.firstFailures).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`)
  say(`Report: ${path.join(options.out, "index.html")}`)
  return { summary, records }
}

export function reportHtml(summary, records) {
  const escape = s => String(s ?? "").replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)
  const scores = checks => Object.entries(checks ?? {}).map(([k, v]) => `${k} ${v.pass ? "ok" : "<b>off</b>"} ${typeof v.score === "number" ? v.score : escape(v.score ?? "")}${v.size ? ` size ${v.size}` : ""}${v.shape ? ` shape ${v.shape}` : ""}`).join(" · ")
  const cards = records.filter(r => !r.skipped).map(r => `
    <section><h2>${escape(r.name ?? r.handle)} <small>${escape(r.outcome)}</small></h2>
      <p><a href="${escape(r.link)}">${escape(r.handle)}</a></p>
      <p>First try: ${scores(r.tries[0]?.checks ?? r.final?.checks)}</p>
      <img src="${escape(r.handle)}.png" loading="lazy"></section>`).join("")
  return `<!doctype html><meta charset="utf-8"><title>Look audit</title>
<style>body{font:14px system-ui;margin:24px;max-width:1100px}section{border-top:1px solid #ddd;padding:12px 0}img{max-width:100%}small{color:#666;font-weight:400}</style>
<h1>Look audit</h1><p>${summary.tops} tops checked, ${summary.skipped} skipped. ${Object.entries(summary.outcomes).map(([k, v]) => `${escape(k)}: ${v}`).join(", ")}.</p>
<p>First-try failures by check: ${Object.entries(summary.firstFailures).map(([k, v]) => `${escape(k)} ${v}`).join(", ") || "none"}.</p>${cards}`
}

if (import.meta.url === `file://${process.argv[1]}`) {
  lookAudit(parseLookArgs(process.argv.slice(2))).catch(error => { console.error(error.message); process.exit(1) })
}
