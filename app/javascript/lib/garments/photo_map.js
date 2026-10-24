// Where each point of a draped pair of pants (or a skirt) lies in its shop photo, so the photo can be laid on
// the cloth: the wash and fading of jeans, a print, pockets and seams, as photographed. The photo shows the
// front; the back pieces take a softened copy (its colours and fading, see print.js's readBottomPhoto) from
// the same place, as the back of a leg is mostly washed and faded like its front.
//
// cloth: from cloth.js; pattern: from pants.js; layout: print.js's readBottom layout. Returns a Float32Array
// of [u, v, which] per cloth point: texture coordinates in the photo (v up, as textures run), and which copy
// to draw there (1 the photo, 2 the softened one, 0 none).
//
// The photo is front on, so the wearer's left leg is on its right. Down the photo, the waistband's top is
// its top row and the hem its bottom one, in proportion to the pants' own lengths (band, rise and leg, and
// a cuff).
export function bottomsPhotoUV(cloth, pattern, layout) {
  const m = pattern.measures
  const { w, h, top, bottom, crotch, rows } = layout
  const total = m.band + m.length + (m.cuff ?? 0)
  const scale = (bottom - top) / total   // photo pixels per cm
  const out = new Float32Array(3 * cloth.points.length)
  // Rows and columns a few pixels inside the garment's outline, which is half backdrop and its shadow.
  const edge = Math.max(3, Math.round(w * 0.006))
  const rowAt = y => {
    const r = Math.min(Math.max(Math.round(y), top + edge), bottom - edge)
    const k = 4 * (r - top)
    return { y: r, left: rows[k], right: rows[k + 1], innerLeft: rows[k + 2], innerRight: rows[k + 3] }
  }
  // From a (u = 0) to b (u = 1) across the photo, kept inside the garment's edges a little, so its outline
  // isn't stretched along a seam.
  const between = (a, b, u) => {
    const e = Math.min(Math.max(edge, Math.abs(b - a) * 0.03), Math.abs(b - a) / 3) * Math.sign(b - a)
    return a + e + Math.min(Math.max(u, 0), 1) * (b - a - 2 * e)
  }
  const put = (i, x, y, which) => {
    const yy = Math.min(Math.max(y, top + edge), bottom - edge)
    out[3 * i] = x / w; out[3 * i + 1] = 1 - yy / h; out[3 * i + 2] = which
  }

  // A point on the photo's row at height y (pixels): `u` of the way from the middle (0) out to the wearer's
  // `side` ("L" or "R"), on that leg below the crotch.
  const across = (y, side, u) => {
    const row = rowAt(y)
    const middle = (row.left + row.right) / 2
    if (row.innerLeft < 0 || crotch === null || row.y < crotch) return side === "L" ? between(middle, row.right, u) : between(middle, row.left, u)
    return side === "L" ? between(row.innerRight, row.right, u) : between(row.innerLeft, row.left, u)
  }

  const spans = new Map()
  cloth.panels.forEach((name, p) => {
    const panel = pattern.panels[name]
    if (panel.place.at === "leg") spans.set(p, legSpan(panel.edges, m))
  })
  const bandCuts = band => {
    const sewn = band.edges.filter(e => e.name.startsWith("sewn_")).map(e => [e.points[0][0], e.points[e.points.length - 1][0]])
    return sewn
  }
  const cuts = {}
  for (const name of cloth.panels) if (pattern.panels[name].place.at === "band") cuts[name] = bandCuts(pattern.panels[name])

  for (let i = 0; i < cloth.points.length; i++) {
    const name = cloth.panels[cloth.panel[i]]
    const panel = pattern.panels[name]
    const [px, py] = cloth.points[i]
    const place = panel.place
    if (place.at === "leg") {
      // A leg piece: down from the waistband's seam, and across from its middle seam (the crotch, then the
      // inseam) to its side seam.
      const [inner, outer] = spans.get(cloth.panel[i])(py)
      const u = (px - inner) / ((outer - inner) || 1)
      const y = top + (m.band - py) * scale
      put(i, across(y, place.side, u), y, place.part === "front" ? 1 : 2)
    } else if (place.at === "skirt") {
      // A skirt's front or back: across from side to side (+x the wearer's left on the front, their right
      // on the back).
      const half = halfWidthAt(panel.edges, py)
      const u = (px / (half || 1) + 1) / 2
      const y = top + (m.band - py) * scale
      const row = rowAt(y)
      const v = place.part === "front" ? u : 1 - u
      put(i, between(row.left, row.right, v), y, place.part === "front" ? 1 : 2)
    } else if (name === "waistband") {
      // The waistband, sewn round from the middle of the back: the back's right half, the front's right, the
      // front's left and the back's left.
      const k = segmentOf(cuts[name], px)
      const [a, b] = cuts[name][k]
      const f = (px - a) / ((b - a) || 1)
      const y = top + (m.band - py) * scale
      const row = rowAt(y), middle = (row.left + row.right) / 2
      if (cuts[name].length === 2) {
        // A skirt's: the back, then the front, each from side to side.
        put(i, k === 1 ? between(row.left, row.right, f) : between(row.right, row.left, f), y, k === 1 ? 1 : 2)
        continue
      }
      const x = k === 0 ? between(middle, row.left, f) : k === 1 ? between(row.left, middle, f) : k === 2 ? between(middle, row.right, f) : between(row.right, middle, f)
      put(i, x, y, k === 1 || k === 2 ? 1 : 2)
    } else if (name.startsWith("cuff_")) {
      // A cuff, below its leg's hem: the leg's colours there, softened (it's a rib, not the leg's cloth).
      const y = top + (m.band + m.length - py) * scale
      put(i, across(y, place.side, 0.5), y, 2)
    }
  }
  return out
}

// A leg piece's inner and outer edges (x, cm) at a height py: the crotch seam, then the inseam, and the side.
function legSpan(edges, m) {
  const along = name => edges.find(e => e.name === name).points
  const side = along("side"), inseam = along("inseam"), crotch = along("crotch")
  return py => [py < -m.rise ? xAt(inseam, py) : xAt(crotch, py), xAt(side, py)]
}

// A skirt piece's half width at a height.
function halfWidthAt(edges, py) {
  const side = edges.find(e => e.name.startsWith("side_"))
  return Math.abs(xAt(side.points, py))
}

function segmentOf(cuts, x) {
  for (let k = 0; k < cuts.length; k++) {
    const [a, b] = cuts[k]
    if ((x - a) * (x - b) <= 0) return k
  }
  // Past either end (rounding): the nearer end's piece.
  return x < Math.min(...cuts.flat()) === (cuts[0][0] < cuts[cuts.length - 1][1]) ? 0 : cuts.length - 1
}

// The x where a polyline crosses height y, or its nearer end's x past its ends.
function xAt(points, y) {
  for (let k = 1; k < points.length; k++) {
    const [x0, y0] = points[k - 1], [x1, y1] = points[k]
    if ((y - y0) * (y - y1) <= 0 && y0 !== y1) return x0 + (x1 - x0) * (y - y0) / (y1 - y0)
  }
  const first = points[0], last = points[points.length - 1]
  return Math.abs(y - first[1]) < Math.abs(y - last[1]) ? first[0] : last[0]
}
