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
export function parseArgs(argv, defaults = {}, flags = []) {
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
  if (!["men", "women"].includes(options.body)) throw new Error("--body is men or women")
  return { ...options, links }
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
