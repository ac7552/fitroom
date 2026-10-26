// Run with: node --test test/javascript/*.test.mjs
// The pure parts of script/spike/audit.mjs (in script/spike/lib.mjs): the command line, names, what a
// listing's name says the item is, the red flags, the sheet and index pages.
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { auditName, expectedFrom, flagsFor, notesFor, indexHtml, kindMatches, parseAuditArgs, parseRange, sheetHtml, summaryLines, verdictWords } from "../../script/spike/lib.mjs"

test("--outfits takes a range, a list, or both; the default is all 37", () => {
  assert.deepEqual(parseRange("1-37").length, 37)
  assert.deepEqual(parseRange("3"), [3])
  assert.deepEqual(parseRange("1-3,8,10-11"), [1, 2, 3, 8, 10, 11])
  assert.deepEqual(parseRange("5, 5, 4-5"), [5, 4])
  assert.throws(() => parseRange("0-3", 37), /outside 1-37/)
  assert.throws(() => parseRange("36-40", 37), /outside 1-37/)
  assert.throws(() => parseRange("a-b"), /numbers like 1-37/)
  assert.throws(() => parseRange(""), /names no outfit/)
})

test("the audit's command line", () => {
  const defaults = parseAuditArgs([])
  assert.equal(defaults.outfits.length, 37)
  assert.deepEqual(defaults.bodies, ["men", "women"])
  assert.equal(defaults.out, "tmp/audit")
  assert.equal(defaults.base, "http://localhost:3000")
  assert.equal(defaults.resume, false)
  const some = parseAuditArgs(["--outfits", "1-10", "--body", "women", "--out", "tmp/x", "--base", "http://localhost:4000", "--resume"])
  assert.deepEqual(some.outfits, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.deepEqual(some.bodies, ["women"])
  assert.equal(some.out, "tmp/x")
  assert.equal(some.base, "http://localhost:4000")
  assert.equal(some.resume, true)
  assert.throws(() => parseAuditArgs(["--body", "kids"]), /--body is men or women or both/)
  assert.throws(() => parseAuditArgs(["https://kith.com/products/x"]), /unexpected argument/)
  assert.throws(() => parseAuditArgs(["--outfits", "40"]), /outside/)
})

test("NAME is the outfit's number, the body and the outfit's name as a slug", () => {
  assert.equal(auditName(7, "women", "Tee and jeans"), "07-women-tee-and-jeans")
  assert.equal(auditName(36, "men", "Trousers and shirt, with belt and loafers"), "36-men-trousers-and-shirt-with-belt-and-loafers")
  assert.equal(auditName(1, "men", ""), "01-men-outfit")
})

test("what a listing's name says it should be", () => {
  const expect = (name, kinds, styles = []) => assert.deepEqual(expectedFrom(name), { kinds, styles }, name)
  expect("Kith Williams III Hoodie - Navy", ["top", "jacket"], ["hoodie", "zip"])
  expect("Kith Lax Cardigan", ["top", "jacket"], ["cardigan"])
  expect("Kith Cable Knit Sweater", ["top"], ["sweater", "shortknit", "cardigan"])
  expect("Kith Nelson Crewneck", ["top"], ["sweatshirt", "hoodie", "sweater"])
  expect("Kith Sutton Polo", ["top"], ["polo"])
  expect("Kith Women Long Sleeve Tee", ["top"], ["longsleeve", "tee"])
  expect("Kith LAX Tee - White", ["top"], ["tee", "longsleeve"])
  expect("Kith Graphic T-Shirt", ["top"], ["tee", "longsleeve"])
  expect("Kith Ginza Camp Collar Shirt", ["top"], ["shirt", "shortshirt", "longsleeve", "tee"])
  expect("Kith Women Silk Blouse", ["top"], ["shirt", "shortshirt", "longsleeve", "tee"])
  expect("Oxford Dress Shirt", ["top"], ["shirt", "shortshirt", "longsleeve", "tee"])
  expect("Kith Women Tank", ["top"], ["tank"])
  expect("Kith Women Midi Dress", ["top"], ["dress"])
  expect("Levi's 501 Jeans", ["trousers"], ["jeans"])
  expect("Kith Bleecker Jogger", ["trousers"], ["joggers"])
  expect("Kith Women Sweatpant", ["trousers"], ["joggers"])
  expect("Kith Active Short", ["trousers"], ["shorts"])
  expect("Kith Women Legging", ["trousers"], ["leggings"])
  expect("Kith Women Pleated Mini Skirt", ["trousers"], ["skirt"])
  expect("Kith Aiden Pant", ["trousers"], [])
  expect("Kith Belmont Chino", ["trousers"], [])
  expect("Kith Coaches Jacket", ["jacket", "coat"], [])
  expect("Kith Varsity Jacket", ["jacket"], ["bomber"])
  expect("Kith Double Breasted Blazer", ["jacket"], ["tailored"])
  expect("Kith Wool Topcoat", ["coat", "jacket"], [])
  expect("Kith Down Parka", ["coat", "jacket"], [])
  expect("New Balance 992 Sneaker", ["shoes"], [])
  expect("Timberland 6-Inch Boot", ["shoes"], [])
  expect("Kith Leather Belt", ["belt"], [])
  expect("Kith Crew Socks", ["socks"], [])
  // A short-sleeve shirt isn't shorts; a dress shirt isn't a dress.
  expect("Kith Short Sleeve Shirt", ["top"], ["shirt", "shortshirt", "longsleeve", "tee"])
  assert.equal(expectedFrom("Kith Classic Thing"), null)
  assert.equal(expectedFrom(null), null)
})

test("the kind the import gave is checked against the name", () => {
  assert.equal(kindMatches("Kith Williams III Hoodie", "top", "hoodie"), true)
  assert.equal(kindMatches("Kith Williams III Hoodie", "jacket", "zip"), true)     // a hoodie that zips may be a jacket
  assert.equal(kindMatches("Kith Williams III Hoodie", "top", "tee"), false)
  assert.equal(kindMatches("Kith Women Silk Blouse", "jacket", "zip"), false)
  assert.equal(kindMatches("Kith Women Silk Blouse", "top", "shirt"), true)
  assert.equal(kindMatches("Levi's 501 Jeans", "trousers", "jeans"), true)
  assert.equal(kindMatches("Levi's 501 Jeans", "trousers", "joggers"), false)
  assert.equal(kindMatches("Kith Aiden Pant", "trousers", "joggers"), true)       // the name doesn't say which
  assert.equal(kindMatches("Kith Aiden Pant", "top", "tee"), false)
  assert.equal(kindMatches("Kith Wool Topcoat", "coat", null), true)
  assert.equal(kindMatches("Kith Wool Topcoat", "trousers", "jeans"), false)
  assert.equal(kindMatches("Something Else", "trousers", "jeans"), true)
})

const good = {
  handle: "x", name: "Kith LAX Tee - White", kind: "top", style: "tee", fabric: "cotton", guessed: false,
  chart: { kind: "garment", missing: [], sizes: ["S", "M", "L", "XL"] }, selected: "M", best: "M", verdict: "fits",
  checks: [{ part: "chest", status: "good", ease_cm: 8 }, { part: "length", status: "good", ease_cm: 1 }],
  photoRead: true, printRead: false, photoMapRead: false, importMs: 6000, drapeMs: 20000, settled: true
}

test("a clean item has no flags", () => {
  assert.deepEqual(flagsFor(good), [])
})

test("an import that failed is one flag, and nothing else is judged", () => {
  assert.deepEqual(flagsFor({ handle: "x", importError: "Couldn't read that." }), ["import failed: Couldn't read that."])
  assert.deepEqual(flagsFor({ handle: "x", importError: "Fitroom can't try on shoes yet.", unsupported: true }), ["not tried on: Fitroom can't try on shoes yet."])
})

test("guessed sizes and a chart with parts missing", () => {
  // Guessed sizes and chart gaps are notes; only a gap in what the fit is judged on (chest/length for tops,
  // waist/inseam for pants) is a flag.
  const gappy = { ...good, guessed: true, chart: { kind: "sizes", missing: ["length", "sleeve"], sizes: ["S", "M", "L"] } }
  assert.deepEqual(flagsFor(gappy), ["chart missing: length"])
  assert.deepEqual(notesFor(gappy), ["sizes guessed (sizes chart)", "chart has no length, sleeve"])
  assert.deepEqual(flagsFor({ ...good, chart: { kind: "sizes", missing: ["waist"], sizes: ["S", "M", "L"] } }), [])
})

test("a kind that doesn't match the name", () => {
  const flags = flagsFor({ ...good, name: "Kith Women Silk Blouse", kind: "jacket", style: "zip" })
  assert.deepEqual(flags, ["kind looks wrong: name says top (shirt/shortshirt/longsleeve/tee), got jacket (zip)"])
  assert.deepEqual(flagsFor({ ...good, name: "Levi's 501 Jeans", kind: "trousers", style: "joggers" }), ["kind looks wrong: name says trousers (jeans), got trousers (joggers)"])
})

test("the best size at either end of the chart", () => {
  assert.deepEqual(flagsFor({ ...good, best: "S", selected: "S" }), ["best size S is the smallest of S–XL"])
  assert.deepEqual(flagsFor({ ...good, best: "XL", selected: "XL" }), ["best size XL is the largest of S–XL"])
  assert.deepEqual(flagsFor({ ...good, best: "M", chart: { kind: "garment", missing: [], sizes: ["M"] } }), [])   // one size isn't an end
})

test("a part far too tight, short, loose or long", () => {
  const checks = [
    { part: "chest", status: "tight", ease_cm: -9 }, { part: "waist", status: "tight", ease_cm: -3 },
    { part: "sleeve", status: "short", ease_cm: -8.4 }, { part: "length", status: "long", ease_cm: 13 },
    { part: "seat", status: "loose", ease_cm: 12 }, { part: "inseam", status: "unknown", ease_cm: null }
  ]
  assert.deepEqual(flagsFor({ ...good, checks }), ["chest tight by 9 cm", "sleeve short by 8 cm", "length long by 13 cm"])
})

test("a print the name promises that wasn't read", () => {
  assert.deepEqual(flagsFor({ ...good, name: "Kith Striped Tee" }), ["no print read from the photo"])
  assert.deepEqual(flagsFor({ ...good, name: "Kith Striped Tee", printRead: true }), [])
  assert.deepEqual(flagsFor({ ...good, name: "Kith Logo Jogger", kind: "trousers", style: "joggers", photoMapRead: true }), [])
  assert.deepEqual(flagsFor({ ...good, name: "Kith Graphic Tee", printRead: false }), ["no print read from the photo"])
})

test("a drape that never settled, a slow import, a piece that replaced another, a flipped mannequin", () => {
  assert.deepEqual(flagsFor({ ...good, settled: false }), ["drape not settled in 4 min"])
  assert.deepEqual(flagsFor({ ...good, importMs: 41000 }), ["slow import: 41 s"])
  assert.deepEqual(flagsFor({ ...good, importMs: 40000 }), [])
  assert.deepEqual(flagsFor({ ...good, replaced: "top" }), ["replaced the top already on"])
  assert.deepEqual(flagsFor({ ...good, bodyFlipped: true }), ["the page switched the mannequin (a women's piece); switched back"])
})

test("verdicts in short words", () => {
  assert.equal(verdictWords([{ part: "chest", status: "good", ease_cm: 8 }, { part: "waist", status: "tight", ease_cm: -3 }, { part: "length", status: "long", ease_cm: 14 }, { part: "inseam", status: "unknown" }]),
    "chest fits · waist tight -3 · length long +14 · inseam unknown")
  assert.equal(verdictWords(null), "")
})

test("the sheet page holds every item, its pictures and its flags in red", () => {
  const page = sheetHtml({
    number: 3, outfitName: "Tee & jeans", body: "men", flags: 2,
    pictures: { front: "data:image/png;base64,AAAA", back: null },
    items: [
      { ...good, handle: "lax-tee", flags: [], photoData: "data:image/jpeg;base64,BBBB", warnings: ["This is an example body."] },
      { handle: "broken", importError: "Couldn't read that.", flags: ["import failed: Couldn't read that."] },
      { ...good, handle: "jeans", name: "Levi's <501> Jeans", kind: "trousers", style: "jeans", flags: ["best size 34 is the largest of 30–34"] }
    ]
  })
  assert.match(page, /<title>03-men-tee-jeans<\/title>/)
  assert.match(page, /Outfit 03 · men/)
  assert.match(page, /3 items · 2 flags/)
  assert.equal((page.match(/class="row"/g) ?? []).length, 3)
  assert.equal((page.match(/data:image\/png;base64,AAAA/g) ?? []).length, 3)   // the front on every row
  assert.match(page, /data:image\/jpeg;base64,BBBB/)
  assert.equal((page.match(/>no render</g) ?? []).length, 3)                     // no back picture
  assert.equal((page.match(/>no photo</g) ?? []).length, 2)
  assert.match(page, /Levi&#39;s|Levi's/)
  assert.match(page, /&lt;501&gt;/)                                              // names are escaped
  assert.match(page, /class="flag">⚑ import failed: Couldn&#39;t read that\.|class="flag">⚑ import failed: Couldn't read that\./)
  assert.match(page, /class="flag">⚑ best size 34 is the largest/)
  assert.match(page, /chest fits · length fits/)
  assert.match(page, /This is an example body\./)
})

test("the index links every sheet with its flag count, and the summary table lines up", () => {
  const report = { when: "2026-10-26T10:00:00Z", outfits: [
    { number: 1, outfitName: "Tee and jeans", body: "men", items: [{}, {}], flags: 0, sheet: "sheet-01-men.png", json: "01-men-tee-and-jeans.json", error: null },
    { number: 1, outfitName: "Tee and jeans", body: "women", items: [{}, {}], flags: 3, sheet: "sheet-01-women.png", json: "01-women-tee-and-jeans.json", error: null },
    { number: 2, outfitName: "Mini dress", body: "women", items: [], flags: 0, sheet: "sheet-02-women.png", json: "02-women-mini-dress.json", error: "the page broke" }
  ] }
  const index = indexHtml(report)
  assert.match(index, /3 sheets · 3 flags/)
  assert.match(index, /href="sheet-01-women\.png"/)
  assert.match(index, /class="flagged"><td class="mono">01<\/td><td>Tee and jeans<\/td><td>women<\/td>/)
  assert.match(index, /the page broke/)
  const lines = summaryLines(report)
  assert.equal(lines.length, 4)
  assert.match(lines[0], /^#\s+outfit\s+body\s+items\s+flags$/)
  assert.match(lines[2], /^01\s+Tee and jeans\s+women\s+2\s+3$/)
  assert.match(lines[3], /^02\s+Mini dress\s+women\s+0\s+0\s+the page broke$/)
  assert.deepEqual(summaryLines({}), ["#   outfit body   items flags"])
})

test("docs/outfits.json has 37 outfits with pieces for both mannequins", () => {
  const { outfits } = JSON.parse(fs.readFileSync(new URL("../../docs/outfits.json", import.meta.url), "utf8"))
  assert.equal(outfits.length, 37)
  for (const outfit of outfits) {
    assert.ok(outfit.name)
    assert.ok(outfit.men.length >= 1 && outfit.women.length >= 1, outfit.name)
    for (const handle of [...outfit.men, ...outfit.women]) assert.match(handle, /^[a-z0-9][a-z0-9_-]*$/, handle)
  }
})
