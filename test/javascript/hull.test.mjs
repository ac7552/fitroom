// Run with: node --test test/javascript/*.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import "./support/lib.mjs"

const { hullGeometry } = await import("lib/garments/hull")

// A foot to stand on: a body snapshot of one leg as a cylinder on a flat sole (part 4: the legs), its
// frame; enough for legSlices.
function leg() {
  const positions = [], index = [], part = []
  const rings = 14, around = 24
  for (let k = 0; k < rings; k++) {
    const y = k * 0.02
    for (let j = 0; j < around; j++) {
      const a = (j / around) * 2 * Math.PI
      // A foot below 5 cm (long along z), a shin above.
      const rz = y < 0.05 ? 0.12 : 0.045, rx = y < 0.05 ? 0.045 : 0.045
      positions.push(0.1 + rx * Math.sin(a), y, (y < 0.05 ? 0.04 : 0) + rz * Math.cos(a))
      part.push(4)
    }
  }
  for (let k = 0; k + 1 < rings; k++) for (let j = 0; j < around; j++) {
    const a = k * around + j, b = k * around + (j + 1) % around, c = a + around, d = b + around
    index.push(a, b, c, b, d, c)
  }
  return { body: { positions: Float32Array.from(positions), index: Uint32Array.from(index), count: positions.length / 3 }, frame: { floor: 0, top: 1.76, part } }
}

// A side outline: a low shoe 0.3 as tall as it's long over 64 bins, its sole on the floor.
function sideOutline() {
  const bins = 64
  const top = Array.from({ length: bins }, (_, b) => 0.5 + 0.15 * (b / bins))   // lower toward the toe
  const bottom = Array.from({ length: bins }, () => 0.9)
  return { top, bottom, sole: bottom.map(v => v - 0.04), left: 0.2, right: 0.8, aspect: 1, toeRight: true, height: 0.4 }
}
// A view from above (toe up): a rounded outline 128 rows tall, as wide as a third of its length.
function topView() {
  const rows = Array.from({ length: 128 }, (_, r) => { const t = r / 127, w = 0.16 * Math.sqrt(1 - (2 * t - 1) ** 2) + 0.02; return [0.5 - w, 0.5 + w] })
  return { kind: "top", aspect: 1.2, shoes: [{ left: 0.3, right: 0.7, top: 0.1, bottom: 0.9, toeUp: true, silhouette: rows, rows: rows.slice(0, 48) }] }
}

test("the hull is a closed, outward-wound mesh over the foot, carved by the top view's width", () => {
  const { body, frame } = leg()
  const geometry = hullGeometry(body, frame, "L", sideOutline(), [topView()], { thick: 0.007, toe: 0.014 })
  assert.ok(geometry, "a hull")
  const p = geometry.attributes.position
  assert.ok(p.count > 500, `${p.count} vertices`)
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity
  for (let i = 0; i < p.count; i++) { xmin = Math.min(xmin, p.getX(i)); xmax = Math.max(xmax, p.getX(i)); ymin = Math.min(ymin, p.getY(i)); ymax = Math.max(ymax, p.getY(i)) }
  // On the floor, and as wide as the top view's outline (a third of the length, about 9 cm), not the box.
  assert.ok(ymin > -0.01 && ymin < 0.01, `floor ${ymin}`)
  assert.ok(xmax - xmin > 0.06 && xmax - xmin < 0.13, `width ${xmax - xmin}`)
  // Groups: the sole below the side photo's sole line, the upper above.
  assert.equal(geometry.groups.length, 2)
  assert.ok(geometry.groups[0].count > 0 && geometry.groups[1].count > geometry.groups[0].count)
  // Closed: every edge shared by two triangles.
  const edges = new Map()
  const index = geometry.index.array
  for (let t = 0; t < index.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = index[t + e], b = index[t + (e + 1) % 3], key = a < b ? `${a}-${b}` : `${b}-${a}`
    edges.set(key, (edges.get(key) ?? 0) + 1)
  }
  const open = [...edges.values()].filter(v => v !== 2).length
  assert.ok(open < edges.size * 0.02, `${open} of ${edges.size} edges not shared by two triangles`)
  // Consistently wound: the two triangles on an edge run it opposite ways.
  const directed = new Set()
  let same = 0
  for (let t = 0; t < index.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = index[t + e], b = index[t + (e + 1) % 3]
    if (directed.has(`${a}-${b}`)) same++
    directed.add(`${a}-${b}`)
  }
  assert.ok(same < edges.size * 0.02, `${same} edges run the same way by both triangles`)
  assert.ok(geometry.userData.photo.metres > 0)
})
