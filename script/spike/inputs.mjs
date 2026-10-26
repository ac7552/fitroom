// Makes the AI try-on spike's inputs from the running app, one store link at a time, on the Mac:
//
//   bin/dev                                   # the app, on http://localhost:3000
//   node script/spike/inputs.mjs https://kith.com/products/... [more links] [--base http://localhost:3000] [--out tmp/spike] [--body men|women]
//
// For each link it opens the page in a headless Chrome, pastes the link into "Paste a link from a store",
// clicks Add, waits for the fit and for the cloth to settle, then saves what the Colab notebook wants
// (docs/ai-spike.md, "The sheet folder"): NAME-person.png (the render, from the front), NAME-outline.png
// (the figure's outline), NAME-garment.jpg (the shop's photo), NAME-category.txt (tops or bottoms), and
// NAME-print.png when the page read a print. Then everything goes into tmp/spike/spike.zip for the notebook.
//
// Needs Playwright (`npm i -g playwright`); it drives the Chrome already installed, so no browser download.
// Nothing of a person is involved: the mannequin wears the example measurements.
import { createRequire } from "node:module"
import { execSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { categoryFor, extensionFor, parseArgs, slugFor, uniqueName, writeStoreZip } from "./lib.mjs"

const PLAYWRIGHT_VERSION = "1.64.1"
const DRAPE_TIMEOUT = 240000
const POLL = 500

function fail(message) {
  console.error(message)
  process.exit(1)
}

function loadPlaywright() {
  const require = createRequire(import.meta.url)
  const candidates = [process.env.PLAYWRIGHT_MODULE, "playwright"]
  try { candidates.push(path.join(execSync("npm root -g", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(), "playwright")) } catch {}
  for (const candidate of candidates.filter(Boolean)) {
    try { return require(candidate) } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error }
  }
  fail(`Playwright isn't installed. Once: npm i -g playwright@${PLAYWRIGHT_VERSION}   (it drives the Chrome you have; no browser download; or point PLAYWRIGHT_MODULE at a node_modules/playwright)`)
}

let options
try { options = parseArgs(process.argv.slice(2)) } catch (error) { fail(`${error.message}\nUsage: node script/spike/inputs.mjs LINK [LINK...] [--base http://localhost:3000] [--out tmp/spike] [--body men|women]`) }
if (options.links.length === 0) fail("Give at least one store link.\nUsage: node script/spike/inputs.mjs LINK [LINK...] [--base http://localhost:3000] [--out tmp/spike] [--body men|women]")

// The app has to be up first.
try {
  const response = await fetch(options.base, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
} catch (error) {
  fail(`Fitroom isn't running at ${options.base} (${error.cause?.code ?? error.message}). Start it with bin/dev, then run this again.`)
}

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
// The drape runs only while the stage is on screen, so the window is large and the page is scrolled to it.
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1 })
page.on("pageerror", e => console.error("page error:", e.message))
if (process.env.VERBOSE) page.on("console", m => console.error("console:", m.text()))

// In the page, the fitting room's controller.
const CONTROLLER = `Stimulus.getControllerForElementAndIdentifier(document.querySelector('[data-controller=fitting-room]'), 'fitting-room')`

async function openPage() {
  await page.goto(options.base, { waitUntil: "load" })
  await page.waitForFunction(`window.Stimulus && ${CONTROLLER}?.stage`, null, { timeout: 60000 })
  await page.evaluate(() => document.querySelector("#fit").scrollIntoView({ block: "start" }))
  if (options.body === "women") await page.evaluate(() => document.querySelector('input[name="body-type"][value="women"]').click())
  await clearOutfit()
}

// Every item off the rail (the page starts with one of its own on).
async function clearOutfit() {
  for (let i = 0; i < 8; i++) {
    const removed = await page.evaluate(() => { const b = document.querySelector(".rail-remove"); if (b) b.click(); return Boolean(b) })
    if (!removed) break
    await sleep(100)
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Pastes the link, clicks Add, and waits until the item is fitted, draped and still. Returns what the
// page knows about the new item, or throws with the page's own message.
async function addLink(link) {
  await page.evaluate(`window.__spikeBefore = new Set(Object.values(${CONTROLLER}.outfit).map(i => i.garment))`)
  await page.fill("#product-link", link)
  await page.click('[data-fitting-room-target="importButton"]')
  const began = Date.now()
  let stable = 0
  while (Date.now() - began < DRAPE_TIMEOUT) {
    await sleep(POLL)
    const state = await page.evaluate(`(() => {
      const c = ${CONTROLLER}
      const error = c.importErrorTarget.hidden ? null : c.importErrorTarget.textContent.trim()
      const entry = Object.entries(c.outfit).find(([, i]) => !window.__spikeBefore.has(i.garment))
      if (!entry) return { error, kind: null }
      const [kind, item] = entry
      const g = item.garment
      return {
        error, kind, name: g.name ?? null, photo: Boolean(g.photo), photoRead: Boolean(g.photoColor), print: Boolean(g.print?.image),
        fit: Boolean(item.fit), settled: c.stage.settled, loading: !c.loadingTarget.hidden,
        importing: c.importButtonTarget.disabled || c.importButtonTarget.textContent.trim() !== "Add"
      }
    })()`)
    if (state.error) throw new Error(state.error)
    if (!state.kind) continue
    if (categoryFor(state.kind) === null) return state
    const waited = Date.now() - began
    // The photo's colour and print are read after the import; a long wait on that and we go without.
    const photoReady = !state.photo || state.photoRead || waited > 90000
    const ready = state.fit && state.settled && !state.loading && !state.importing && photoReady
    stable = ready ? stable + 1 : 0
    if (stable >= 3) return state
  }
  throw new Error(`gave up after ${Math.round(DRAPE_TIMEOUT / 1000)} s: the cloth never settled (is the page's tab visible to Chrome?)`)
}

// The pictures, in the page: the render and the figure's outline from the front, the shop's photo as the
// page holds it, and the print's front if it read one. Each as base64, like render.mjs' --photo path.
async function photograph(kind) {
  return page.evaluate(`(async () => {
    const c = ${CONTROLLER}
    const b64 = async blob => {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let s = ""
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
      return btoa(s)
    }
    const passes = await c.stage.photoPasses({ width: 1024, height: 1536, guides: true, front: true })
    const item = c.outfit[${JSON.stringify(kind)}]
    let garment = null
    if (item.garment.photo) {
      try {
        const response = await fetch(item.garment.photo)
        const blob = await response.blob()
        garment = { type: blob.type || response.headers.get("content-type") || "", data: await b64(blob) }
      } catch {
        garment = { url: item.garment.photo }   // a store's URL the page can't fetch (CORS): Node fetches it
      }
    }
    let print = null
    const image = item.garment.print?.image
    if (image) {
      const blob = image.convertToBlob ? await image.convertToBlob() : await new Promise(r => image.toBlob(r))
      if (blob) print = await b64(blob)
    }
    return { person: await b64(passes.image), outline: await b64(passes.mask), garment, print }
  })()`)
}

const taken = new Set()
const written = []
let opened = false
for (const link of options.links) {
  console.log(`\n${link}`)
  try {
    if (!opened) { await openPage(); opened = true }
    const state = await addLink(link)
    const category = categoryFor(state.kind)
    if (category === null) {
      console.log(`  ${state.name ?? state.kind}: ${state.kind} aren't painted by the try-on models, skipped`)
      await clearOutfit()
      continue
    }
    const name = uniqueName(slugFor(state.name, link), taken)
    taken.add(name)
    const shot = await photograph(state.kind)
    if (shot.garment?.url) {
      const response = await fetch(shot.garment.url, { signal: AbortSignal.timeout(20000) })
      shot.garment = { type: response.headers.get("content-type") ?? "", data: Buffer.from(await response.arrayBuffer()).toString("base64") }
    }
    const save = (file, data) => { fs.writeFileSync(path.join(options.out, file), data); written.push(file) }
    save(`${name}-person.png`, Buffer.from(shot.person, "base64"))
    save(`${name}-outline.png`, Buffer.from(shot.outline, "base64"))
    if (shot.garment) save(`${name}-garment.${extensionFor(shot.garment.type)}`, Buffer.from(shot.garment.data, "base64"))
    else console.log("  (the store gave no photo of it: the notebook needs a NAME-garment.jpg; add one by hand)")
    if (shot.print) save(`${name}-print.png`, Buffer.from(shot.print, "base64"))
    save(`${name}-category.txt`, `${category}\n`)
    console.log(`  ${name} (${state.kind} -> ${category})${state.photo && !state.photoRead ? " — the photo's print wasn't read in time; the render is the plain colour" : ""}`)
    await clearOutfit()
  } catch (error) {
    console.log(`  couldn't: ${error.message}`)
    // A fresh page for the next link, whatever state this one left.
    opened = false
  }
}
await browser.close()

if (written.length === 0) fail("\nNothing was made.")

// One zip for the notebook's upload cell.
const zipFile = path.join(options.out, "spike.zip")
fs.rmSync(zipFile, { force: true })
const zipped = spawnSync("zip", ["-q", "-j", zipFile, ...written.map(f => path.join(options.out, f))], { stdio: "inherit" })
if (zipped.error || zipped.status !== 0) writeStoreZip(zipFile, written.map(f => ({ name: f, data: fs.readFileSync(path.join(options.out, f)) })))

console.log(`\n${options.out}/`)
for (const file of fs.readdirSync(options.out).sort()) {
  const size = fs.statSync(path.join(options.out, file)).size
  console.log(`  ${file}  ${size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(size / 1024)} KB`}`)
}
console.log(`\nNext: open the Colab notebook (docs/ai-spike.md, "Running on Google Colab"), Runtime > Run all, and upload ${zipFile} when it asks.`)
