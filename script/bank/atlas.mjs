// The drape atlas: fills the drape bank (lib/garments/drape_bank.js) without any shop links, by draping every
// draped style on each body type at a ladder of sizes, from scratch, headless, and saving each as an entry in
// public/drapes/ (beside the entries script/bank/build.js made from real listings, which it keeps). A bank
// entry starts any garment of its style within 20% of its measurements, so sizes a quarter apart cover the
// range shops sell. Nothing about anyone is in it: the bodies are the page's example bodies.
//
// Run where the repo is checked out (on the droplet, or a laptop), with the headless harness's server:
//
//   python3 script/headless/serve.py 8787 &
//   node script/bank/atlas.mjs [--styles tee,hoodie] [--bodies men,women] [--force] [--base http://127.0.0.1:8787]
//
// then rebuild the web image (the entries are served from public/drapes/). On the droplet it runs in
// Playwright's image, see docs/droplet.md ("The drape atlas"). --force drapes again what's already there;
// otherwise a style and size the bank already covers (within 10%) is skipped.
import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE ?? "playwright")
const args = Object.fromEntries(process.argv.slice(2).reduce((list, a, i, all) => {
  if (a.startsWith("--")) list.push([a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]])
  return list
}, []))
const base = args.base ?? "http://127.0.0.1:8787"
const OUT = path.resolve(args.out ?? "public/drapes")

// The page's example bodies (render.mjs's EXAMPLES).
const BODIES = {
  men: { chest: 101.6, waist: 86.4, shoulders: 45.5, arm: 65.5, height: 178, hips: 101, inseam: 81 },
  women: { chest: 91.5, waist: 74, shoulders: 39.5, arm: 58, height: 165, hips: 99, inseam: 76 }
}
// Tops by chest (cm round, the garment's), each size about 25% from the next; pants by waist.
const CHESTS = { men: [96, 120, 150], women: [86, 108, 135] }
const WAISTS = { men: [72, 90, 112], women: [64, 80, 100] }
// The draped styles (stage.js's DRAPED_STYLES bar the dress, whose cuts are too many to ladder; and pants'
// BOTTOM_STYLES), each with its fabric and how its size reads off the chest or waist.
const TOPS = {
  tee: "jersey", longsleeve: "jersey", sweatshirt: "fleece", hoodie: "fleece", zip: "fleece", bomber: "nylon",
  shirt: "cotton", shortshirt: "cotton", polo: "jersey", rugby: "cotton", tank: "jersey", sweater: "wool",
  shortknit: "wool", cardigan: "wool", coat: "wool"
}
const SHORT = new Set(["tee", "shortshirt", "polo", "shortknit"])
const BOTTOMS = { trousers: "twill", jeans: "denim", joggers: "fleece", leggings: "stretch", shorts: "cotton", skirt: "wool" }
const KIND = style => (["zip", "bomber", "coat", "cardigan"].includes(style) ? "jacket" : "top")

function topSize(style, chest, body) {
  const long = style === "coat"
  return {
    chest, shoulders: Math.round(chest * 0.44), sleeve: SHORT.has(style) ? 22 : style === "tank" ? undefined : Math.round(body.arm * 0.95),
    length: Math.round(long ? body.height * 0.55 : chest * 0.63)
  }
}
function bottomSize(style, waist, body) {
  if (style === "skirt") return { waist, seat: Math.round(waist * 1.25), length: 60 }
  const shorts = style === "shorts"
  return {
    waist, seat: Math.round(waist * 1.22), thigh: Math.round(waist * 0.72), inseam: shorts ? 20 : body.inseam,
    leg_opening: style === "leggings" ? 22 : style === "joggers" ? 26 : shorts ? 56 : 40
  }
}

const pick = (list, all) => (list ? String(list).split(",").filter(s => all.includes(s)) : all)
const bodies = pick(args.bodies, Object.keys(BODIES))
const tops = pick(args.styles, Object.keys(TOPS)), bottoms = pick(args.styles, Object.keys(BOTTOMS))

const indexFile = path.join(OUT, "index.json")
const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, "utf8")) : []
// Whether the bank has an entry of this style and body type within 10% of these measurements already.
function covered(style, bodyType, measures) {
  return index.some(e => e.style === style && e.bodyType === bodyType && Object.keys(measures).every(k => !Number.isFinite(e.measures[k]) || Math.abs(e.measures[k] - measures[k]) / measures[k] < 0.1))
}

const jobs = []
for (const bodyType of bodies) {
  for (const style of tops) for (const chest of CHESTS[bodyType]) jobs.push({ bodyType, item: { kind: KIND(style), style, size: topSize(style, chest, BODIES[bodyType]), color: "#8a8f99", fabric: TOPS[style] }, key: { chest } })
  for (const style of bottoms) for (const waist of WAISTS[bodyType]) jobs.push({ bodyType, item: { kind: "trousers", style, size: bottomSize(style, waist, BODIES[bodyType]), color: "#8a8f99", fabric: BOTTOMS[style] }, key: { waist } })
}

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] })
const page = await browser.newPage({ viewport: { width: 400, height: 600 } })
page.on("pageerror", e => console.error("page error:", e.message))
// (?bank=off: each drape from scratch; ?still=off: no averaging, nothing's looked at.)
await page.goto(`${base}/stage.html?bank=off&still=off&drape=page`)
await page.waitForFunction(() => window.stageReady, null, { timeout: 120000 })
let made = 0
for (const job of jobs) {
  if (!args.force && covered(job.item.style, job.bodyType, job.key)) { console.log("covered:", job.bodyType, job.item.style, JSON.stringify(job.key)); continue }
  const began = Date.now()
  const entry = await page.evaluate(async ({ item, bodyType, measures }) => {
    const stage = window.stage
    stage.drapeBudget = 1000
    stage.setOutfit([])
    stage.setBodyType(bodyType)
    stage.setBody(measures)
    stage.setOutfit([item])
    const slot = item.kind === "trousers" ? "bottom" : item.kind === "top" ? "top" : "outer"
    const deadline = performance.now() + 300000
    while (performance.now() < deadline) {
      stage.advanceDrape()
      await new Promise(r => setTimeout(r, 0))
      const d = stage.slots[slot]
      if (stage.settled && d?.top?.done && !d.posing && d.restBind) break
    }
    return stage.exportBankEntry(slot)
  }, { item: job.item, bodyType: job.bodyType, measures: BODIES[job.bodyType] })
  const seconds = Math.round((Date.now() - began) / 1000)
  if (!entry) { console.log("didn't settle:", job.bodyType, job.item.style, JSON.stringify(job.key), `${seconds}s`); continue }
  const m = entry.measures
  const file = `${entry.bodyType}-${entry.style}-${Math.round(m.chest ?? m.waist ?? 0)}-atlas.json`
  fs.writeFileSync(path.join(OUT, file), JSON.stringify(entry))
  const meta = { file, style: entry.style, bodyType: entry.bodyType, panels: entry.panels, measures: entry.measures, name: "atlas" }
  const at = index.findIndex(e => e.file === file)
  if (at >= 0) index[at] = meta; else index.push(meta)
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2) + "\n")
  made++
  console.log("saved:", file, `${seconds}s`)
}
await browser.close()
console.log(`${made} entries made; the bank has ${index.length}`)
