// For shop photos of tops (in tmp/kith/, served as /kith/): the photo's outline read as the page reads it, a
// top drafted roughly to it, draped, hung (or laid out: hanger.js's flat) and its outline scored against the
// photo's cloth mask, as the validation's silhouette check scores it. How lib/garments/silhouette.js's
// TRIALS were chosen. Development only.
//
//   python3 script/headless/serve.py 8787 &
//   ART=1 node script/headless/silhouette_probe.mjs "photo.jpg|tee|men|{}" "photo.jpg|tee|men|{\"flat\":{\"angle\":0.4}}"
import { createRequire } from "node:module"
import fs from "node:fs"
const { chromium } = createRequire(import.meta.url)("playwright")
const files = process.argv.slice(2)
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] })
const page = await browser.newPage({ viewport: { width: 300, height: 400 } })
page.on("pageerror", e => console.error("page error:", e.message))
page.on("console", m => { if (m.type() === "error" && !/404/.test(m.text())) console.error("console:", m.text()) })
await page.goto("http://127.0.0.1:8787/stage.html?bank=off&still=off&drape=page&redrape=off")
await page.waitForFunction(() => window.stageReady, null, { timeout: 120000 })
for (const spec of files) {
  const [file, style, bodyType = "men", variant = "{}"] = spec.split("|")
  const r = await page.evaluate(async ({ file, style, bodyType, variant }) => {
    variant = JSON.parse(variant)
    const { HangerDrape, clothMask } = await import("lib/garments/redrape")
    const { readOutline, constructionFrom } = await import("lib/garments/photo_fit")
    const { loadImage } = await import("lib/garments/print")
    const src = `/kith/${file}`
    const outline = await readOutline(src)
    if (!outline) return { error: "no outline" }
    const chest = bodyType === "men" ? 112 : 96
    const scale = outline.underarmW > 0 && (outline.apart || outline.sleeveless) ? chest / 2 / outline.underarmW : 72 / outline.bodyLength
    const size = { chest, length: outline.bodyLength * scale, shoulders: outline.shoulderW * scale, sleeve: outline.sleeveLength > 0 ? outline.sleeveLength * scale : undefined, ...(variant.size ?? {}) }
    const make = constructionFrom(outline, scale)
    const stage = window.stage
    stage.drapeBudget = 1000
    stage.setOutfit([]); stage.setBodyType(bodyType)
    stage.setBody(bodyType === "men" ? { chest: 101.6, waist: 86.4, shoulders: 45.5, arm: 65.5, height: 178, hips: 101, inseam: 81 } : { chest: 91.5, waist: 74, shoulders: 39.5, arm: 58, height: 165, hips: 99, inseam: 76 })
    stage.setOutfit([{ kind: ["zip", "bomber", "coat", "cardigan"].includes(style) ? "jacket" : "top", style, size, color: "#8899bb", fabric: "cotton", cut: { photo: {} } }])
    const t0 = performance.now()
    while (performance.now() - t0 < 200000) { stage.advanceDrape(); await new Promise(r => setTimeout(r, 0)); const d = stage.slots.top ?? stage.slots.outer; if (stage.settled && d?.top?.done && !d.posing && d.restX) break }
    const d = stage.slots.top ?? stage.slots.outer
    const hang = new HangerDrape(d.top, d.restX, { flat: variant.flat ?? null })
    while (hang.advance(1000)) {}
    const x = hang.positions
    const image = await loadImage(src)
    const S = Math.min(1, 900 / Math.max(image.naturalWidth, image.naturalHeight))
    const w = Math.round(image.naturalWidth * S), h = Math.round(image.naturalHeight * S)
    const c = document.createElement("canvas"); c.width = w; c.height = h
    const g0 = c.getContext("2d", { willReadFrequently: true }); g0.drawImage(image, 0, 0, w, h)
    const found = clothMask(g0.getImageData(0, 0, w, h).data, w, h)
    const box = { ...found.box, w, h }, mask = found.mask
    const GW = 64, GH = 96
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity
    for (let j = 0; j < x.length; j += 3) { minx = Math.min(minx, x[j]); maxx = Math.max(maxx, x[j]); miny = Math.min(miny, x[j + 1]); maxy = Math.max(maxy, x[j + 1]) }
    const canvas = document.createElement("canvas"); canvas.width = GW; canvas.height = GH
    const g = canvas.getContext("2d", { willReadFrequently: true })
    g.fillStyle = "#000"; g.fillRect(0, 0, GW, GH); g.fillStyle = "#fff"
    const map = d.top.drape.map
    const px = v => ((v - minx) / (maxx - minx)) * (GW - 1), py = v => ((maxy - v) / (maxy - miny)) * (GH - 1)
    for (const [a, b, cc] of d.top.cloth.triangles) { const A = map[a], B = map[b], C = map[cc]; g.beginPath(); g.moveTo(px(x[3 * A]), py(x[3 * A + 1])); g.lineTo(px(x[3 * B]), py(x[3 * B + 1])); g.lineTo(px(x[3 * C]), py(x[3 * C + 1])); g.fill() }
    const sim = g.getImageData(0, 0, GW, GH).data
    let both = 0, either = 0, art = ""
    for (let r = 0; r < GH; r++) { for (let q = 0; q < GW; q++) {
      const X = Math.round(box.left + (q / (GW - 1)) * (box.right - box.left)), Y = Math.round(box.top + (r / (GH - 1)) * (box.bottom - box.top))
      const a = sim[4 * (r * GW + q)] > 128, b = Boolean(mask[Y * box.w + X])
      if (a && b) both++; if (a || b) either++
      if (r % 4 === 0 && q % 2 === 0) art += a && b ? "#" : a ? "s" : b ? "p" : "."
    } if (r % 4 === 0) art += "\n" }
    const o = outline
    return { iou: +(both / either).toFixed(3), hung: found.hung, apart: o.apart, size: Object.fromEntries(Object.entries(size).map(([k, v]) => [k, v && Math.round(v)])), make, aspect: [+((maxx - minx) / (maxy - miny)).toFixed(2), +((box.right - box.left) / (box.bottom - box.top)).toFixed(2)], art }
  }, { file, style, bodyType, variant })
  console.log(file.slice(0, 40), style, variant, JSON.stringify({ ...r, art: undefined }))
  if (process.env.ART) console.log(r.art)
}
await browser.close()
