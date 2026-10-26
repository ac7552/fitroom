// The pure parts of script/spike/inputs.mjs: names, categories, the zip. Tested in
// test/javascript/spike_inputs.test.mjs.
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"

// The sheet's category for a kind of item: tops for anything worn above the waist, bottoms for pants, and
// null for what the try-on models don't paint (shoes, socks, a belt).
export const CATEGORIES = { top: "tops", jacket: "tops", coat: "tops", trousers: "bottoms" }
export function categoryFor(kind) {
  return CATEGORIES[kind] ?? null
}

// A file-name slug from a garment's name ("Kith Adley Striped Hoodie - Navy" -> "kith-adley-striped-hoodie-navy"),
// falling back to the link's last path segment ("https://kith.com/products/adley-hoodie?x=1" -> "adley-hoodie").
// Never empty: "item" when nothing is left.
export function slugFor(name, link) {
  const slug = s => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "")
  return slug(name) || slug(lastSegment(link)) || "item"
}

export function lastSegment(link) {
  try {
    const parts = new URL(link).pathname.split("/").filter(Boolean)
    return parts[parts.length - 1] ?? ""
  } catch {
    return String(link ?? "").split("/").filter(Boolean).pop() ?? ""
  }
}

// A name no other sheet already uses in `taken`: the slug, then slug-2, slug-3, ...
export function uniqueName(slug, taken) {
  if (!taken.has(slug)) return slug
  for (let i = 2; ; i++) if (!taken.has(`${slug}-${i}`)) return `${slug}-${i}`
}

// The file extension for a photo's content type (or data: URL prefix); jpg when unsure.
export function extensionFor(contentType) {
  const type = String(contentType ?? "").toLowerCase().split(";")[0].trim()
  return { "image/png": "png", "image/webp": "webp", "image/jpeg": "jpg", "image/jpg": "jpg" }[type] ?? "jpg"
}

// zlib.crc32 arrived in Node 22.2; older Nodes get the table.
let crcTable = null
export function crc32(data) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(data) >>> 0
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

// A store-only zip (no compression; the pictures are already compressed) of `files`, each
// { name, data: Buffer }, written to `out`. Plain Node, no library: the local file header, the central
// directory and the end record, as the zip format spec lays them out.
export function writeStoreZip(out, files) {
  const locals = [], centrals = []
  let offset = 0
  const now = new Date()
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, "utf8")
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8)
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28)
    locals.push(local, nameBytes, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10)
    central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14); central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6)
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, Buffer.concat([...locals, directory, end]))
  return out
}

// Parses `node inputs.mjs LINK [LINK...] [--base URL] [--out DIR] [--body men|women]`. `flags` names
// options that take no value (run.mjs' --skip-inputs); `defaults` adds options beyond inputs.mjs' own.
export function parseArgs(argv, defaults = {}, flags = [], bodies = ["men", "women"]) {
  const options = { base: "http://localhost:3000", out: "tmp/spike", body: "men", ...defaults }
  const links = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      if (flags.includes(key)) { options[key] = true; continue }
      if (!(key in options)) throw new Error(`unknown option ${a}`)
      options[key] = argv[++i]
      if (options[key] === undefined) throw new Error(`${a} needs a value`)
    } else links.push(a)
  }
  if (!bodies.includes(options.body)) throw new Error(`--body is ${bodies.join(" or ")}`)
  return { ...options, links }
}

// The outfit audit (script/spike/audit.mjs) ----------------------------------------------------------------
// Pure parts, tested in test/javascript/audit.test.mjs.

// Parses `node audit.mjs [--outfits 1-37] [--body men|women|both] [--out tmp/audit] [--base URL] [--resume]`.
// `outfits` comes back as the list of outfit numbers (1-based); `bodies` as ["men"], ["women"] or both.
export function parseAuditArgs(argv, count = 37) {
  const options = parseArgs(argv, { outfits: `1-${count}`, out: "tmp/audit", body: "both" }, ["resume"], ["men", "women", "both"])
  if (options.links.length) throw new Error(`unexpected argument ${options.links[0]}`)
  options.outfits = parseRange(options.outfits, count)
  options.bodies = options.body === "both" ? ["men", "women"] : [options.body]
  options.resume = Boolean(options.resume)
  return options
}

// "1-37", "3", "1-5,8,10-12" -> the numbers, once each, in order, all within 1..count.
export function parseRange(text, count = Infinity) {
  const numbers = []
  for (const part of String(text ?? "").split(",").map(s => s.trim()).filter(Boolean)) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part)
    if (!match) throw new Error(`--outfits wants numbers like 1-37 or 3,5,7-9, not "${part}"`)
    const from = Number(match[1]), to = match[2] === undefined ? from : Number(match[2])
    if (from < 1 || to < from || to > count) throw new Error(`--outfits: ${part} is outside 1-${count}`)
    for (let n = from; n <= to; n++) if (!numbers.includes(n)) numbers.push(n)
  }
  if (numbers.length === 0) throw new Error("--outfits names no outfit")
  return numbers
}

// "07-women-tee-and-jeans": the outfit's number (two digits), the mannequin and the outfit's name as a slug.
export function auditName(number, body, outfitName) {
  const slug = slugFor(outfitName, "")
  return `${String(number).padStart(2, "0")}-${body}-${slug === "item" ? "outfit" : slug}`
}

// What a listing's name says the item should be: { kinds: [...], styles: [...] } (either empty when the name
// doesn't say), or null when the name says nothing we know. The first matching line wins, so "T-Shirt" is a
// tee before it's a shirt, "Dress Shirt" is a shirt, and "Short Sleeve Shirt" isn't shorts. Where the import
// may fairly pick either of two (a hoodie that zips is a top or a jacket), both are listed.
const EXPECTED = [
  [/sneakers?|trainers?|\bshoes?\b|\bboots?\b|loafers?|sandals?|\bslides?\b|\bmules?\b|\bclogs?\b|\bheels?\b/i, ["shoes"], []],
  [/\bbelts?\b/i, ["belt"], []],
  [/\bsocks?\b/i, ["socks"], []],
  [/\bdress(?:es)?\b(?!\s*(?:shirts?|pants|trousers|shoes?|socks|coats?|jackets?|boots?))|\bgowns?\b|\bmaxi\b|\bmidi\b|sundress/i, ["top"], ["dress"]],
  [/\bskirts?\b|\bskort\b/i, ["trousers"], ["skirt"]],
  [/\bleggings?\b|\btights\b/i, ["trousers"], ["leggings"]],
  [/\bshorts?\b(?![- ]?sleeve)/i, ["trousers"], ["shorts"]],
  [/joggers?|sweatpants?|track ?pants?|\bsweats\b/i, ["trousers"], ["joggers"]],
  [/\bjeans?\b|denim (?:pants?|trousers?)/i, ["trousers"], ["jeans"]],
  [/\bpants?\b|trousers?|chinos?|slacks/i, ["trousers"], []],
  [/overcoat|topcoat|top coat|car coat|trench|peacoat|pea coat|parka|duffle|\bcoat\b/i, ["coat", "jacket"], []],
  [/blazer|\bsuit\b|sport ?coat|tuxedo/i, ["jacket"], ["tailored"]],
  [/bomber|varsity|letterman|flight jacket|ma-1|baseball jacket|harrington/i, ["jacket"], ["bomber"]],
  [/\bjacket\b|overshirt|shacket|anorak|windbreaker|puffer/i, ["jacket", "coat"], []],
  [/cardigan/i, ["top", "jacket"], ["cardigan"]],
  [/hoodie|hooded/i, ["top", "jacket"], ["hoodie", "zip"]],
  [/\bpolos?\b/i, ["top"], ["polo"]],
  [/\btanks?\b|camisole|\bcami\b|singlet|bralette|\bbra\b/i, ["top"], ["tank"]],
  [/sweater|jumper|\bknit\b|knitted|cashmere|merino/i, ["top"], ["sweater", "cardigan"]],
  [/sweatshirt|crew ?neck|pullover|fleece/i, ["top"], ["sweatshirt", "hoodie", "sweater"]],
  [/long[- ]?sleeve.*\b(?:t[- ]?shirt|tee)s?\b|\b(?:t[- ]?shirt|tee)s?\b.*long[- ]?sleeve|\bl\/s\b.*\btee\b/i, ["top"], ["longsleeve", "tee"]],
  [/\bt[- ]?shirts?\b|\btees?\b/i, ["top"], ["tee", "longsleeve"]],
  [/blouse|\bshirts?\b|camp collar|\btop\b/i, ["top"], ["shirt", "shortshirt", "longsleeve", "tee"]]
]
export function expectedFrom(name) {
  const text = String(name ?? "")
  for (const [pattern, kinds, styles] of EXPECTED) if (pattern.test(text)) return { kinds, styles }
  return null
}

// Whether the kind and style the import gave match what the name says. True when the name says nothing.
export function kindMatches(name, kind, style) {
  const expected = expectedFrom(name)
  if (!expected) return true
  if (!expected.kinds.includes(kind)) return false
  // A style is only checked on the kind that has styles of its own (a hoodie-named jacket may be any jacket).
  if (expected.kinds.length > 1 && kind !== expected.kinds[0]) return true
  return expected.styles.length === 0 || expected.styles.includes(style)
}

// Names that promise a print the page should have read from the photo.
export const PRINTED_NAME = /graphic|print|stripe|striped|logo|\bcheck(?:ed|s)?\b|plaid|camo|floral|tie[- ]dye|pattern/i

// Limits for the fit flags (cm): a part that's tighter or shorter than TIGHT, or looser or longer than LOOSE,
// in the size shown, is a flag. Imports slower than SLOW_IMPORT ms are a flag too.
export const TIGHT_CM = -8, LOOSE_CM = 12, SLOW_IMPORT_MS = 40000

// The red flags for one audited item (the JSON audit.mjs writes per item). Each flag is a short sentence.
export function flagsFor(item) {
  const flags = []
  if (item.importError) {
    flags.push(item.unsupported ? `not tried on: ${item.importError}` : `import failed: ${item.importError}`)
    return flags
  }
  if (item.guessed) flags.push(`sizes guessed (${item.chart?.kind ?? "?"} chart)`)
  if (item.chart?.missing?.length) flags.push(`chart missing: ${item.chart.missing.join(", ")}`)
  if (!kindMatches(item.name, item.kind, item.style)) {
    const expected = expectedFrom(item.name)
    flags.push(`kind looks wrong: name says ${expected.kinds.join("/")}${expected.styles.length ? ` (${expected.styles.join("/")})` : ""}, got ${item.kind}${item.style ? ` (${item.style})` : ""}`)
  }
  const names = item.chart?.sizes ?? []
  if (item.best && names.length > 1 && (item.best === names[0] || item.best === names[names.length - 1])) {
    flags.push(`best size ${item.best} is the ${item.best === names[0] ? "smallest" : "largest"} of ${names[0]}–${names[names.length - 1]}`)
  }
  for (const check of item.checks ?? []) {
    const ease = Number(check.ease_cm)
    if (!Number.isFinite(ease)) continue
    if (["tight", "short"].includes(check.status) && ease < TIGHT_CM) flags.push(`${check.part} ${check.status} by ${Math.abs(ease).toFixed(0)} cm`)
    if (["loose", "long"].includes(check.status) && ease > LOOSE_CM) flags.push(`${check.part} ${check.status} by ${ease.toFixed(0)} cm`)
  }
  if (PRINTED_NAME.test(item.name ?? "") && !item.printRead && !item.photoMapRead && !["shoes", "belt", "socks"].includes(item.kind)) flags.push("no print read from the photo")
  if (item.settled === false) flags.push("drape not settled in 4 min")
  if (item.importMs > SLOW_IMPORT_MS) flags.push(`slow import: ${Math.round(item.importMs / 1000)} s`)
  if (item.replaced) flags.push(`replaced the ${item.replaced} already on`)
  if (item.bodyFlipped) flags.push("the page switched the mannequin (a women's piece); switched back")
  return flags
}

// The verdicts in short words for the sheet's text panel: "chest fits · waist tight −3 · length long +14".
export function verdictWords(checks) {
  const sign = n => (n > 0 ? `+${n.toFixed(0)}` : n.toFixed(0))
  return (checks ?? []).map(c => `${c.part} ${c.status === "good" ? "fits" : c.status}${Number.isFinite(Number(c.ease_cm)) && c.status !== "good" ? ` ${sign(Number(c.ease_cm))}` : ""}`).join(" · ")
}

const html = s => String(s ?? "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch])

// The contact sheet for one outfit on one mannequin, as a page: a header, then a row per item with the shop
// photo, the outfit from the front and from behind (the same two pictures on every row), and a text panel.
// `pictures`: { front, back } as data: URLs (or null); each item carries `photoData` (a data: URL) when the
// page had its photo.
export function sheetHtml({ number, outfitName, body, items, pictures, flags }) {
  const rows = items.map((item, i) => {
    const itemFlags = item.flags ?? []
    return `
      <section class="row">
        <div class="cell photo">${item.photoData ? `<img src="${item.photoData}" alt="">` : `<div class="none">no photo</div>`}</div>
        <div class="cell render">${pictures.front ? `<img src="${pictures.front}" alt="">` : `<div class="none">no render</div>`}</div>
        <div class="cell render">${pictures.back ? `<img src="${pictures.back}" alt="">` : `<div class="none">no render</div>`}</div>
        <div class="cell text">
          <p class="mono">${i + 1} · ${html(item.handle)}</p>
          <h2>${html(item.name ?? item.handle)}</h2>
          <p class="meta">${html([item.brand, item.kind, item.style, item.fabric, item.cut && typeof item.cut === "object" ? Object.entries(item.cut).filter(([, v]) => v === true).map(([k]) => k).join(" ") : null, item.zip ? "zip" : null, item.women ? "women's" : null].filter(Boolean).join(" · "))}</p>
          ${item.importError ? "" : `
          <p><b>${html(item.selected ?? "?")}</b>${item.best && item.best !== item.selected ? ` (best ${html(item.best)})` : " best"} of ${html((item.chart?.sizes ?? []).join(" "))}${item.chart?.kind ? ` · ${html(item.chart.kind)} chart` : ""}${item.verdict ? ` · ${html(item.verdict)}` : ""}</p>
          <p class="verdicts">${html(verdictWords(item.checks))}</p>
          <p class="meta">${html([item.importMs != null ? `import ${(item.importMs / 1000).toFixed(1)} s` : null, item.drapeMs != null ? `drape ${(item.drapeMs / 1000).toFixed(1)} s` : null, item.printRead ? "print read" : null, item.photoMapRead ? "photo laid on" : null, item.shoeSideRead ? "shoe side read" : null].filter(Boolean).join(" · "))}</p>
          ${(item.warnings ?? []).map(w => `<p class="meta">${html(w)}</p>`).join("")}`}
          ${itemFlags.map(f => `<p class="flag">⚑ ${html(f)}</p>`).join("")}
        </div>
      </section>`
  }).join("")
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${html(auditName(number, body, outfitName))}</title>
<style>
  body { margin: 0; padding: 24px; background: #15161a; color: #e8e8e6; font: 14px/1.4 -apple-system, "Helvetica Neue", Arial, sans-serif; width: 1400px; }
  header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid #2d2f36; padding-bottom: 12px; margin-bottom: 12px; }
  h1 { font-size: 20px; margin: 0; font-weight: 600; } h2 { font-size: 15px; margin: 2px 0 4px; font-weight: 600; }
  .mono { font-family: "JetBrains Mono", ui-monospace, Menlo, monospace; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: #9a9ca3; margin: 0; }
  .row { display: grid; grid-template-columns: 260px 300px 300px 1fr; gap: 16px; padding: 12px 0; border-bottom: 1px solid #2d2f36; }
  .cell { min-width: 0; } .cell img { display: block; width: 100%; height: 400px; object-fit: contain; background: #1d1e23; border: 1px solid #2d2f36; }
  .none { height: 400px; display: grid; place-items: center; color: #6b6d74; border: 1px dashed #2d2f36; }
  .meta { color: #9a9ca3; margin: 2px 0; } .verdicts { margin: 4px 0; } p { margin: 4px 0; }
  .flag { color: #f87171; margin: 3px 0; font-weight: 500; }
  .count { color: ${flags ? "#f87171" : "#9a9ca3"}; }
</style></head><body>
<header><div><p class="mono">Outfit ${String(number).padStart(2, "0")} · ${html(body)}</p><h1>${html(outfitName)}</h1></div>
<p class="count">${items.length} item${items.length === 1 ? "" : "s"} · ${flags} flag${flags === 1 ? "" : "s"}</p></header>
${rows}
</body></html>`
}

// tmp/audit/index.html: every sheet, with its flag count, red when there are flags.
export function indexHtml(report) {
  const rows = (report.outfits ?? []).map(o => `
    <tr class="${o.flags ? "flagged" : ""}"><td class="mono">${String(o.number).padStart(2, "0")}</td><td>${html(o.outfitName)}</td><td>${html(o.body)}</td>
      <td>${o.items.length}</td><td class="n">${o.flags}</td><td><a href="${html(o.sheet)}">sheet</a> · <a href="${html(o.json)}">json</a>${o.error ? ` · <span class="flag">${html(o.error)}</span>` : ""}</td></tr>`).join("")
  const total = (report.outfits ?? []).reduce((n, o) => n + o.flags, 0)
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Outfit audit</title>
<style>
  body { margin: 0; padding: 24px; background: #15161a; color: #e8e8e6; font: 14px/1.5 -apple-system, "Helvetica Neue", Arial, sans-serif; }
  h1 { font-size: 20px; font-weight: 600; } table { border-collapse: collapse; } td, th { padding: 6px 12px; border-bottom: 1px solid #2d2f36; text-align: left; }
  th { font-family: ui-monospace, Menlo, monospace; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: #9a9ca3; }
  .mono { font-family: ui-monospace, Menlo, monospace; } .n { text-align: right; } .flagged .n, .flag { color: #f87171; } a { color: #c7c9d1; }
</style></head><body>
<h1>Outfit audit · ${(report.outfits ?? []).length} sheets · ${total} flags${report.when ? ` · ${html(report.when)}` : ""}</h1>
<table><thead><tr><th>#</th><th>Outfit</th><th>Body</th><th>Items</th><th>Flags</th><th></th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`
}

// The summary table printed at the end: one line per outfit × body.
export function summaryLines(report) {
  const outfits = report.outfits ?? []
  const width = Math.max(6, ...outfits.map(o => o.outfitName.length))
  const lines = [`${"#".padEnd(3)} ${"outfit".padEnd(width)} ${"body".padEnd(6)} ${"items".padStart(5)} ${"flags".padStart(5)}`]
  for (const o of outfits) lines.push(`${String(o.number).padStart(2, "0").padEnd(3)} ${o.outfitName.padEnd(width)} ${o.body.padEnd(6)} ${String(o.items.length).padStart(5)} ${String(o.flags).padStart(5)}${o.error ? `  ${o.error}` : ""}`)
  return lines
}

// The Kaggle side (script/spike/run.mjs) -------------------------------------------------------------------
// Everything below is pure: tested in test/javascript/spike_run.test.mjs. The strings come from the Kaggle
// CLI's source (kaggle 2.2.5, kaggle/api/kaggle_api_extended.py), quoted in each comment.

export const KAGGLE_DATASET_SLUG = "fitroom-spike-inputs"
export const KAGGLE_KERNEL_SLUG = "fitroom-tryon-spike"

// Parses `node run.mjs LINK [LINK...] [--models fashn|both] [--skip-inputs] [--body men|women] [--kaggle-user NAME]
// [--branch main] [--base URL] [--out DIR]`.
export function parseRunArgs(argv) {
  const options = parseArgs(argv, { models: "fashn", kaggleUser: "", branch: "main" }, ["skipInputs"])
  if (!["fashn", "both", "leffa"].includes(options.models)) throw new Error("--models is fashn, leffa or both")
  options.skipInputs = Boolean(options.skipInputs)
  return options
}

// The Kaggle username: the --kaggle-user flag, else KAGGLE_USERNAME in the env, else ~/.kaggle/kaggle.json's
// "username" (its text is given). Null when none of them has it.
export function resolveKaggleUser({ flag, env, json, configView } = {}) {
  if (flag) return String(flag).trim()
  if (env?.KAGGLE_USERNAME) return String(env.KAGGLE_USERNAME).trim()
  // `kaggle config view` prints "- username: NAME" whatever way the person signed in.
  const viewed = configView && /^-\s*username:\s*(\S+)/m.exec(configView)
  if (viewed && viewed[1] !== "None") return viewed[1]
  if (json) {
    try {
      const parsed = JSON.parse(json)
      if (parsed && typeof parsed.username === "string" && parsed.username.trim()) return parsed.username.trim()
    } catch { /* not JSON: no username */ }
  }
  return null
}

// kernel-metadata.json for a user: the template (script/spike/kaggle/kernel-metadata.json) with every
// <KAGGLE_USERNAME> filled. Returns the object, checked for what `kernels push` validates (a code_file, a
// language, a kernel_type, the slug without a version).
export function renderKernelMetadata(template, user) {
  if (!user) throw new Error("a Kaggle username is needed")
  const text = (typeof template === "string" ? template : JSON.stringify(template)).replaceAll("<KAGGLE_USERNAME>", user)
  const metadata = JSON.parse(text)
  for (const key of ["id", "title", "code_file", "language", "kernel_type"]) if (!metadata[key]) throw new Error(`kernel-metadata.json needs ${key}`)
  if (metadata.id.split("/").length !== 2) throw new Error(`kernel id must be owner/slug, got ${metadata.id}`)
  return metadata
}

// dataset-metadata.json for the inputs dataset, as `kaggle datasets create` wants it (title 6–50 chars,
// exactly one licence).
export function datasetMetadata(user, slug = KAGGLE_DATASET_SLUG) {
  if (!user) throw new Error("a Kaggle username is needed")
  return { title: slug, id: `${user}/${slug}`, licenses: [{ name: "CC0-1.0" }] }
}

// `kernels push` uploads only the metadata's code_file (kernels_push reads `code_file` into request.text and
// nothing else), so the run's settings travel inside spike.py: the one line ending in `# @config` becomes
// `CONFIG = {...}  # @config` with the given values.
export function embedConfig(source, config) {
  const line = /^CONFIG = .*# @config$/m
  if (!line.test(source)) throw new Error("spike.py has no `CONFIG = ...  # @config` line to fill")
  return source.replace(line, `CONFIG = ${JSON.stringify(config)}  # @config`)
}

// The models for the kernel from --models: fashn -> ["fashn"], both -> ["fashn", "leffa"].
export function modelsFor(flag) {
  return flag === "both" ? ["fashn", "leffa"] : [flag]
}

// `kaggle kernels status ID` prints `%s has status "%s"` (kernels_status_cli) and, when there is one, a second
// line `Failure message: "%s"`. The status is the enum's str(), `KernelWorkerStatus.COMPLETE` in CLI 2.x
// (older CLIs printed `complete`). Returns { status: "queued"|"running"|"complete"|"error"|
// "cancel_requested"|"cancel_acknowledged"|"new_script"|null, failure: string|null, raw }.
export function parseKernelStatus(output) {
  const text = String(output ?? "")
  const match = text.match(/has status "([^"]*)"/)
  const failure = text.match(/Failure message: "([^"]*)"/)
  let status = null
  if (match) {
    status = match[1].replace(/^KernelWorkerStatus\./, "").toLowerCase()
    if (!status) status = null
  }
  return { status, failure: failure ? failure[1] : null, raw: text.trim() }
}

// Whether a kernel status is final: complete, error, or one of the cancel states.
export function kernelDone(status) {
  return ["complete", "error", "cancel_requested", "cancel_acknowledged"].includes(status)
}

// `kaggle datasets status ID` prints the DatabundleVersionStatus name lowercased, with no newline
// (dataset_status returns payload["status"]; cli.py prints it with end=""); with `--format json(status,
// current_version_number)` it prints JSON. Returns { status: "ready"|"failed"|"blobs_received"|...|null,
// version: number|null }.
export function parseDatasetStatus(output) {
  const text = String(output ?? "").trim()
  if (!text) return { status: null, version: null }
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text)
      return { status: parsed.status ? String(parsed.status).toLowerCase() : null, version: Number.isFinite(parsed.current_version_number) ? parsed.current_version_number : null }
    } catch { /* fall through to the plain word */ }
  }
  const word = text.split(/\s+/).pop().toLowerCase()
  return { status: /^[a-z_]+$/.test(word) ? word : null, version: null }
}

// `kaggle kernels push` prints `Kernel version %s successfully pushed.  Please check progress at %s` on
// success and `Kernel push error: %s` on failure, both on stdout with exit code 0. Returns
// { version: number|null, url: string|null, error: string|null }.
export function parsePushOutput(output) {
  const text = String(output ?? "")
  const error = text.match(/Kernel push error: (.*)/)
  if (error) return { version: null, url: null, error: error[1].trim() }
  const version = text.match(/Kernel version (\d+) successfully pushed/)
  const url = text.match(/Please check progress at (\S+)/)
  if (!version && !url) return { version: null, url: null, error: text.trim() || "no answer from kaggle kernels push" }
  return { version: version ? Number(version[1]) : null, url: url ? url[1] : null, error: null }
}

// `kaggle datasets create` on a taken slug prints (exit code 0) `Dataset creation error: The requested slug
// "X" is already in use by a dataset.`; a 409 from the server would come back through format_http_error on
// stderr. Either means: make a version instead.
export function datasetAlreadyExists(output) {
  const text = String(output ?? "")
  return /already in use|already exists|409/i.test(text)
}

// The per-item lines for results.json ({NAME: {wall_seconds, category, fashn: {ok, seconds, checks, error}}}):
// "NAME fashn: PASS · shape 0.95 ok · look 0.43 colour 6.5 ok · print skipped · 66 s".
export function resultLines(results) {
  const lines = []
  for (const [name, item] of Object.entries(results ?? {})) {
    for (const which of ["fashn", "leffa"]) {
      const answer = item?.[which]
      if (!answer) continue
      if (!answer.checks) { lines.push(`${name} ${which}: FAILED ${answer.error ?? "?"}${answer.seconds != null ? ` · ${answer.seconds} s` : ""}`); continue }
      const { shape, identity, print: printed } = answer.checks
      const flag = gate => (gate.pass ? "ok" : "OFF")
      const colour = identity.colour == null ? "-" : Number(identity.colour).toFixed(1)
      const printWords = printed.skipped ? "print skipped" : `print ${Number(printed.score).toFixed(2)} ${flag(printed)}`
      lines.push(`${name} ${which}: ${answer.ok ? "PASS" : "REFUSED"} · shape ${Number(shape.score).toFixed(2)} ${flag(shape)} · look ${Number(identity.score).toFixed(2)} colour ${colour} ${flag(identity)} · ${printWords} · ${answer.seconds} s`)
    }
  }
  return lines
}

// "1 m 05 s" for a number of seconds, for the polling lines.
export function elapsedWords(seconds) {
  const s = Math.max(0, Math.round(seconds))
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, "0")} s`
}
