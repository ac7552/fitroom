// Sewing patterns for pants, shorts, joggers and leggings, drafted from one size's chart the way a pattern
// maker drafts a trouser block. Pure functions; everything is in cm. The pattern has the same shape as a
// top's (see pattern.js): panels with their edges anticlockwise seen from outside, and seams.
//
// Four leg pieces, a front and a back for each leg, joined down the outside of the leg (the side seam), the
// inside of the leg (the inseam) and round the crotch (the front and back rise seams), with a waistband on
// top, and a rib cuff at the ankle on joggers.
//
// Pattern axes: x across, y up, y = 0 at the top of the pants (the waistband's seam). On the front pieces
// +x is towards the wearer's left; on the back ones, towards their right (both as seen from outside). The
// crotch extension reaches past the middle (x < 0 on the left front) to meet the other leg.
import { bezier, line, mirrored, reversed } from "lib/garments/curves"

// How each kind of pants is made: its cloth, its waistband, and its hem.
export const BOTTOM_STYLES = {
  trousers: { fabric: "twill", band: { height: 4, stretch: 0.98 }, cuff: null },
  jeans: { fabric: "denim", band: { height: 4, stretch: 0.98 }, cuff: null },
  joggers: { fabric: "fleece", band: { height: 4.5, stretch: 0.82 }, cuff: { height: 7, stretch: 0.62 } },
  leggings: { fabric: "stretch", band: { height: 6, stretch: 0.92 }, cuff: null },
  shorts: { fabric: "twill", band: { height: 4, stretch: 0.98 }, cuff: null },
  skirt: { fabric: "twill", band: { height: 3.5, stretch: 0.98 }, cuff: null }
}

// How wide a skirt's hem is, over its hips, by its fit: a pencil skirt (fitted), slim, relaxed, an A-line
// (flared), or pleated (very full).
const SKIRT_HEM = { fitted: 0.92, slim: 1.02, relaxed: 1.15, flared: 1.45, pleated: 1.8 }

// The front takes a little less of each round than the back (the seat is behind).
const FRONT = 0.47
// How much higher (cm) the back's waist rises at its middle, over the seat.
export const BACK_RAISE = 4

// size: { waist, seat, thigh, knee, inseam, leg_opening, rise } (cm round, or long; any but the waist may be
// null). body: the wearer in cm ({ waist, hips, inseam, height }, and from the mesh: rise, the height from the
// crotch up to the natural waist). style: a BOTTOM_STYLES name.
export function draftBottoms(styleName, size, body, cut = null) {
  if (styleName === "skirt") return draftSkirt(size, body, cut)
  const style = BOTTOM_STYLES[styleName] ?? BOTTOM_STYLES.trousers
  const m = bottomMeasures(styleName, size, body, cut)
  // Pull-on pants (an elastic or drawcord waist): the pieces are cut nearly as wide at the top as the seat,
  // and the waistband, at the chart's relaxed waist, gathers them in. Cut at that waist instead, the pieces
  // flare out from it to the seat like a balloon.
  const gathered = cut?.elastic && styleName !== "joggers" && styleName !== "leggings"
  if (gathered) m.waistCut = Math.max(m.waist, m.seat * 0.82)
  const panels = {}, seams = []
  for (const part of ["front", "back"]) {
    const plus = legPiece(m, part, { slant: ["trousers", "jeans"].includes(styleName) ? HEM_SLANT : 0 })
    // The left front and the right back are drawn as made; the other two are their mirror images.
    const [made, mirror] = part === "front" ? ["L", "R"] : ["R", "L"]
    panels[`${part}_${made}`] = { edges: plus, place: { at: "leg", side: made, part }, fabric: "main" }
    panels[`${part}_${mirror}`] = { edges: mirrorPiece(plus), place: { at: "leg", side: mirror, part }, fabric: "main" }
  }
  for (const side of ["L", "R"]) {
    seams.push([`front_${side}`, "side", `back_${side}`, "side"])
    seams.push([`front_${side}`, "inseam", `back_${side}`, "inseam"])
  }
  seams.push(["front_L", "crotch", "front_R", "crotch"])
  seams.push(["back_L", "crotch", "back_R", "crotch"])

  // The waistband, sewn round from the centre back: the back's right half, the front's right half, its left
  // half, the back's left half (see pattern.js's band, whose sewn edge runs the other way to the edges).
  const waists = [["back_R", "waist"], ["front_R", "waist"], ["front_L", "waist"], ["back_L", "waist"]]
  const waistLengths = waists.map(([p, e]) => lengthOf(edgeOf(panels[p].edges, e)))
  const bandStretch = gathered ? Math.max(0.6, m.waist / m.waistCut) : style.band.stretch
  panels.waistband = { edges: band(waistLengths, bandStretch, style.band.height, "up"), place: { at: "band", toward: "up" }, fabric: styleName === "joggers" ? "rib" : "main" }
  waists.forEach(([p, e], i) => seams.push([p, e, "waistband", `sewn_${i}`]))
  seams.push(["waistband", "end_a", "waistband", "end_b"])

  if (style.cuff) {
    for (const side of ["L", "R"]) {
      const hems = [[`front_${side}`, "hem"], [`back_${side}`, "hem"]]
      const name = `cuff_${side}`
      panels[name] = { edges: band(hems.map(([p, e]) => lengthOf(edgeOf(panels[p].edges, e))), style.cuff.stretch, style.cuff.height, "down"), place: { at: "band", toward: "down", side }, fabric: "rib" }
      hems.forEach(([p, e], i) => seams.push([p, e, name, `sewn_${i}`]))
      seams.push([name, "end_a", name, "end_b"])
    }
  }
  return { panels, seams, style: styleName, kind: "bottoms", closure: null, fabric: style.fabric, measures: m }
}

// The finished measurements to cut to: the chart's, and from the body what it doesn't give.
export function bottomMeasures(styleName, size, body, cut = null) {
  const style = BOTTOM_STYLES[styleName] ?? BOTTOM_STYLES.trousers
  const hips = body.hips ?? body.waist + 14
  const waist = size.waist ?? body.waist + 2
  const seat = Math.max(size.seat ?? hips + 8, waist + 4)
  const thigh = Math.max(size.thigh ?? seat * 0.6, seat * 0.5)
  const opening = Math.max(size.leg_opening ?? thigh * 0.65, 18)
  const knee = size.knee ?? Math.max(opening, thigh * 0.55 + opening * 0.45)
  // Where the pants sit: at the height where the body is as round as their waist (a low-rise jean sits on
  // the hips, a trouser at the waist), between the crotch and the natural waist.
  const naturalRise = body.rise ?? body.height * 0.135
  let sitAt = waist <= body.waist ? 1 : waist >= hips ? 0.35 : 1 - 0.65 * (waist - body.waist) / (hips - body.waist)
  // An elastic waist (joggers) is cut smaller than the body and stretches on: it sits below the navel, not
  // wherever the body is as small as its relaxed size.
  if ((style.band.stretch < 0.9 || cut?.elastic) && styleName !== "leggings") sitAt = Math.min(sitAt, 0.75)
  // The waistband's middle sits on that line (the pattern's top, y = 0, is the band's seam, below it). A
  // chart's front rise runs along the curve of the seam; up the body it's about nine tenths of that.
  const rise = Math.max(14, size.rise ? size.rise * 0.9 : naturalRise * sitAt - style.band.height / 2)
  const inseam = size.inseam ?? (styleName === "shorts" ? 18 : body.inseam ?? body.height * 0.45)
  return {
    waist, seat, thigh, knee, opening, rise, inseam,
    // The seat's fullest point, below the top; the knee, down the inseam.
    seatAt: Math.min(rise * 0.62, 18), kneeAt: Math.min(inseam, (body.inseam ?? inseam) * 0.47),
    band: style.band.height, cuff: style.cuff?.height ?? 0,
    // The leg pieces stop where a cuff starts: a chart's inseam runs to the bottom of the cuff.
    length: rise + inseam - (style.cuff?.height ?? 0)
  }
}

// A skirt: a front and a back, each half its round, joined at the sides, with a waistband. It sits where the
// body is as round as its waist (as pants do) and hangs to its length from there. cut: { fit, stretch }
// (see GarmentImport::DressCut). The pieces are placed like pants' (place.js), round the hips and down
// round both legs together.
function draftSkirt(size, body, cut) {
  const style = BOTTOM_STYLES.skirt
  const hipsBody = body.hips ?? body.waist + 14
  const waist = size.waist ?? body.waist + 2
  const hips = Math.max(size.seat ?? (cut?.stretch ? hipsBody * 0.97 : hipsBody + 6), waist + 4)
  const length = size.length ?? size.inseam ?? 55
  const hem = hips * (SKIRT_HEM[cut?.fit] ?? SKIRT_HEM.slim)
  const naturalRise = body.rise ?? body.height * 0.135
  const sitAt = waist <= body.waist ? 1 : waist >= hipsBody ? 0.35 : 1 - 0.65 * (waist - body.waist) / (hipsBody - body.waist)
  const top = naturalRise * sitAt - style.band.height / 2   // from the crotch up to the waistband's seam
  const m = { waist, seat: hips, hips, hem, length, rise: top, seatAt: Math.min(top * 0.62, 18), inseam: Math.max(0, length - top), band: style.band.height, cuff: 0, skirt: true }
  const piece = () => {
    const hw = waist / 4, hh = hips / 4, he = hem / 4
    // Below the seat a flared skirt is a slice of a cone, so its hem is an arc round where the side seams
    // meet: cut straight, its sides would be longer than its middle and hang down in points.
    const k = (he - hh) / (length - m.seatAt)
    if (k < 0.02) {
      const sidePlus = [[he, -length], [hh, -m.seatAt], [hw, 0]]
      return [
        { name: "hem", points: line([-he, -length], [he, -length]) },
        { name: "side_plus", points: smooth(sidePlus, 30) },
        { name: "waist", points: line([hw, 0], [-hw, 0]) },
        { name: "side_minus", points: reversed(mirrored(smooth(sidePlus, 30))) }
      ]
    }
    const apex = -m.seatAt + hh / k, radius = apex + length, alpha = Math.atan(k)
    const arc = Array.from({ length: 25 }, (_, i) => { const phi = -alpha + (2 * alpha * i) / 24; return [radius * Math.sin(phi), apex - radius * Math.cos(phi)] })
    const sidePlus = [arc[arc.length - 1], [hh, -m.seatAt], [hw, 0]]
    return [
      { name: "hem", points: arc },
      { name: "side_plus", points: smooth(sidePlus, 30) },
      { name: "waist", points: line([hw, 0], [-hw, 0]) },
      { name: "side_minus", points: reversed(mirrored(smooth(sidePlus, 30))) }
    ]
  }
  // +x is the wearer's left on the front and their right on the back: the front's plus side meets the back's
  // minus side on the wearer's left.
  const rename = (edges, plus, minus) => edges.map(e => ({ ...e, name: e.name === "side_plus" ? `side_${plus}` : e.name === "side_minus" ? `side_${minus}` : e.name }))
  const panels = {
    front: { edges: rename(piece(), "L", "R"), place: { at: "skirt", part: "front" }, fabric: "main" },
    back: { edges: rename(piece(), "R", "L"), place: { at: "skirt", part: "back" }, fabric: "main" }
  }
  const seams = [["front", "side_L", "back", "side_L"], ["front", "side_R", "back", "side_R"]]
  const waists = [["back", "waist"], ["front", "waist"]]
  panels.waistband = { edges: band(waists.map(([p, e]) => lengthOf(edgeOf(panels[p].edges, e))), style.band.stretch, style.band.height, "up"), place: { at: "band", toward: "up" }, fabric: "main" }
  waists.forEach(([p, e], i) => seams.push([p, e, "waistband", `sewn_${i}`]))
  seams.push(["waistband", "end_a", "waistband", "end_b"])
  return { panels, seams, style: "skirt", kind: "bottoms", closure: null, fabric: cut?.fabric === "silk" ? "silk" : cut?.stretch ? "stretch" : style.fabric, measures: m }
}

// One leg piece, front or back, as the left front (or right back) is made: its edges anticlockwise seen from
// outside, the hem, the side seam up to the waist, the waist across to the middle, the rise seam down round
// the crotch, and the inseam back down to the hem.
// How much higher (cm) a full-length leg's hem is cut at the middle of the back than at its seams: a tailor
// slants a trouser's hem so the back clears the heel instead of folding up on it.
const HEM_SLANT = 1.5

function legPiece(m, part, { slant = 0 } = {}) {
  const share = part === "front" ? FRONT : 1 - FRONT
  const waist = (m.waistCut ?? m.waist) * share / 2, seat = m.seat * share / 2
  // The crotch extensions, as a pattern maker drafts them: a sixteenth of the seat at the front, an eighth
  // at the back (the seam runs under the body and up over the seat, so the back's is far longer). The
  // inseam then slants in from the crotch point to the thigh.
  const extension = part === "front" ? m.seat / 16 : m.seat / 8
  const centre = (seat - extension) / 2   // the leg's straight grain, down its middle
  const half = round => (round * share) / 2
  const hemY = -m.length, kneeY = -(m.rise + m.kneeAt), crotchY = -m.rise, seatY = -m.seatAt
  // The back rises higher at the middle, over the seat.
  const backRaise = part === "back" ? BACK_RAISE : 0
  const thighY = crotchY - Math.min(8, m.inseam * 0.3)
  const outer = [
    [centre + half(m.opening), hemY],
    [centre + half(m.knee), kneeY],
    [centre + half(m.thigh), thighY],
    [seat, seatY],
    [waist, 0]
  ]
  const inner = [
    [-extension, crotchY],
    [Math.min(centre - half(m.thigh), -extension * 0.4), thighY],
    [centre - half(m.knee), kneeY],
    [centre - half(m.opening), hemY]
  ]
  // The rise seam: straight down the middle, then curving out to the crotch point (deeper at the back).
  const crotch = bezier([0, backRaise], [0, seatY * 0.9], [-extension * (part === "back" ? 0.55 : 0.35), crotchY + 0.5], [-extension, crotchY], 18)
  return [
    { name: "hem", points: part === "back" && slant ? bezier([centre - half(m.opening), hemY], [centre - half(m.opening) / 3, hemY + slant * 1.3], [centre + half(m.opening) / 3, hemY + slant * 1.3], [centre + half(m.opening), hemY], 12)
      : line([centre - half(m.opening), hemY], [centre + half(m.opening), hemY]) },
    { name: "side", points: smooth(outer, 40) },
    { name: "waist", points: line([waist, 0], [0, backRaise]) },
    { name: "crotch", points: crotch },
    { name: "inseam", points: smooth(inner, 40) }
  ]
}

// A piece's mirror image, turned back to run anticlockwise: its edges in reverse order, each reversed.
function mirrorPiece(edges) {
  return edges.slice().reverse().map(e => ({ name: e.name, points: reversed(mirrored(e.points)) }))
}

// A smooth line through the points (Catmull-Rom), `count` points along it.
function smooth(points, count) {
  const out = []
  const segments = points.length - 1
  for (let i = 0; i <= count; i++) {
    const t = (i / count) * segments
    const k = Math.min(Math.floor(t), segments - 1), u = t - k
    const p0 = points[Math.max(k - 1, 0)], p1 = points[k], p2 = points[k + 1], p3 = points[Math.min(k + 2, segments)]
    out.push([0, 1].map(c => 0.5 * ((2 * p1[c]) + (-p0[c] + p2[c]) * u + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * u * u + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * u * u * u)))
  }
  return out
}

function edgeOf(edges, name) {
  const found = edges.find(e => e.name === name)
  if (!found) throw new Error(`no edge ${name}`)
  return found.points
}

function lengthOf(points) {
  let total = 0
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
  return total
}

// A band (see pattern.js): "up" stands up from its sewn edge (a waistband), "down" hangs from it (a cuff).
function band(lengths, stretch, height, direction) {
  const cuts = [0]
  for (const l of lengths) cuts.push(cuts[cuts.length - 1] + l * stretch)
  const width = cuts[cuts.length - 1]
  if (direction === "up") {
    return [
      ...lengths.map((_, i) => ({ name: `sewn_${i}`, points: line([cuts[i], 0], [cuts[i + 1], 0]) })),
      { name: "end_b", points: line([width, 0], [width, height]) },
      { name: "rim", points: line([width, height], [0, height]) },
      { name: "end_a", points: line([0, height], [0, 0]) }
    ]
  }
  return [
    { name: "rim", points: line([0, -height], [width, -height]) },
    { name: "end_b", points: line([width, -height], [width, 0]) },
    ...lengths.map((_, i) => ({ name: `sewn_${i}`, points: line([width - cuts[i], 0], [width - cuts[i + 1], 0]) })),
    { name: "end_a", points: line([0, 0], [0, -height]) }
  ]
}
