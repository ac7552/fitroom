// How the vision service's /details answers compare with what the importer read from the listings, over a
// sample of store photos: where they disagree is where to look (a hood the listing never mentions, "short
// sleeves" the photo shows long). Run against a service started with DETAILS_MODEL set.
//
//   node script/server/eval_details.mjs sample.json [http://localhost:8787]
//
// sample.json: [{ photo: "https://...jpg", name, hood: true|false, sleeves: "long"|"short"|"sleeveless", ... }]
// (any of hood, sleeves, collar, length, closure given are compared; the rest are just printed).
import { readFileSync } from "node:fs"
import sharp from "sharp"

const [file, base = "http://localhost:8787"] = process.argv.slice(2)
if (!file) { console.error("usage: node eval_details.mjs sample.json [service url]"); process.exit(1) }
const sample = JSON.parse(readFileSync(file, "utf8"))
const agree = {}, seen = {}
for (const row of sample) {
  const bytes = Buffer.from(await (await fetch(row.photo)).arrayBuffer())
  const { data, info } = await sharp(bytes).resize({ width: 512, height: 512, fit: "inside" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const response = await fetch(`${base}/details`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ width: info.width, height: info.height, rgba: data.toString("base64") }) })
  const answers = await response.json()
  const line = [row.name ?? row.photo]
  for (const [question, { answer, confidence }] of Object.entries(answers)) {
    if (question === "ms") continue
    const truth = question === "hood" ? (row.hood == null ? null : row.hood ? "hood" : "none") : row[question] ?? null
    const ok = truth == null ? null : truth === answer
    if (ok != null) { seen[question] = (seen[question] ?? 0) + 1; if (ok) agree[question] = (agree[question] ?? 0) + 1 }
    line.push(`${question}=${answer} (${confidence})${ok === false ? ` ≠ ${truth}` : ""}`)
  }
  console.log(line.join("  "))
}
for (const question of Object.keys(seen)) console.log(`${question}: ${agree[question] ?? 0}/${seen[question]} agree`)
