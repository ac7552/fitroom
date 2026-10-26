// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { landmarksToMeasurements, silhouette, ellipse, USUAL } from "../../app/javascript/lib/measure_photo.js"

// Two made-up bodies, the example men's and women's numbers from the page, laid out from standard body
// proportions (nose 0.905 of the height, shoulders 0.818, hips 0.530, knees 0.285, ankles 0.039). Widths
// and depths are a torso outline in cm by height from the floor.
const MAN = {
  height: 178, want: { chest: 101.6, waist: 86.4, shoulders: 45.5, arm: 65.5, hips: 101, inseam: 81 },
  shoulderSpan: 43.3, hipSpan: 22, upperArm: 34.5, forearm: 29,
  // [height from floor, width] in cm
  front: [[178, 0], [170, 15], [160, 12], [147, 46], [133, 34], [120, 32], [110, 29], [100, 32], [92.5, 35], [85, 34], [81, 0]],
  side: [[178, 0], [170, 20], [160, 12], [147, 26], [133, 24], [120, 23], [110, 21], [100, 22], [92.5, 23], [85, 22], [60, 17], [0, 10]]
}
const WOMAN = {
  height: 165, want: { chest: 91.5, waist: 74, shoulders: 39.5, arm: 58, hips: 99, inseam: 76 },
  shoulderSpan: 37.6, hipSpan: 22, upperArm: 30.5, forearm: 25.5,
  front: [[165, 0], [158, 14], [149, 11], [136, 40], [123, 30], [112, 27], [102, 25], [93, 31], [86, 35], [79, 34], [75, 0]],
  side: [[165, 0], [158, 19], [149, 11], [136, 23], [123, 22], [112, 20], [102, 18], [93, 21], [86, 22], [79, 21], [55, 16], [0, 9]]
}

const SIZE = { width: 768, height: 1024 }

// The 33 landmarks for a body (cm points → normalized), the person filling 85% of the photo's height.
// side: the same body seen from its left, every point near the centre line.
function photo(body, { side = false, visibility = 0.98, armAngle = 20 } = {}) {
  const H = body.height
  const pxPerCm = (0.85 * SIZE.height) / H
  const top = 0.075 * SIZE.height
  const norm = (xCm, yCm) => ({ x: (SIZE.width / 2 + xCm * pxPerCm) / SIZE.width, y: (top + (H - yCm) * pxPerCm) / SIZE.height, z: 0, visibility })
  const points = Array.from({ length: 33 }, () => norm(0, H * 0.9))
  const rad = (armAngle * Math.PI) / 180
  const place = (i, x, y) => { points[i] = norm(side ? (i === 0 ? 6 : 0) : x, y) }
  place(0, 0, 0.905 * H)
  const shoulderY = 0.818 * H, hipY = 0.53 * H
  for (const [sign, s, e, w, hip, knee, ankle, heel] of [[1, 11, 13, 15, 23, 25, 27, 29], [-1, 12, 14, 16, 24, 26, 28, 30]]) {
    const sx = sign * body.shoulderSpan / 2
    place(s, sx, shoulderY)
    const ex = sx + sign * body.upperArm * Math.sin(rad), ey = shoulderY - body.upperArm * Math.cos(rad)
    place(e, ex, ey)
    place(w, ex + sign * body.forearm * Math.sin(rad), ey - body.forearm * Math.cos(rad))
    place(hip, sign * body.hipSpan / 2, hipY)
    place(knee, sign * 9, 0.285 * H)
    place(ankle, sign * 9, 0.039 * H)
    place(heel, sign * 9, 3.5)
  }
  const widths = new Float32Array(SIZE.height)
  const outline = side ? body.side : body.front
  for (let row = 0; row < SIZE.height; row++) {
    const yCm = H - (row + 0.5 - top) / pxPerCm
    widths[row] = Math.max(0, lerp(outline, yCm)) * pxPerCm
  }
  return { landmarks: points, silhouette: { width: SIZE.width, height: SIZE.height, widths } }
}

// A width from an outline, straight lines between its points (0 outside them).
function lerp(outline, y) {
  for (let i = 0; i < outline.length - 1; i++) {
    const [y0, w0] = outline[i], [y1, w1] = outline[i + 1]
    if (y <= y0 && y >= y1) return w0 + ((y0 - y) / (y0 - y1)) * (w1 - w0)
  }
  return 0
}

function measure(body, options = {}) {
  const front = photo(body, options), side = photo(body, { ...options, side: true })
  return landmarksToMeasurements({
    front: front.landmarks, frontSize: SIZE, frontSilhouette: options.noSilhouette ? null : front.silhouette,
    side: side.landmarks, sideSize: SIZE, sideSilhouette: options.noSilhouette ? null : side.silhouette,
    heightCm: options.heightCm ?? body.height
  })
}

function within(got, want, share, label) {
  assert.ok(Math.abs(got - want) <= want * share, `${label}: got ${got}, wanted ${want} ±${Math.round(share * 100)}%`)
}

for (const [name, body] of [["a 178 cm man", MAN], ["a 165 cm woman", WOMAN]]) {
  test(`${name} with outlines comes within 6% on every number`, () => {
    const got = measure(body)
    for (const [part, want] of Object.entries(body.want)) within(got[part], want, 0.06, `${name} ${part}`)
    assert.ok(got.confidence >= 0.9, `confidence ${got.confidence}`)
    assert.deepEqual(got.notes, [])
  })

  test(`${name} without outlines is rougher but still close, and says so`, () => {
    const got = measure(body, { noSilhouette: true })
    for (const [part, want] of Object.entries(body.want)) within(got[part], want, 0.12, `${name} ${part}`)
    assert.ok(got.confidence < 0.6, `confidence ${got.confidence}`)
    assert.ok(got.notes.some(n => n.includes("outline")))
  })
}

test("numbers are rounded to half a centimetre", () => {
  const got = measure(MAN)
  for (const part of Object.keys(USUAL)) assert.equal(got[part] * 2, Math.round(got[part] * 2))
})

test("a typed height that doesn't fit the photos clamps to the usual range and lowers confidence", () => {
  const got = measure(MAN, { heightCm: 120 })
  assert.equal(got.chest, USUAL.chest[0])
  assert.equal(got.shoulders, USUAL.shoulders[0])
  assert.equal(got.inseam, USUAL.inseam[0])
  assert.ok(got.confidence < 0.5, `confidence ${got.confidence}`)
  assert.ok(got.notes.some(n => n.includes("usual range")))
})

test("hidden landmarks lower confidence with a note", () => {
  const got = measure(WOMAN, { visibility: 0.5 })
  assert.ok(got.confidence < 0.6)
  assert.ok(got.notes.some(n => n.includes("hard to see")))
})

test("arms held against the body are flagged", () => {
  const got = measure(MAN, { armAngle: 0 })
  assert.ok(got.notes.some(n => n.includes("close to your body")))
  assert.ok(got.confidence < 1)
})

test("a leaning person is flagged", () => {
  const front = photo(MAN), side = photo(MAN, { side: true })
  front.landmarks[0] = { ...front.landmarks[0], x: front.landmarks[0].x + 0.12 }
  const got = landmarksToMeasurements({ front: front.landmarks, frontSize: SIZE, side: side.landmarks, sideSize: SIZE, heightCm: 178 })
  assert.ok(got.notes.some(n => n.includes("leaning")))
})

test("no person, no height: plain-word errors", () => {
  const side = photo(MAN, { side: true })
  assert.throws(() => landmarksToMeasurements({ front: null, side: side.landmarks, frontSize: SIZE, sideSize: SIZE, heightCm: 178 }), /front photo/)
  assert.throws(() => landmarksToMeasurements({ front: side.landmarks, side: [], frontSize: SIZE, sideSize: SIZE, heightCm: 178 }), /side photo/)
  assert.throws(() => landmarksToMeasurements({ front: side.landmarks, side: side.landmarks, frontSize: SIZE, sideSize: SIZE, heightCm: 0 }), /height/)
})

test("the ellipse edge matches a circle and Ramanujan's known values", () => {
  assert.ok(Math.abs(ellipse(10, 10) - 2 * Math.PI * 10) < 1e-9)
  assert.ok(Math.abs(ellipse(10, 5) - 48.442) < 0.01)
})

test("silhouette widths follow the run at the centre, leaving out arms held away from the body", () => {
  // 20 wide, 6 tall: a torso 6 wide at the centre, arms 3 wide with a gap on each side, nothing on the last rows.
  const width = 20, height = 6
  const data = new Float32Array(width * height)
  const paint = (row, from, to) => { for (let x = from; x <= to; x++) data[row * width + x] = 1 }
  for (const row of [0, 1, 2]) { paint(row, 7, 12); paint(row, 2, 4); paint(row, 15, 17) }
  paint(3, 4, 15)
  const sil = silhouette({ width, height, data }, { centerX: 0.5 })
  assert.deepEqual(Array.from(sil.widths), [6, 6, 6, 12, 0, 0])
  assert.equal(sil.top, 0)
  assert.equal(sil.bottom, 3)
  // Uint8 masks use 128 as the cut-off.
  const bytes = Uint8Array.from(data, v => v * 255)
  assert.deepEqual(Array.from(silhouette({ width, height, data: bytes }).widths), [6, 6, 6, 12, 0, 0])
})
