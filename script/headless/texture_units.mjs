// Checks every shader the 3D view compiles reads no more textures, and takes no more vertex attributes, than a
// real GPU allows: 16 each. Textures: 16 (a
// Mac's, most phones'; headless Chromium's software GPU allows 32, so a shader over 16 compiles here and
// draws nothing on a Mac). Drapes a few outfits with their shop photos, the way the page does, then counts
// each program's samplers. Exits 1 when any is over.
//
//   python3 script/headless/serve.py 8787 &
//   node script/headless/texture_units.mjs [--query "..."]
import { createRequire } from "node:module"
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE ?? "playwright")

const LIMIT = 16
const args = Object.fromEntries(process.argv.slice(2).reduce((list, a, i, all) => { if (a.startsWith("--")) list.push([a.slice(2), all[i + 1]]); return list }, []))
const base = args.base ?? "http://127.0.0.1:8787"
const men = { chest: 101.6, waist: 86.4, shoulders: 45.5, arm: 65.5, height: 178, hips: 101, inseam: 81 }
const OUTFITS = [
  [{ kind: "top", style: "hoodie", size: { chest: 116, shoulders: 52, sleeve: 64, length: 70 }, color: "#555555", fabric: "fleece", photo: "/fixtures/photos/striped-hoodie-front.jpg" },
   { kind: "trousers", style: "jeans", size: { waist: 84, seat: 102, thigh: 62, inseam: 81, leg_opening: 40 }, color: "#33476b", fabric: "denim", photo: "/fixtures/photos/sweatpants-front.jpg" }],
  [{ kind: "top", style: "shirt", size: { chest: 108, shoulders: 47, sleeve: 64, length: 76 }, color: "#b9cbe0", fabric: "cotton", photo: "/fixtures/photos/striped-shirt-front.jpg" }],
  [{ kind: "top", style: "dress", size: { chest: 92, waist: 76, hips: 100, length: 110 }, cut: { sleeves: "thin_straps", neckline: "v", length: "midi", fit: "flared", fabric: "silk" }, color: "#2f6e5a", fabric: "silk" }]
]
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] })
const page = await browser.newPage({ viewport: { width: 400, height: 500 } })
page.on("console", m => { if (/ATTRIBS16/.test(m.text())) console.log(m.text()) })
page.on("pageerror", e => console.error("page error:", e.message))
await page.goto(`${base}/stage.html?bank=off&drape=page${args.query ? "&" + args.query : ""}`)
await page.waitForFunction(() => window.stageReady, null, { timeout: 120000 })
let worst = 0, worstAttributes = 0
for (const items of OUTFITS) {
  const found = await page.evaluate(async ({ items, men }) => {
    const stage = window.stage
    stage.drapeBudget = 1000
    stage.setOutfit([]); stage.setBodyType("men"); stage.setBody(men); stage.setOutfit(items)
    const t = performance.now()
    while (performance.now() - t < 150000) {
      stage.advanceDrape(); stage.advanceRedrape?.()
      await new Promise(r => setTimeout(r, 0))
      const slots = Object.values(stage.slots).filter(Boolean)
      if (stage.settled && slots.length && slots.every(d => ["done", "off", undefined].includes(d.redrapeState) && !d.posing)) break
    }
    // (Every material drawn once, each way it can be: with the fit map, and as the still picture.)
    for (const fit of [true, false]) { stage.setView?.(fit ? "fit" : "mannequin"); stage.draw() }
    await new Promise(r => setTimeout(r, 1500)); stage.draw()
    const gl = stage.renderer.getContext()
    const SAMPLERS = [gl.SAMPLER_2D, gl.SAMPLER_CUBE, gl.SAMPLER_3D, gl.SAMPLER_2D_ARRAY, gl.SAMPLER_2D_SHADOW]
    return stage.renderer.info.programs.map(p => {
      let n = 0
      for (let i = 0; i < gl.getProgramParameter(p.program, gl.ACTIVE_UNIFORMS); i++) { const u = gl.getActiveUniform(p.program, i); if (SAMPLERS.includes(u.type)) n += u.size }
      const names = []; for (let i = 0; i < gl.getProgramParameter(p.program, gl.ACTIVE_ATTRIBUTES); i++) names.push(gl.getActiveAttrib(p.program, i).name)
      // (Which attributes, when at the limit: the next one added breaks a Mac.)
      if (names.length >= LIMIT) console.log("ATTRIBS16 " + names.join(" "))
      return [p.cacheKey.split(",").slice(0, 2).join(","), n, names.length]
    })
  }, { items, men })
  const most = Math.max(...found.map(f => f[1])), attributes = Math.max(...found.map(f => f[2]))
  worst = Math.max(worst, most)
  worstAttributes = Math.max(worstAttributes, attributes)
  console.log(items.map(i => i.style).join(" + "), "most textures in one shader:", most, "most vertex attributes:", attributes, found.filter(f => f[1] > LIMIT || f[2] > LIMIT).length ? `OVER ${LIMIT}: ${JSON.stringify(found.filter(f => f[1] > LIMIT || f[2] > LIMIT))}` : "")
}
await browser.close()
// Vertex attributes too: WebGL promises 16, and a Mac's GPU gives exactly that.
console.log(worst > LIMIT ? `FAIL: a shader reads ${worst} textures; a Mac allows ${LIMIT}` : `ok: at most ${worst} of ${LIMIT} textures`)
console.log(worstAttributes > LIMIT ? `FAIL: a shader takes ${worstAttributes} vertex attributes; a Mac allows ${LIMIT}` : `ok: at most ${worstAttributes} of ${LIMIT} vertex attributes`)
process.exit(worst > LIMIT || worstAttributes > LIMIT ? 1 : 0)
