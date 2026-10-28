// Pictures of an outfit in the running app, from a few angles, to see what's showing where: the outfit as the
// page draws it, the clothes alone (no mannequin), and each garment alone. On the Mac:
//
//   bin/dev
//   node script/spike/outfit_shot.mjs [--out tmp/outfit_shot] [--base http://localhost:3000] link-or-handle ...
//
// Writes NAME.png for each view and angle, and close-ups of the waist (NAME-waist.png).
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

const args = process.argv.slice(2)
let out = "tmp/outfit_shot", base = "http://localhost:3000"
const links = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") out = args[++i]
  else if (args[i] === "--base") base = args[++i]
  else links.push(args[i].startsWith("http") ? args[i] : `https://kith.com/products/${args[i]}`)
}
if (!links.length) { console.error("Give one or more product links or Kith handles."); process.exit(1) }
await checkAppRunning(base)
fs.mkdirSync(out, { recursive: true })

const { chromium } = loadPlaywright()
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ headless: true }))
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 })
try {
  await page.goto(base, { waitUntil: "load" })
  await page.waitForFunction(`window.Stimulus && ${CONTROLLER}?.stage`, null, { timeout: 60000 })
  await page.evaluate(`(async () => {
    const c = ${CONTROLLER}
    document.querySelector("#fit").scrollIntoView({ block: "start" })
    const radio = document.querySelector('input[name="body-type"][value="men"]')
    if (radio && !radio.checked) radio.click()
    c.fillExample()
    for (let i = 0; i < 8; i++) { const b = document.querySelector(".rail-remove"); if (!b) break; b.click(); await new Promise(r => setTimeout(r, 100)) }
  })()`)
  for (const link of links) {
    await page.fill("#product-link", link)
    await page.click('[data-fitting-room-target="importButton"]')
    await page.waitForFunction(`!${CONTROLLER}.importButtonTarget.disabled`, null, { timeout: 120000 })
    await sleep(2500)
  }
  console.log("Waiting for the clothes to settle…")
  // Settled: nothing draping or being checked, and the veil gone (or showing "can't show").
  await page.waitForFunction(`(() => {
    const c = ${CONTROLLER}, s = c.stage
    const box = c.canvasTarget.closest(".stage")?.querySelector(".stage-loading")
    const veiled = box && !box.hidden && !box.classList.contains("is-done") && !box.classList.contains("is-stuck")
    const slots = Object.values(s.slots ?? {}).filter(Boolean)
    return slots.length && slots.every(d => d.shown && d.final && !d.posing) && !veiled && !s.turn
  })()`, null, { timeout: 360000, polling: 1000 })
  await sleep(1500)
  const names = await page.evaluate(`Object.keys(${CONTROLLER}.stage.slots).filter(k => ${CONTROLLER}.stage.slots[k])`)
  console.log("Wearing:", names.join(", "))

  const canvas = page.locator('[data-fitting-room-target="canvas"]')
  const shoot = async (name, { view = "mannequin", only = null, angle = 0 } = {}) => {
    await page.evaluate(`(() => {
      const s = ${CONTROLLER}.stage
      s.idle?.stop?.()
      s.turn = null
      s.setView(${JSON.stringify(view)})
      for (const [k, d] of Object.entries(s.slots)) if (d?.top?.mesh) d.top.mesh.visible = ${JSON.stringify(only)} ? k === ${JSON.stringify(only)} : true
      s.__turned = s.__turned ?? 0
      s.turnCamera(${angle} - s.__turned)
      s.__turned = ${angle}
      s.controls?.update?.()
    })()`)
    await sleep(900)
    await canvas.screenshot({ path: path.join(out, `${name}.png`) })
    const box = await canvas.boundingBox()
    // The waist: the middle of the figure, a little below halfway down.
    await page.screenshot({ path: path.join(out, `${name}-waist.png`), clip: { x: box.x + box.width * 0.3, y: box.y + box.height * 0.42, width: box.width * 0.4, height: box.height * 0.25 } })
  }
  for (const [label, angle] of [["front", 0], ["left", 0.7], ["right", -0.7], ["side", 1.4]]) {
    await shoot(`${label}`, { angle })
    await shoot(`${label}-clothes`, { angle, view: "ghost" })
    for (const slot of names) await shoot(`${label}-${slot}-only`, { angle, only: slot })
  }
  console.log(`Pictures: ${out}`)
} finally {
  await browser.close()
}
