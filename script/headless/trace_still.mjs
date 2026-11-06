// The path-traced still (lib/trace.js) in headless Chromium: drapes an outfit, lets the still settle, runs the
// tracer to a number of samples, and saves the canvas (and, beside it, the averaged still for comparison).
// SwiftShader traces slowly (seconds a sample at 450x600): keep --samples small, or wait.
//
//   python3 script/headless/serve.py 8787 &
//   node script/headless/trace_still.mjs --out tmp/shots/trace.png [--samples 8] [--width 450 --height 600]
//        [--items JSON] [--scene studio] [--body men] [--turn RADIANS]
import { createRequire } from "node:module"
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE ?? "playwright")
import fs from "node:fs"

const args = Object.fromEntries(process.argv.slice(2).reduce((list, a, i, all) => {
  if (a.startsWith("--")) list.push([a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]])
  return list
}, []))
const base = args.base ?? "http://127.0.0.1:8787"
const out = args.out ?? "tmp/shots/trace.png"
const width = Number(args.width ?? 450), height = Number(args.height ?? 600)
const samples = Number(args.samples ?? 8)
const EXAMPLES = {
  men: { chest: 101.6, waist: 86.4, shoulders: 45.5, arm: 65.5, height: 178, hips: 101, inseam: 81 },
  women: { chest: 91.5, waist: 74, shoulders: 39.5, arm: 58, height: 165, hips: 99, inseam: 76 }
}
const body = args.body ?? "men"
const items = JSON.parse(args.items ?? '[{"kind":"top","style":"tee","size":{"chest":106,"shoulders":47,"sleeve":21,"length":72},"color":"#b33a3a","fabric":"cotton"},{"kind":"trousers","style":"jeans","size":{"waist":84,"seat":102,"thigh":62,"inseam":81,"leg_opening":40},"color":"#33476b","fabric":"denim"}]')

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] })
const page = await browser.newPage({ viewport: { width, height } })
page.on("pageerror", e => console.error("page error:", e.message))
page.on("console", m => { if (/error|warn|\[trace\]/i.test(m.text()) || /error|warn/.test(m.type())) console.log("console:", m.text().slice(0, 400)) })
await page.goto(`${base}/stage.html?bank=off${args.query ? "&" + args.query : ""}`)
await page.evaluate(([w, h]) => { const s = document.querySelector(".stage"); s.style.width = `${w}px`; s.style.height = `${h}px` }, [width, height])
await page.waitForFunction(() => window.stageReady, null, { timeout: 120000 })
const began = Date.now()
const result = await page.evaluate(async ({ items, body, measures, scene, turn, samples }) => {
  const stage = window.stage
  stage.drapeBudget = 1000
  if (scene) stage.setScene(scene)
  stage.setBodyType(body)
  stage.setBody(measures)
  stage.setOutfit(items)
  const deadline = Date.now() + 240000
  while (Date.now() < deadline) {
    stage.advanceDrape()
    await new Promise(r => setTimeout(r, 0))
    const slots = Object.values(stage.slots).filter(Boolean)
    if (stage.settled && slots.length && slots.every(d => ["done", "off", undefined].includes(d.redrapeState) && !d.posing && (!d.top.item.photoCloth || d.metered))) break
  }
  if (turn) {
    const t = stage.controls.target, p = stage.camera.position
    const d = Math.hypot(p.x - t.x, p.z - t.z), a = Math.atan2(p.x - t.x, p.z - t.z) + Number(turn)
    p.set(t.x + Math.sin(a) * d, p.y, t.z + Math.cos(a) * d)
    stage.controls.update()
  }
  for (let i = 0; i < 3; i++) stage.advanceDrape()
  stage.finishFades?.()
  stage.visible = false
  if (stage.frameId) { cancelAnimationFrame(stage.frameId); stage.frameId = null }
  // The still: frames as the page's loop would draw them, until the tracer has its samples.
  const out = { usable: stage.trace?.usable ?? null, ready: null, drew: 0, samples: 0, ms: {} }
  const t0 = performance.now()
  let averaged = null
  for (let frame = 0; frame < 2000; frame++) {
    const drew = stage.still.draw()
    if (!drew) stage.draw()
    out.drew += drew ? 1 : 0
    if (out.ready === null && frame >= 3) out.ready = stage.trace?.ready() ?? null
    if (frame === 8) averaged = document.querySelector("canvas#c").toDataURL("image/png")
    if (!stage.trace || stage.trace.disabled) { if (frame > 40) break }
    else if (stage.trace.samples >= samples) break
    await new Promise(r => setTimeout(r, 0))
    if (performance.now() - t0 > 900000) break
  }
  out.samples = stage.trace?.samples ?? 0
  out.ms.still = Math.round(performance.now() - t0)
  out.disabled = stage.trace?.disabled ?? null
  out.traced = document.querySelector("canvas#c").toDataURL("image/png")
  out.averaged = averaged
  return out
}, { items, body, measures: EXAMPLES[body], scene: args.scene ?? "studio", turn: args.turn, samples })
console.log(`done in ${Math.round((Date.now() - began) / 1000)}s`, JSON.stringify({ ...result, traced: undefined, averaged: undefined }))
fs.mkdirSync(out.replace(/[^/]*$/, "") || ".", { recursive: true })
fs.writeFileSync(out, Buffer.from(result.traced.split(",")[1], "base64"))
if (result.averaged) fs.writeFileSync(out.replace(/\.png$/, "-averaged.png"), Buffer.from(result.averaged.split(",")[1], "base64"))
console.log("wrote", out)
await browser.close()
