// The accuracy set, run without anyone at the browser: headless Chromium opens the fitting room (the Rails
// app, `bin/dev` or the droplet's web container), runs every listing in accuracy.json's runs as the README's
// console steps do, and holds the result to baseline.json (VAL.gate). It prints the gate and writes the run's
// score and checks to tmp/validation/<date>.json. Exits 1 when the gate fails, so a scheduled run can say so.
//
//   mkdir -p public/validation && cp script/validation/{runner.js,sheet.js,runs.json,accuracy.js,accuracy.json,baseline.json} public/validation/
//   node script/validation/nightly.mjs [--base http://localhost:3000] [--timeout 5400]
//
// On the droplet it runs in Playwright's image against the web container: see docs/droplet.md ("Checking
// accuracy every night"). Development only: public/validation/ is ignored by git and never ships.
import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE ?? "playwright")
const args = Object.fromEntries(process.argv.slice(2).reduce((list, a, i, all) => {
  if (a.startsWith("--")) list.push([a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]])
  return list
}, []))
const base = (args.base ?? "http://localhost:3000").replace(/\/$/, "")
const timeout = Number(args.timeout ?? 5400) * 1000

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] })
// A real window's size, in front (a hidden page is slowed down).
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.on("pageerror", e => console.error("page error:", e.message))
await page.goto(`${base}/#fit`, { waitUntil: "load" })
await page.waitForFunction(() => window.Stimulus?.getControllerForElementAndIdentifier(document.querySelector("[data-controller~=fitting-room]"), "fitting-room")?.stage, null, { timeout: 120000 })
const began = Date.now()
const result = await page.evaluate(async limit => {
  const VAL = (await import("/validation/runner.js")).default
  const set = await (await fetch("/validation/accuracy.json")).json()
  VAL.load(set.runs)
  VAL.start()
  const end = performance.now() + limit
  let state = null
  while (performance.now() < end) {
    state = await Promise.race([VAL.wait(), new Promise(r => setTimeout(() => r(null), 30000))])
    if (state && !state.left) break
  }
  return { score: VAL.score(), passes: VAL.passes(), gate: await VAL.gate(), left: state?.left ?? null }
}, timeout)
const out = path.resolve("tmp/validation")
fs.mkdirSync(out, { recursive: true })
const file = path.join(out, `${new Date().toISOString().slice(0, 10)}.json`)
fs.writeFileSync(file, JSON.stringify({ base, minutes: Math.round((Date.now() - began) / 60000), ...result }, null, 2) + "\n")
console.log(`score ${result.score?.share} (baseline ${result.gate?.was}); gate ${result.gate?.ok ? "ok" : "FAILED"}; ${result.gate?.regressions?.length ?? 0} regressions; wrote ${file}`)
await browser.close()
process.exit(result.gate?.ok ? 0 : 1)
