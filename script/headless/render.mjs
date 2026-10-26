// Drapes an outfit on the mannequin in headless Chromium and saves a picture, without the Rails app.
//
//   python3 script/headless/serve.py 8787 &
//   node script/headless/render.mjs --out tmp/shots/hoodie.png --scene daylight --body men --pose standing \
//        --items '[{"kind":"top","style":"hoodie","size":{"chest":112,"shoulders":50,"sleeve":64,"length":70},"color":"#2a6b3f","fabric":"fleece"}]'
//
// Options: --items JSON (see stage.js#setOutfit; sizes in cm), --body men|women, --measures JSON (cm),
// --scene dark|daylight|studio, --pose standing|relaxed|walking|arms_out, --view mannequin|ghost|fit,
// --tucked, --turn RADIANS (camera round the figure), --width/--height (picture), --script FILE (a JS module
// run in the page after the drape, with window.stage), --photo (use stage.photo, sharper, rather than a
// screenshot), --also-back (a second picture from behind, "-back.png").
import { createRequire } from "node:module"
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE ?? "playwright")
import fs from "node:fs"
import path from "node:path"

const args = Object.fromEntries(process.argv.slice(2).reduce((list, a, i, all) => {
  if (a.startsWith("--")) list.push([a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]])
  return list
}, []))
const base = args.base ?? "http://127.0.0.1:8787"
const out = args.out ?? "tmp/shots/shot.png"
const items = JSON.parse(args.items ?? "[]")
const EXAMPLES = {
  men: { chest: 101.6, waist: 86.4, shoulders: 45.5, arm: 65.5, height: 178, hips: 101, inseam: 81 },
  women: { chest: 91.5, waist: 74, shoulders: 39.5, arm: 58, height: 165, hips: 99, inseam: 76 }
}
const body = args.body ?? "men"
const measures = args.measures ? JSON.parse(args.measures) : EXAMPLES[body]
const width = Number(args.width ?? 900), height = Number(args.height ?? 1200)

fs.mkdirSync(path.dirname(out), { recursive: true })
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] })
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
page.on("pageerror", e => console.error("page error:", e.message))
page.on("console", m => { if (["error", "warning"].includes(m.type()) || process.env.VERBOSE) console.error("console:", m.text()) })
page.on("requestfailed", r => console.error("request failed:", r.url(), r.failure()?.errorText))
await page.goto(`${base}/stage.html`)
await page.evaluate(([w, h]) => { const s = document.querySelector(".stage"); s.style.width = `${w}px`; s.style.height = `${h}px` }, [width, height])
await page.waitForFunction(() => window.stageReady, null, { timeout: 120000 })

const began = Date.now()
const result = await page.evaluate(async ({ items, body, measures, scene, pose, view, tucked, turn, script }) => {
  const stage = window.stage
  stage.drapeBudget = 1000
  if (scene) stage.setScene(scene)
  stage.setBodyType(body)
  stage.setBody(measures)
  if (pose) stage.setPose(pose)
  if (view) stage.setView(view)
  stage.setTucked(Boolean(tucked))
  stage.setOutfit(items)
  const deadline = Date.now() + 240000
  while (!stage.settled && Date.now() < deadline) {
    stage.advanceDrape()
    stage.fitTuck?.()
    await new Promise(r => setTimeout(r, 0))
  }
  if (turn) {
    const t = stage.controls.target, p = stage.camera.position
    const d = Math.hypot(p.x - t.x, p.z - t.z)
    const a = Math.atan2(p.x - t.x, p.z - t.z) + Number(turn)
    p.set(t.x + Math.sin(a) * d, p.y, t.z + Math.cos(a) * d)
    stage.controls.update()
  }
  let extra = null
  if (script) extra = await (await import(script)).default?.(stage)
  // Settle accessories (belt, collars, hidden skin) and stop the frame loop, so a screenshot isn't waiting on
  // a busy software renderer.
  for (let i = 0; i < 3; i++) { stage.wearBelt?.(); stage.wearScarf?.(); stage.wearCollars?.(); stage.hideCovered?.(); stage.draw() }
  stage.visible = false
  if (stage.frameId) { cancelAnimationFrame(stage.frameId); stage.frameId = null }
  return { settled: stage.settled, extra }
}, { items, body, measures, scene: args.scene, pose: args.pose, view: args.view, tucked: args.tucked, turn: args.turn, script: args.script ? `/harness/${args.script}` : null })
console.log(`draped in ${Math.round((Date.now() - began) / 1000)}s, settled: ${result.settled}`, result.extra ? JSON.stringify(result.extra) : "")

async function snap(file) {
  if (args.photo) {
    const data = await page.evaluate(async ([w, h]) => {
      const blob = await window.stage.photo({ width: w, height: h })
      const buffer = new Uint8Array(await blob.arrayBuffer())
      let s = ""
      for (const b of buffer) s += String.fromCharCode(b)
      return btoa(s)
    }, [width, height])
    fs.writeFileSync(file, Buffer.from(data, "base64"))
  } else {
    const data = await page.evaluate(() => { window.stage.draw(); return document.querySelector("canvas#c").toDataURL("image/png").split(",")[1] })
    fs.writeFileSync(file, Buffer.from(data, "base64"))
  }
  console.log("wrote", file)
}
await snap(out)
if (args["also-back"]) {
  await page.evaluate(() => {
    const stage = window.stage, t = stage.controls.target, p = stage.camera.position
    const d = Math.hypot(p.x - t.x, p.z - t.z), a = Math.atan2(p.x - t.x, p.z - t.z) + Math.PI
    p.set(t.x + Math.sin(a) * d, p.y, t.z + Math.cos(a) * d)
    stage.controls.update()
  })
  await snap(out.replace(/\.png$/, "-back.png"))
}
await browser.close()
