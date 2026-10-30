// Run with: node --test test/javascript/*.test.mjs
import "./support/lib.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"

const { barPlace, barWords, markClass, partRow, uncheckedLine, verdictWords, OK_FROM, OK_TO } = await import("lib/fit_bar")
const { namedStops, nearestSize, sizeSlider, stopNear, stopPlaces, waistAndLeg } = await import("lib/size_slider")

test("a size's marker sits in the shaded middle third when it fits, and nearer an end the further off it is", () => {
  // Chest: 6 to 14 cm of room fits.
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`)
  near(barPlace(6, [6, 14]), OK_FROM)
  near(barPlace(14, [6, 14]), OK_TO)
  assert.equal(barPlace(10, [6, 14]), 0.5)
  assert.ok(barPlace(2, [6, 14]) < OK_FROM && barPlace(2, [6, 14]) > 0.03)
  // Far outside, it stops at the bar's end.
  assert.equal(barPlace(40, [6, 14]), 0.97)
  assert.equal(barPlace(-40, [6, 14]), 0.03)
  // A tolerance of a centimetre either way (a sleeve) is drawn as 2 cm wide, so 1 cm long is still inside.
  near(barPlace(1, [-1, 1]), OK_TO)
  assert.equal(barPlace(null, [6, 14]), null)
  assert.equal(barPlace(8, null), null)
})

test("each part says where it is in a few words, with a tailor's mark when one can fix it", () => {
  assert.equal(barWords({ part: "chest", status: "good", ease_cm: 12.7, good_cm: [6, 14] }, "in"), "5 in room")
  assert.equal(barWords({ part: "shoulders", status: "loose", ease_cm: 5.08, good_cm: [-0.75, 0] }, "in"), "2 in too wide.")
  assert.equal(barWords({ part: "sleeve", status: "long", ease_cm: 8.6, good_cm: [-1, 1], fix: { text: "Shorten the sleeves", amount_cm: 7.6 } }, "in"),
               "3 in too long. ✂ A tailor can shorten the sleeves.")
  assert.equal(barWords({ part: "chest", status: "tight", ease_cm: 2.54, good_cm: [6, 14] }, "in"), "Only 1 in room.")
  assert.equal(barWords({ part: "chest", status: "good", ease_cm: -3, good_cm: [-8, 1], note: "Stretches to fit close to the body" }, "cm"),
               "Stretches to fit close to the body")
  assert.equal(barWords({ part: "length", status: "good", ease_cm: 0.5, good_cm: [-2, 2] }, "cm"), "Just right")
  assert.equal(markClass("short"), "tight")
  assert.equal(markClass("long"), "loose")
  assert.equal(markClass("good"), "good")
})

test("a part with no range to place it in is words only; one with a range gets its bar, ends and marker", () => {
  const coat = partRow({ part: "length", label: "Length", status: "good", ease_cm: 3, note: "It ends mid-thigh" }, "in")
  assert.match(coat, /part-bar--none/)
  assert.match(coat, /It ends mid-thigh/)
  const shoulders = partRow({ part: "shoulders", label: "Shoulders", status: "loose", ease_cm: 5, good_cm: [-0.75, 1.5] }, "in")
  assert.match(shoulders, /Narrow<\/span><span>Wide/)
  assert.match(shoulders, /part-mark--loose/)
})

test("the parts that couldn't be checked go in one line", () => {
  assert.equal(uncheckedLine([{ part: "chest", status: "good" }]), "")
  assert.equal(uncheckedLine([{ part: "waist", label: "Waist", status: "unknown" }, { part: "seat", label: "Seat", status: "unknown", note: "Add your hips to check this" }]),
               "Not checked: waist (the chart doesn't say) and seat (add your hips).")
})

test("one sentence says how a size fits: as it is, after a tailor, or what can't be fixed", () => {
  assert.deepEqual(verdictWords({ size: "M", verdict: "fits", checks: [] }, "M", "in"), { lead: "M fits best.", rest: "Nothing needs to change." })
  assert.deepEqual(verdictWords({ size: "L", verdict: "alter", checks: [{ part: "waist", status: "loose", fixable: true, fix: { text: "Take in the waist", amount_cm: 2.54 } }] }, "M", "in"),
                   { lead: "L fits after a tailor:", rest: "Take in the waist by about 1 inch." })
  const big = verdictWords({ size: "XL", verdict: "compromise", checks: [
    { part: "shoulders", status: "loose", ease_cm: 6.6, good_cm: [-0.75, 1.5], fixable: false },
    { part: "sleeve", status: "long", ease_cm: 8.6, good_cm: [-1, 1], fixable: false },
    { part: "chest", status: "good", ease_cm: 10, good_cm: [6, 14], fixable: true }
  ] }, "M", "in")
  assert.deepEqual(big, { lead: "XL:", rest: "2 in wide at the shoulders and 3 in long in the sleeves. A tailor can't fix those." })
  // Just outside the range: a little, not "0 in".
  const small = verdictWords({ size: "S", verdict: "compromise", checks: [{ part: "shoulders", status: "tight", ease_cm: -0.9, good_cm: [-0.75, 1.5], fixable: false }] }, "M", "in")
  assert.equal(small.rest, "A little narrow at the shoulders. A tailor can't fix that.")
})

test("the sizes are evenly spread stops in the store's order, and a drag picks the nearest", () => {
  assert.deepEqual(stopPlaces(1), [0.5])
  assert.deepEqual(stopPlaces(3), [0, 0.5, 1])
  assert.equal(stopNear(0.4, 3), 1)
  assert.equal(stopNear(-1, 3), 0)
  assert.equal(stopNear(2, 3), 2)
  const html = sizeSlider({ kind: "top", label: "Top", sizes: [{ size: "S", verdict: "compromise" }, { size: "M", verdict: "fits" }, { size: "L", verdict: "alter" }], shown: "L", best: "M" })
  const stops = [...html.matchAll(/data-size="([^"]+)"/g)].map(m => m[1])
  assert.deepEqual(stops, ["S", "M", "L"])
  assert.match(html, /aria-checked="true"[^>]*data-size="L"|data-size="L"[^>]*aria-checked="true"|aria-checked="true" tabindex="0"[\s\S]*?data-size="L"/)
  assert.equal((html.match(/<small>Best<\/small>/g) ?? []).length, 1)
  assert.match(html, /aria-label="M, best"/)
})

test("too many sizes to name each: every few are named, and always the ends, the one shown and the best", () => {
  const names = Array.from({ length: 20 }, (_, i) => String(6 + i / 2))
  const named = namedStops(names, "9.5", "11")
  assert.ok(named[0] && named[19] && named[names.indexOf("9.5")] && named[names.indexOf("11")])
  assert.ok(named.filter(Boolean).length < 14)
})

test("pants sold by waist and leg get a waist line and a leg line", () => {
  const names = ["30x30", "30x32", "32x30", "32x32", "32x34", "34x30", "34x32", "34x34", "36x32", "36x34"]
  const split = waistAndLeg(names)
  assert.deepEqual(split.waists, [30, 32, 34, 36])
  assert.deepEqual(split.legs, [30, 32, 34])
  // A waist the leg isn't sold in keeps the nearest leg.
  assert.equal(nearestSize(split, 30, 34), "30x32")
  assert.equal(nearestSize(split, 36, 30), "36x32")
  const html = sizeSlider({ kind: "trousers", label: "Pants", sizes: names.map(size => ({ size, verdict: "fits" })), shown: "32x32", best: "32x32" })
  assert.equal((html.match(/class="sizer sizer--split"/g) ?? []).length, 2)
  assert.match(html, />Waist</)
  assert.match(html, />Leg</)
  // A few letter sizes stay one line.
  assert.equal(waistAndLeg(["S", "M", "L"]), null)
})
