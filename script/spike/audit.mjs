// Audits the outfit scenarios (docs/outfits.json: 67 of them) in the running app, on the Mac:
//
//   bin/dev                                   # the app, on http://localhost:3000
//   node script/spike/audit.mjs [--outfits 1-67] [--body men|women|both] [--out tmp/audit] [--base http://localhost:3000] [--resume]
//
// For each outfit, on each mannequin (the example bodies): the outfit is cleared, each piece is added from
// its Kith link in order, and once the cloth is still the figure is photographed from the front and from
// behind. What the page knows about every piece (kind, style, chart, the size picked and its verdicts,
// timings, errors) goes into NAME.json with red flags worked out from it (see flagsFor in lib.mjs), and a
// contact sheet (shop photo | front | back | words) into sheet-NN-body.png. report.json gathers every
// outfit; index.html links the sheets. NAME is NN-men-tee-and-jeans (the outfit's number, body and name).
//
// Resilient: a piece that fails never stops the run, a page that crashes is reopened, imports are 2 s
// apart (Kith rate-limits) and retried once on a network-looking error, and --resume skips outfits whose
// front.png and json are already there. About a minute a piece, so ~2 h for the first 37.
//
// Needs Playwright (`npm i -g playwright`); it drives the Chrome already installed. Nothing of a person is
// involved: the mannequins wear the example numbers.
import { createRequire } from "node:module"
import { execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { checkAppRunning } from "./inputs.mjs"
import { auditName, extensionFor, flagsFor, indexHtml, parseAuditArgs, sheetHtml, summaryLines } from "./lib.mjs"

const PLAYWRIGHT_VERSION = "1.64.1"
const DRAPE_TIMEOUT = Number(process.env.AUDIT_DRAPE_TIMEOUT) || 240000   // the env for a quick test page
const POLL = 500
const BETWEEN_IMPORTS = 2000
const RETRY_WAIT = 5000
const NETWORK_ERROR = /can't reach|took too long|failed to fetch|network|rate|429|too many|timed? ?out|didn't answer|try again/i
const USAGE = "Usage: node script/spike/audit.mjs [--outfits 1-67] [--body men|women|both] [--out tmp/audit] [--base http://localhost:3000] [--resume]"
const OUTFITS_FILE = process.env.AUDIT_OUTFITS_FILE ?? fileURLToPath(new URL("../../docs/outfits.json", import.meta.url))   // the env for a quick test page

function loadPlaywright() {
  const require = createRequire(import.meta.url)
  const candidates = [process.env.PLAYWRIGHT_MODULE, "playwright"]
  try { candidates.push(path.join(execSync("npm root -g", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(), "playwright")) } catch {}
  for (const candidate of candidates.filter(Boolean)) {
    try { return require(candidate) } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error }
  }
  throw new Error(`Playwright isn't installed. Once: npm i -g playwright@${PLAYWRIGHT_VERSION}   (it drives the Chrome you have; no browser download; or point PLAYWRIGHT_MODULE at a node_modules/playwright)`)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const CONTROLLER = `Stimulus.getControllerForElementAndIdentifier(document.querySelector('[data-controller=fitting-room]'), 'fitting-room')`
export const linkFor = handle => `https://kith.com/products/${handle}`

// Runs the audit. `options` as parseAuditArgs gives them, plus `outfits` (the list from docs/outfits.json;
// read from there when not given). `say` takes the progress lines. Resolves to the report.
export async function audit(options, say = console.log) {
  const all = options.outfitList ?? JSON.parse(fs.readFileSync(OUTFITS_FILE, "utf8")).outfits
  await checkAppRunning(options.base)
  const { chromium } = loadPlaywright()
  fs.mkdirSync(options.out, { recursive: true })

  async function launch() {
    try {
      return await chromium.launch({ channel: "chrome", headless: true })
    } catch (error) {
      console.error(`(Chrome itself didn't start: ${error.message.split("\n")[0]}; using Playwright's Chromium)`)
      return chromium.launch({ headless: true })
    }
  }

  const browser = await launch()
  let page = null, body = null

  // The app's page, fresh: a new one when there is none or the last one crashed. The drape runs only while
  // the stage is on screen, so the window is large and the page is scrolled to it.
  async function openPage() {
    if (page && !page.isClosed()) await page.close().catch(() => {})
    page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1 })
    page.on("pageerror", e => console.error("page error:", e.message))
    page.on("crash", () => { console.error("the page crashed; it will be reopened"); page.close().catch(() => {}) })
    if (process.env.VERBOSE) page.on("console", m => console.error("console:", m.text()))
    await page.goto(options.base, { waitUntil: "load" })
    await page.waitForFunction(`window.Stimulus && ${CONTROLLER}?.stage`, null, { timeout: 60000 })
    await page.evaluate(() => document.querySelector("#fit").scrollIntoView({ block: "start" }))
    body = null
  }

  async function ensurePage() {
    if (!page || page.isClosed()) await openPage()
  }

  // The mannequin: the body-type radio, then the example numbers for that body (fillExample), then no clothes.
  async function setBody(type) {
    await page.evaluate(`(() => {
      const c = ${CONTROLLER}
      const radio = document.querySelector('input[name="body-type"][value=${JSON.stringify(type)}]')
      if (radio && !radio.checked) radio.click()
      c.fillExample()
    })()`)
    body = type
    await sleep(300)
    await clearOutfit()
  }

  async function clearOutfit() {
    for (let i = 0; i < 8; i++) {
      const removed = await page.evaluate(() => { const b = document.querySelector(".rail-remove"); if (b) b.click(); return Boolean(b) })
      if (!removed) break
      await sleep(100)
    }
  }

  // Everything the page knows about the item of a kind: see docs/ai-spike.md, "Auditing the 37 outfits".
  const ITEM_STATE = `(kind => {
    const c = ${CONTROLLER}
    const item = c.outfit[kind]
    if (!item) return null
    const g = item.garment, fit = item.fit, selected = item.selected
    const result = fit?.sizes?.find(s => s.size === selected) ?? null
    return {
      name: g.name ?? null, brand: g.brand ?? null, kind, style: g.style ?? null, fabric: g.fabric ?? null, cut: g.cut ?? null,
      zip: Boolean(g.zip), women: Boolean(g.women), onePiece: Boolean(g.one_piece), colorName: g.color_name ?? null, color: g.color ?? null,
      chart: { kind: g.chart?.kind ?? null, missing: g.chart?.missing ?? [], sizes: (g.chart?.sizes ?? []).map(s => s.name), unit: g.chart?.unit ?? null },
      guessed: ["body", "sizes"].includes(g.chart?.kind),
      selected: selected ?? null, best: fit?.best ?? null, verdict: result?.verdict ?? null,
      checks: (result?.checks ?? []).map(({ part, label, status, ease_cm, fix, fixable, note }) => ({ part, label, status, ease_cm: ease_cm ?? null, fix: fix ?? null, fixable: fixable ?? null, note: note ?? null })),
      photo: Boolean(g.photo), photoRead: Boolean(g.photoColor), printRead: Boolean(g.print?.image), backPrintRead: Boolean(g.backPrint),
      photoMapRead: Boolean(g.photoMap), shoeSideRead: Boolean(g.shoeSide), cleaned: Boolean(g.cleaned),
      sourceUrl: g.source_url ?? null
    }
  })`

  // Pastes the link, clicks Add and waits until the new item is fitted, draped and still (or the page shows
  // an import error). Returns { kind, state, importMs, drapeMs, settled, error, replaced }.
  async function addLink(link) {
    await page.evaluate(`(() => {
      const c = ${CONTROLLER}
      window.__auditBefore = new Set(Object.values(c.outfit).map(i => i.garment))
      window.__auditKinds = Object.keys(c.outfit)
    })()`)
    await page.fill("#product-link", link)
    await page.click('[data-fitting-room-target="importButton"]')
    const began = Date.now()
    let imported = null, stable = 0, kind = null
    while (Date.now() - began < DRAPE_TIMEOUT) {
      await sleep(POLL)
      const state = await page.evaluate(`(() => {
        const c = ${CONTROLLER}
        const error = c.importErrorTarget.hidden ? null : c.importErrorTarget.textContent.trim()
        const entry = Object.entries(c.outfit).find(([, i]) => !window.__auditBefore.has(i.garment))
        const importing = c.importButtonTarget.disabled || c.importButtonTarget.textContent.trim() !== "Add"
        if (!entry) return { error, kind: null, importing }
        const [kind, item] = entry
        const g = item.garment
        return {
          error, kind, importing, photo: Boolean(g.photo), photoRead: Boolean(g.photoColor), fit: Boolean(item.fit),
          settled: c.stage.settled, loading: !c.loadingTarget.hidden, bodyType: c.bodyType,
          replaced: window.__auditKinds.includes(kind) ? kind : null
        }
      })()`)
      if (state.error && !state.kind) return { kind: null, error: state.error, importMs: Date.now() - began }
      if (!state.kind) continue
      kind = state.kind
      imported ??= Date.now()
      if (["shoes", "socks", "belt"].includes(kind) && !state.importing) {
        return { kind, importMs: imported - began, drapeMs: Date.now() - imported, settled: true, replaced: state.replaced, bodyType: state.bodyType, error: null }
      }
      const waited = Date.now() - began
      const photoReady = !state.photo || state.photoRead || waited > 90000
      const ready = state.fit && state.settled && !state.loading && !state.importing && photoReady
      stable = ready ? stable + 1 : 0
      if (stable >= 3) return { kind, importMs: imported - began, drapeMs: Date.now() - imported, settled: true, replaced: state.replaced, bodyType: state.bodyType, error: null }
    }
    return { kind, importMs: imported ? imported - began : Date.now() - began, drapeMs: imported ? Date.now() - imported : null, settled: false, error: kind ? null : `gave up after ${Math.round(DRAPE_TIMEOUT / 1000)} s` }
  }

  // The page's warnings and stage note, as shown.
  const SHOWN = `(() => {
    const c = ${CONTROLLER}
    return {
      warnings: c.warningsTarget.hidden ? [] : [...c.warningsTarget.querySelectorAll("p")].map(p => p.textContent.trim()),
      note: c.hasStageNoteTarget ? c.stageNoteTarget.textContent.trim() : null
    }
  })()`

  // Waits for the whole outfit to be still and the loader gone (after the last piece, the layers settle again).
  async function waitSettled() {
    const began = Date.now()
    let stable = 0
    while (Date.now() - began < DRAPE_TIMEOUT) {
      const ready = await page.evaluate(`(() => { const c = ${CONTROLLER}; return c.stage.settled && c.loadingTarget.hidden })()`)
      stable = ready ? stable + 1 : 0
      if (stable >= 3) return true
      await sleep(POLL)
    }
    return false
  }

  // The outfit from the front, then from behind (the camera turned half round and put back). Base64 PNGs.
  async function photograph() {
    return page.evaluate(`(async () => {
      const c = ${CONTROLLER}, stage = c.stage
      const b64 = async blob => {
        const bytes = new Uint8Array(await blob.arrayBuffer())
        let s = ""
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
        return btoa(s)
      }
      const size = { width: 768, height: 1152, guides: false }
      const front = await b64((await stage.photoPasses({ ...size, front: true })).image)
      const facing = stage.faceFront()
      let back = null
      try {
        stage.turnCamera(Math.PI)
        stage.controls.update()
        stage.draw()
        back = await b64((await stage.photoPasses({ ...size, front: false })).image)
      } finally {
        stage.camera.position.copy(facing.position)
        stage.controls.update()
        stage.draw()
      }
      return { front, back }
    })()`)
  }

  // The shop's photo of the item of a kind, as the page holds it: { type, data (base64) } or { url } when
  // the page can't fetch it (CORS), or null.
  async function shopPhoto(kind) {
    const shot = await page.evaluate(`(async kind => {
      const c = ${CONTROLLER}
      const photo = c.outfit[kind]?.garment.photo
      if (!photo) return null
      const b64 = async blob => {
        const bytes = new Uint8Array(await blob.arrayBuffer())
        let s = ""
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
        return btoa(s)
      }
      try {
        const response = await fetch(photo)
        const blob = await response.blob()
        return { type: blob.type || response.headers.get("content-type") || "", data: await b64(blob) }
      } catch { return { url: photo } }
    })(${JSON.stringify(kind)})`)
    if (shot?.url) {
      try {
        const response = await fetch(shot.url, { signal: AbortSignal.timeout(20000) })
        return { type: response.headers.get("content-type") ?? "", data: Buffer.from(await response.arrayBuffer()).toString("base64") }
      } catch { return null }
    }
    return shot
  }

  const report = { when: new Date().toISOString(), base: options.base, outfits: [] }
  const sheetPage = await browser.newPage({ viewport: { width: 1448, height: 1000 }, deviceScaleFactor: 1 })
  const totalBegan = Date.now()

  try {
    for (const number of options.outfits) {
      const outfit = all[number - 1]
      if (!outfit) { say(`outfit ${number}: not in docs/outfits.json`); continue }
      for (const bodyType of options.bodies) {
        const handles = outfit[bodyType] ?? []
        if (!handles.length) continue
        const name = auditName(number, bodyType, outfit.name)
        const jsonFile = path.join(options.out, `${name}.json`)
        const frontFile = path.join(options.out, `${name}-front.png`)
        const sheetFile = `sheet-${String(number).padStart(2, "0")}-${bodyType}.png`
        if (options.resume && fs.existsSync(jsonFile) && fs.existsSync(frontFile)) {
          try {
            const kept = JSON.parse(fs.readFileSync(jsonFile, "utf8"))
            report.outfits.push(summarize(kept, sheetFile, `${name}.json`))
            say(`\n${name}: already done (${kept.items.length} items, ${kept.flags} flags), skipped`)
            continue
          } catch { /* unreadable: run it again */ }
        }
        say(`\n${name}  (${handles.length} pieces)`)
        const began = Date.now()
        const result = { name, number, outfitName: outfit.name, body: bodyType, when: new Date().toISOString(), items: [], pictures: {}, settled: null, error: null }
        try {
          // A fresh page per outfit: an import that gave up in the outfit before may still answer, and must not
          // land on this one's mannequin.
          if (page && !page.isClosed()) await page.close().catch(() => {})
          page = null
          await ensurePage()
          await setBody(bodyType)
          for (const [i, handle] of handles.entries()) {
            if (i > 0) await sleep(BETWEEN_IMPORTS)
            const link = linkFor(handle)
            const item = { handle, link, index: i, flags: [] }
            try {
              await ensurePage()
              let added = await addLink(link)
              // Kith answers a burst of imports with "too many requests" for a while: wait it out, longer each time.
              for (let attempt = 1; attempt <= 3 && added.error && NETWORK_ERROR.test(added.error); attempt++) {
                const wait = RETRY_WAIT * attempt * attempt
                say(`  ${handle}: ${added.error} — waiting ${Math.round(wait / 1000)} s, then trying again (${attempt}/3)`)
                await sleep(wait)
                added = await addLink(link)
              }
              Object.assign(item, { kind: added.kind, importMs: added.importMs, drapeMs: added.drapeMs ?? null, settled: added.settled ?? null, replaced: added.replaced ?? null })
              if (added.error) {
                item.importError = added.error
                item.unsupported = /can't try (?:on|this)/i.test(added.error)
              } else {
                Object.assign(item, await page.evaluate(`${ITEM_STATE}(${JSON.stringify(added.kind)})`))
                const shown = await page.evaluate(SHOWN)
                item.warnings = shown.warnings
                item.note = shown.note
                // A women's piece makes the page switch to the woman mannequin; the audit wants the one asked for.
                if (added.bodyType && added.bodyType !== bodyType) {
                  item.bodyFlipped = true
                  await page.evaluate(`document.querySelector('input[name="body-type"][value=${JSON.stringify(bodyType)}]').click()`)
                  await sleep(300)
                  await waitSettled()
                }
                const photo = await shopPhoto(added.kind)
                if (photo?.data) {
                  const file = `${name}-${i + 1}-${handle}.${extensionFor(photo.type)}`
                  fs.writeFileSync(path.join(options.out, file), Buffer.from(photo.data, "base64"))
                  item.photoFile = file
                  item.photoType = photo.type
                }
              }
            } catch (error) {
              item.importError = `the page broke: ${error.message.split("\n")[0]}`
              await openPage().catch(() => {})
              if (page && !page.isClosed()) await setBody(bodyType).catch(() => {})
            }
            item.flags = flagsFor(item)
            result.items.push(item)
            say(`  ${handle}: ${item.importError ? `✗ ${item.importError}` : `${item.name} · ${item.kind}${item.style ? `/${item.style}` : ""} · ${item.selected ?? "?"} · ${Math.round((item.importMs ?? 0) / 1000)} + ${Math.round((item.drapeMs ?? 0) / 1000)} s`}${item.flags.length ? ` · ⚑ ${item.flags.length}` : ""}`)
          }
          result.settled = await waitSettled()
          if (!result.settled) for (const item of result.items) if (!item.importError && !item.flags.includes("drape not settled in 4 min")) item.flags.push("drape not settled in 4 min")
          const shown = await page.evaluate(SHOWN)
          result.warnings = shown.warnings
          result.note = shown.note
          // Which pieces are still on at the end (a later piece of the same kind replaces an earlier one).
          const onNow = await page.evaluate(`Object.fromEntries(Object.entries(${CONTROLLER}.outfit).map(([k, i]) => [k, i.garment.name ?? null]))`)
          for (const item of result.items) item.onAtEnd = !item.importError && onNow[item.kind] === item.name
          const shot = await photograph()
          fs.writeFileSync(frontFile, Buffer.from(shot.front, "base64"))
          result.pictures.front = `${name}-front.png`
          if (shot.back) { fs.writeFileSync(path.join(options.out, `${name}-back.png`), Buffer.from(shot.back, "base64")); result.pictures.back = `${name}-back.png` }
        } catch (error) {
          result.error = error.message.split("\n")[0]
          say(`  couldn't finish: ${result.error}`)
          await openPage().catch(() => {})
        }
        result.ms = Date.now() - began
        result.flags = result.items.reduce((n, item) => n + item.flags.length, 0)
        fs.writeFileSync(jsonFile, JSON.stringify(result, null, 2))
        try {
          await makeSheet(sheetPage, options.out, result, sheetFile)
        } catch (error) {
          say(`  (no sheet: ${error.message.split("\n")[0]})`)
        }
        report.outfits.push(summarize(result, sheetFile, `${name}.json`))
        say(`  ${result.items.length} items, ${result.flags} flags, ${Math.round(result.ms / 1000)} s → ${sheetFile}`)
        writeReport(options.out, report)
      }
    }
  } finally {
    await browser.close()
  }

  writeReport(options.out, report)
  say(`\n${options.out}/report.json and index.html, after ${Math.round((Date.now() - totalBegan) / 60000)} min\n`)
  for (const line of summaryLines(report)) say(line)
  return report
}

function summarize(result, sheet, json) {
  return { number: result.number, outfitName: result.outfitName, body: result.body, name: result.name, items: result.items.map(i => ({ handle: i.handle, name: i.name ?? null, kind: i.kind ?? null, style: i.style ?? null, selected: i.selected ?? null, importError: i.importError ?? null, flags: i.flags })), flags: result.flags, error: result.error ?? null, sheet, json, ms: result.ms ?? null }
}

function writeReport(out, report) {
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2))
  fs.writeFileSync(path.join(out, "index.html"), indexHtml(report))
}

// The contact sheet: an HTML page with the pictures as data: URLs, screenshotted whole in the same browser.
async function makeSheet(sheetPage, out, result, sheetFile) {
  const dataUrl = (file, type) => {
    if (!file) return null
    try { return `data:${type || "image/png"};base64,${fs.readFileSync(path.join(out, file)).toString("base64")}` } catch { return null }
  }
  const items = result.items.map(item => ({ ...item, photoData: dataUrl(item.photoFile, item.photoType) }))
  const pictures = { front: dataUrl(result.pictures.front), back: dataUrl(result.pictures.back) }
  await sheetPage.setContent(sheetHtml({ number: result.number, outfitName: result.outfitName, body: result.body, items, pictures, flags: result.flags }), { waitUntil: "load" })
  await sheetPage.screenshot({ path: path.join(out, sheetFile), fullPage: true })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fail = message => { console.error(message); process.exit(1) }
  let options
  const count = JSON.parse(fs.readFileSync(OUTFITS_FILE, "utf8")).outfits.length
  try { options = parseAuditArgs(process.argv.slice(2), count) } catch (error) { fail(`${error.message}\n${USAGE}`) }
  try {
    await audit(options)
  } catch (error) {
    fail(error.message)
  }
}
