// Checks laying the AI's picture back onto the 3D clothes (stage.js#wearPhoto) in headless Chromium, without the
// Rails app: runs wear_photo_page.mjs (the self-test and the stand-in AI picture; see there) and saves its
// pictures.
//
//   python3 script/headless/serve.py 8787 &
//   PLAYWRIGHT_MODULE=/opt/npm-tools/node_modules/playwright node script/headless/wear_photo.mjs --out tmp/wear
//
// Options: --base URL (the server), --out DIR (pictures: capture.png, standin.png, self-mode2-0.6.png ...).
// Takes a few minutes on 2 CPUs with SwiftShader. Prints the self-test numbers (mean abs difference per channel,
// 0..255, between the page's front photo and the same view with that photo worn, per light mode).
import { createRequire } from "node:module"
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE ?? "playwright")
import fs from "node:fs"
import path from "node:path"

const args = Object.fromEntries(process.argv.slice(2).reduce((list, a, i, all) => {
  if (a.startsWith("--")) list.push([a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]])
  return list
}, []))
const base = args.base ?? "http://127.0.0.1:8787"
const out = args.out ?? "tmp/wear"
const WOMEN = { chest: 91.5, waist: 74, shoulders: 39.5, arm: 58, height: 165, hips: 99, inseam: 76 }

fs.mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] })
const page = await browser.newPage({ viewport: { width: 900, height: 1200 }, deviceScaleFactor: 1 })
page.on("pageerror", e => console.error("page error:", e.message))
page.on("console", m => { if (["error", "warning"].includes(m.type()) || process.env.VERBOSE) console.error("console:", m.text()) })
page.on("requestfailed", r => console.error("request failed:", r.url(), r.failure()?.errorText))
await page.goto(`${base}/stage.html`)
await page.waitForFunction(() => window.stageReady, null, { timeout: 120000 })

const began = Date.now()
const details = await page.evaluate(async measures => {
  const stage = window.stage
  stage.drapeBudget = 1000
  stage.setBodyType("women")
  stage.setBody(measures)
  const run = (await import("/harness/wear_photo_page.mjs")).default
  const details = await run(stage)
  stage.visible = false
  if (stage.frameId) { cancelAnimationFrame(stage.frameId); stage.frameId = null }
  return details
}, WOMEN)
console.log(`done in ${Math.round((Date.now() - began) / 1000)}s`, JSON.stringify(details))
const names = await page.evaluate(() => Object.keys(window.wearShots))
for (const name of names) {
  const data = await page.evaluate(n => window.wearShots[n], name)
  fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(data, "base64"))
}
console.log("wrote", names.length, "pictures to", out)
await browser.close()
