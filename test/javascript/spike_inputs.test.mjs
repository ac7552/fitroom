// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { categoryFor, crc32, extensionFor, lastSegment, parseArgs, slugFor, uniqueName, writeStoreZip } from "../../script/spike/lib.mjs"

test("a garment's name becomes a plain file name", () => {
  assert.equal(slugFor("Kith Adley Striped Hoodie - Navy", "https://kith.com/products/x"), "kith-adley-striped-hoodie-navy")
  assert.equal(slugFor("  Café Crème Tee!! ", "https://x.com/a"), "cafe-creme-tee")
  assert.equal(slugFor("x".repeat(80), "https://x.com/a").length, 60)
})

test("without a name, the link's last path segment", () => {
  assert.equal(slugFor(null, "https://kith.com/products/adley-hoodie?variant=1"), "adley-hoodie")
  assert.equal(slugFor("", "https://kith.com/products/adley-hoodie/"), "adley-hoodie")
  assert.equal(lastSegment("not a url/with/segments"), "segments")
  assert.equal(slugFor("", "https://kith.com/"), "item")
})

test("two items with the same name get numbered", () => {
  const taken = new Set(["tee", "tee-2"])
  assert.equal(uniqueName("tee", taken), "tee-3")
  assert.equal(uniqueName("coat", taken), "coat")
})

test("kinds map to the sheet's categories; accessories are skipped", () => {
  assert.equal(categoryFor("top"), "tops")
  assert.equal(categoryFor("jacket"), "tops")
  assert.equal(categoryFor("coat"), "tops")
  assert.equal(categoryFor("trousers"), "bottoms")
  for (const kind of ["shoes", "socks", "belt", "hat", undefined]) assert.equal(categoryFor(kind), null)
})

test("the garment file's extension follows the photo's type", () => {
  assert.equal(extensionFor("image/png"), "png")
  assert.equal(extensionFor("image/jpeg; charset=binary"), "jpg")
  assert.equal(extensionFor("image/webp"), "webp")
  assert.equal(extensionFor(""), "jpg")
  assert.equal(extensionFor(undefined), "jpg")
})

test("arguments: links and the three options", () => {
  const parsed = parseArgs(["https://a.com/x", "--out", "tmp/s", "https://b.com/y", "--body", "women"])
  assert.deepEqual(parsed, { base: "http://localhost:3000", out: "tmp/s", body: "women", links: ["https://a.com/x", "https://b.com/y"] })
  assert.throws(() => parseArgs(["--body", "kids"]), /men or women/)
  assert.throws(() => parseArgs(["--nope", "1"]), /unknown option/)
  assert.throws(() => parseArgs(["--out"]), /needs a value/)
})

test("crc32 matches the standard", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926)
  assert.equal(crc32(Buffer.alloc(0)), 0)
})

test("the store-only zip unzips with the system's unzip", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spike-zip-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const files = [
    { name: "tee-category.txt", data: Buffer.from("tops\n") },
    { name: "tee-person.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) }
  ]
  const zip = writeStoreZip(path.join(dir, "spike.zip"), files)
  const bytes = fs.readFileSync(zip)
  assert.equal(bytes.readUInt32LE(0), 0x04034b50)
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50)
  let unzip = true
  try { execFileSync("unzip", ["-q", zip, "-d", path.join(dir, "out")], { stdio: "ignore" }) } catch (error) { if (error.code === "ENOENT") unzip = false; else throw error }
  if (!unzip) { t.diagnostic("no unzip on this machine; header check only"); return }
  assert.equal(fs.readFileSync(path.join(dir, "out", "tee-category.txt"), "utf8"), "tops\n")
  assert.deepEqual([...fs.readFileSync(path.join(dir, "out", "tee-person.png"))], [0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
})
