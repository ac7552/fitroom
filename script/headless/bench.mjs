// Times the drape on the headless stage: wall time to settled, and the cloth solver's own time and frames
// per garment (Drape#step patched to count). Development only.
//
//   python3 script/headless/serve.py 8787 &
//   node script/headless/bench.mjs [--query "coarse=on"] [--items JSON] [--out shot.png]
import { createRequire } from "node:module"
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE ?? "playwright")
import fs from "node:fs"

const args = Object.fromEntries(process.argv.slice(2).reduce((list, a, i, all) => {
  if (a.startsWith("--")) list.push([a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]])
  return list
}, []))
const base = args.base ?? "http://127.0.0.1:8787"
const DEFAULT = [
  { kind: "top", style: "crewneck", size: { chest: 112, shoulders: 50, sleeve: 22, length: 72 }, color: "#2a4b7f", fabric: "jersey" },
  { kind: "trousers", style: "jeans", size: { waist: 84, seat: 102, thigh: 62, inseam: 81, leg_opening: 40 }, color: "#2b3a55", fabric: "denim" }
]
const items = args.items ? JSON.parse(args.items) : DEFAULT
const measures = { chest: 101.6, waist: 86.4, shoulders: 45.5, arm: 65.5, height: 178, hips: 101, inseam: 81 }
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] })
const page = await browser.newPage({ viewport: { width: 600, height: 800 } })
page.on("pageerror", e => console.error("page error:", e.message))
page.on("console", m => { if (m.type() === "error" && !/404/.test(m.text())) console.error("console:", m.text()) })
const query = [/drape=/.test(args.query ?? "") ? null : "drape=page", args.query].filter(Boolean).join("&")
await page.goto(`${base}/stage.html?${query}`)
await page.evaluate(() => { const s = document.querySelector(".stage"); s.style.width = "600px"; s.style.height = "800px" })
await page.waitForFunction(() => window.stageReady, null, { timeout: 120000 })
const result = await page.evaluate(async ({ items, measures }) => {
  const { Drape } = await import("lib/garments/drape")
  const stats = new Map()
  const step = Drape.prototype.step
  Drape.prototype.step = function (o) {
    const t = performance.now(); step.call(this, o)
    const s = stats.get(this) ?? { ms: 0, frames: 0, points: 0 }
    s.ms += performance.now() - t; s.frames++; s.points = this.x.length / 3
    stats.set(this, s)
  }
  const parts = {}
  const { ClothKernel } = await import("lib/garments/cloth_kernel")
  for (const name of ["collideSkin", "selfCollide", "solveEdges", "solveBends", "predict", "finish", "sync"]) {
    const f = ClothKernel.prototype[name]
    ClothKernel.prototype[name] = function (...a) { const t = performance.now(); const r = f.apply(this, a); parts["k." + name] = (parts["k." + name] ?? 0) + performance.now() - t; return r }
  }
  for (const name of ["collide", "selfCollide", "stayOnArms", "stayOffFeet", "stayOutside", "stayTucked", "pullSeams", "holdRing", "seamGap"]) {
    const f = Drape.prototype[name]
    Drape.prototype[name] = function (...a) { const t = performance.now(); const r = f.apply(this, a); parts[name] = (parts[name] ?? 0) + performance.now() - t; return r }
  }
  const stage = window.stage
  stage.drapeBudget = 1000
  stage.setBodyType("men"); stage.setBody(measures); stage.setOutfit(items)
  const began = performance.now()
  while (!stage.settled && performance.now() - began < 300000) {
    stage.advanceDrape(); stage.fitTuck?.()
    await new Promise(r => setTimeout(r, 0))
  }
  const wall = performance.now() - began
  return { wall: Math.round(wall), settled: stage.settled, drapes: [...stats.values()].map(s => ({ ms: Math.round(s.ms), frames: s.frames, points: s.points, msPerFrame: +(s.ms / s.frames).toFixed(2) })), parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v)])) }
}, { items, measures })
console.log(JSON.stringify(result))
if (args.out) {
  for (let i = 0; i < 3; i++) await page.evaluate(() => { window.stage.advanceDrape(); window.stage.finishFades?.(); window.stage.draw() })
  const data = await page.evaluate(() => { window.stage.draw(); return document.querySelector("canvas#c").toDataURL("image/png").split(",")[1] })
  fs.writeFileSync(args.out, Buffer.from(data, "base64"))
}
await browser.close()
