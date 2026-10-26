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

// Parses `node inputs.mjs LINK [LINK...] [--base URL] [--out DIR] [--body men|women]`.
export function parseArgs(argv) {
  const options = { base: "http://localhost:3000", out: "tmp/spike", body: "men" }
  const links = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const key = a.slice(2)
      if (!(key in options)) throw new Error(`unknown option ${a}`)
      options[key] = argv[++i]
      if (options[key] === undefined) throw new Error(`${a} needs a value`)
    } else links.push(a)
  }
  if (!["men", "women"].includes(options.body)) throw new Error("--body is men or women")
  return { ...options, links }
}
