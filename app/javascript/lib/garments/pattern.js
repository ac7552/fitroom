// Sewing patterns for tops: T-shirts, long sleeves, sweatshirts, hoodies and casual jackets, drafted from one
// size's chart measurements the way a pattern maker drafts a block. Pure functions; everything is in cm.
//
// A pattern is { panels, seams, measures }:
//   panels  { name: { edges: [{ name, points }], place, fabric } }. Each panel is a flat piece of cloth seen
//           from its outside, its outline running anticlockwise edge by edge (an edge ends where the next
//           one begins).
//   seams   [[panel, edge, panel, edge]]: two edges sewn together. Every panel runs anticlockwise seen from
//           outside, so two sewn edges always run opposite ways: point i of one meets point n-1-i of the other.
// `place` says where a panel starts before it's sewn (see drape.js): round the torso (front or back), round an
// arm (L or R), or along the edges it's sewn to (bands, cuffs and collars).
//
// Pattern axes: x across, y up. On the body panels the high point of the shoulder (where the shoulder seam meets
// the neckline) is at y = 0, and +x is the wearer's left on the front and their right on the back.
import { bezier, length, line, mirrored, reversed } from "lib/garments/curves"

// What each style is made of. ease: room at the chest (cm) when the chart doesn't say; length: back length as
// a share of height when it doesn't; sleeve: "short" or "long"; collar, cuffs, hem: the bands sewn on.
export const STYLES = {
  tee: { sleeve: "short", collar: "band", cuffs: null, hem: null, fabric: "jersey", ease: 10, length: 0.41 },
  longsleeve: { sleeve: "long", collar: "band", cuffs: "rib", hem: null, fabric: "jersey", ease: 10, length: 0.41 },
  sweatshirt: { sleeve: "long", collar: "band", cuffs: "rib", hem: "rib", fabric: "fleece", ease: 14, length: 0.4 },
  hoodie: { sleeve: "long", collar: "hood", cuffs: "rib", hem: "rib", fabric: "fleece", ease: 16, length: 0.41 },
  zip: { sleeve: "long", collar: "stand", cuffs: "band", hem: "band", fabric: "shell", ease: 14, length: 0.4, closure: "zip" },
  bomber: { sleeve: "long", collar: "rib", cuffs: "rib", hem: "rib", fabric: "shell", ease: 18, length: 0.38, closure: "zip" },
  shirt: { sleeve: "long", collar: "shirtstand", cuffs: "band", hem: "band", fabric: "twill", ease: 14, length: 0.38, closure: "buttons" },
  // A short-sleeve button-up (a camp or resort shirt): roomy, its hem cut straight and left out.
  shortshirt: { sleeve: "short", collar: "shirtstand", cuffs: null, hem: null, fabric: "twill", ease: 18, length: 0.4, closure: "buttons" },
  coat: { sleeve: "long", collar: "stand", cuffs: null, hem: null, fabric: "wool", ease: 20, length: 0.55, closure: "buttons" },
  // A polo: a knit collar, a short buttoned placket, banded sleeves.
  polo: { sleeve: "short", collar: "polo", cuffs: null, hem: null, fabric: "jersey", ease: 10, length: 0.41, closure: "placket" },
  // A tank top: no sleeves, deep armholes, its straps in from the shoulders.
  tank: { sleeve: null, collar: "band", cuffs: null, hem: null, fabric: "jersey", ease: 6, length: 0.41 },
  // Knitwear: a sweater (ribbed neck, cuffs and hem) and a cardigan (the same, buttoned down a V front).
  sweater: { sleeve: "long", collar: "rib", cuffs: "rib", hem: "rib", fabric: "fleece", surface: "rib", ease: 12, length: 0.4 },
  // A short-sleeve knit (a knit tee or a mock neck): ribbed at the neck and hem, short sleeves.
  shortknit: { sleeve: "short", collar: "rib", cuffs: null, hem: "rib", fabric: "fleece", surface: "rib", ease: 12, length: 0.4 },
  cardigan: { sleeve: "long", collar: "band", cuffs: "rib", hem: "rib", fabric: "fleece", surface: "rib", ease: 12, length: 0.4, closure: "buttons", neck: 20 },
  // Short sleeves, a round neck, close at the waist and flaring out to about the knee.
  dress: { sleeve: "short", collar: "band", cuffs: null, hem: null, fabric: "jersey", ease: 8, length: 0.53, shaped: true }
}

// Finished heights of the bands (cm), and how much shorter than the edge they're sewn to each is cut (rib is
// stretched on, so the edge gathers into it).
const BANDS = {
  band: { height: 2, stretch: 0.88, fabric: "rib" },
  rib: { height: 5.5, stretch: 0.86, fabric: "rib" },
  stand: { height: 6, stretch: 1, fabric: "main" },
  // A shirt's collar stand: low, the collar itself folded down over it (drawn over the drape, see stage.js).
  shirtstand: { height: 3.2, stretch: 1, fabric: "main" },
  // A polo's knit collar, folded down over the shoulders: its outer edge is cut longer than its sewn edge
  // (by `fall`), so it lies flat round the neck instead of standing up.
  polo: { height: 6.5, stretch: 1, fabric: "rib", fall: 1.3 }
}
const CUFFS = { rib: { height: 7, stretch: 0.74, fabric: "rib" }, band: { height: 5, stretch: 0.92, fabric: "main" } }
const HEMS = { rib: { height: 6.5, stretch: 0.86, fabric: "rib" }, band: { height: 4.5, stretch: 0.98, fabric: "main" } }

// size: a chart's garment measurements (chest, waist, shoulders, sleeve, length; any but the chest may be
// null). body: the wearer as modelled, in cm (chest, waist, shoulders, arm, height, and from the mesh: neck,
// armpit (how far the armpit is below the high point of the shoulder), bicep, wrist, head).
// cut: a dress's cut (see GarmentImport::DressCut), for styleName "dress"; a top's { fit: "fitted", stretch }
// (a shrunken or baby knit, made close to the body in a cloth that stretches: cut to its chart's numbers with
// no room added at the armholes and sleeves, and draped as a knit that gives).
export function draftTop(styleName, size, body, cut = null) {
  if (styleName === "dress" && cut && !["short", "long"].includes(cut.sleeves)) return draftDress(size, body, cut)
  if (styleName === "tank") return draftTank(size, body)
  const style = dressStyle(STYLES[styleName] ?? STYLES.tee, cut)
  const m = measures(style, size, body, cut)
  if (style.neck) m.frontNeck = style.neck
  if (style.shaped) {
    shapeSkirt(m, size, body, cut)
    if (cut?.neckline) m.frontNeck = NECK_DEPTH[cut.neckline] ?? m.frontNeck
  }
  const panels = {}
  const seams = []

  const front = bodice(m, "front")
  const back = bodice(m, "back")
  panels.front = { edges: front, place: { at: "torso", side: "front" }, fabric: "main" }
  panels.back = { edges: back, place: { at: "torso", side: "back" }, fabric: "main" }

  for (const side of ["L", "R"]) {
    seams.push(["front", `side_${side}`, "back", `side_${side}`])
    seams.push(["front", `shoulder_${side}`, "back", `shoulder_${side}`])
    const name = `sleeve_${side}`
    panels[name] = { edges: sleeve(m, side, edge(front, `armhole_${side}`), edge(back, `armhole_${side}`)), place: { at: "arm", side }, fabric: "main" }
    seams.push(["front", `armhole_${side}`, name, "cap_front"])
    seams.push(["back", `armhole_${side}`, name, "cap_back"])
    seams.push([name, "seam_front", name, "seam_back"])
    if (style.cuffs) {
      const cuff = CUFFS[style.cuffs]
      panels[`cuff_${side}`] = { edges: band([length(edge(panels[name].edges, "hem"))], cuff.stretch, cuff.height, "down"), place: { at: "band", toward: "hand", side }, fabric: cuff.fabric }
      seams.push([name, "hem", `cuff_${side}`, "sewn_0"])
      seams.push([`cuff_${side}`, "end_a", `cuff_${side}`, "end_b"])
    }
  }

  // Round the neck: a band, a stand collar or a hood. A band's sewn edge runs round from the centre back: the
  // back's right half, the front's right half, the front's left half, then the back's left half.
  const necklines = [["back", "neck_R"], ["front", "neck_R"], ["front", "neck_L"], ["back", "neck_L"]]
  const neckLengths = necklines.map(([p, e]) => length(edge(panels[p].edges, e)))
  if (style.collar === "hood") {
    // Each half sewn to its side of the neckline, from the centre front to the centre back. Worn down (lying
    // on the back and shoulders), as a shop photo shows a hoodie, unless the style says up.
    for (const side of ["L", "R"]) {
      const frontHalf = length(edge(front, `neck_${side}`)), backHalf = length(edge(back, `neck_${side}`))
      panels[`hood_${side}`] = { edges: hoodHalf(m, side, frontHalf, backHalf), place: { at: "head", side, down: style.hoodUp !== true }, fabric: "main" }
    }
    seams.push(["front", "neck_L", "hood_L", "sewn_0"], ["back", "neck_L", "hood_L", "sewn_1"])
    seams.push(["back", "neck_R", "hood_R", "sewn_0"], ["front", "neck_R", "hood_R", "sewn_1"])
    seams.push(["hood_L", "crown", "hood_R", "crown"])
  } else if (style.collar !== null) {
    const collar = BANDS[style.collar] ?? BANDS.band
    panels.collar = collar.fall
      ? { edges: fallingCollar(neckLengths, collar.height, collar.fall), place: { at: "band", toward: "fall", spread: collar.fall }, fabric: collar.fabric }
      : { edges: band(neckLengths, collar.stretch, collar.height, "up"), place: { at: "band", toward: "up" }, fabric: collar.fabric }
    necklines.forEach(([p, e], i) => seams.push([p, e, "collar", `sewn_${i}`]))
    seams.push(["collar", "end_a", "collar", "end_b"])
  }

  if (style.hem) {
    const hem = HEMS[style.hem]
    const hems = [["back", "hem"], ["front", "hem"]]
    panels.waistband = { edges: band(hems.map(([p, e]) => length(edge(panels[p].edges, e))), hem.stretch, hem.height, "down"), place: { at: "band", toward: "down" }, fabric: hem.fabric }
    hems.forEach(([p, e], i) => seams.push([p, e, "waistband", `sewn_${i}`]))
    seams.push(["waistband", "end_a", "waistband", "end_b"])
  }

  // (A hoodie that zips down the front says so in its cut.)
  const fabric = !style.shaped && cut?.stretch ? "rib" : style.fabric
  return { panels, seams, style: styleName, closure: cut?.closure ?? style.closure ?? null, fabric, measures: m }
}

// The finished measurements to cut to: the chart's, and what it doesn't give from the body and the style.
// cut: { fit: "fitted" } cuts the armholes, sleeves and hem close (a fitted knit), with the chart's chest.
export function measures(style, size, body, cut = null) {
  // A dress's sleeves are as long as its chart says (a long-sleeved dress has them to the wrist).
  if (style.shaped && size.sleeve > 40) style = { ...style, sleeve: "long" }
  const fitted = cut?.fit === "fitted" && !style.shaped
  const chest = size.chest ?? body.chest + (fitted ? Math.min(style.ease, 2) : style.ease)
  const cuff = style.cuffs ? CUFFS[style.cuffs] : null
  const hemBand = style.hem ? HEMS[style.hem] : null
  const shoulders = size.shoulders ?? Math.min(body.shoulders + (style.sleeve === "short" ? 2 : 3), chest / 2.15)
  const length = (size.length ?? body.height * style.length) - (hemBand ? hemBand.height - 0.5 : 0)
  let sleeve = size.sleeve ?? (style.sleeve === "short" ? 19 + (chest - 100) / 8 : body.arm + 1.5)
  if (cuff) sleeve -= cuff.height - 0.5   // a chart's sleeve runs to the end of the cuff
  const roomy = Math.max(0, chest - body.chest)
  // Round the arm as it really is (body.js): a sleeve is never cut smaller than the arm it goes on. A fitted
  // knit gets 6% over it (it stretches, but stretched past its mesh it tears and shows skin); a loose sleeve
  // 10%. Checked at the underarm, where the sleeve is its bicep wide, and at the elbow, where a slim sleeve's
  // taper towards the wrist passes the forearm (see sleeve: it narrows in a straight line from the underarm
  // to the hem).
  const over = fitted ? 1.06 : 1.1
  const upperArm = (body.upperArm ?? body.bicep ?? 32) * over
  const bicep = fitted ? Math.max((body.bicep ?? 32) + 4, chest * 0.3, upperArm) : Math.max((body.bicep ?? 32) + (style.sleeve === "short" ? 7 : 9), chest * 0.34, upperArm)
  let opening = style.sleeve === "short" ? null : fitted ? Math.max((body.wrist ?? 18) + (cuff ? 5 : 8), chest * 0.19) : Math.max((body.wrist ?? 18) + (cuff ? 9 : 12), chest * 0.21)
  if (opening !== null && body.forearm && body.elbow) {
    const underarm = (body.armpit ?? 19) - 4.4 + 1.5   // the cap's height: about the armhole's depth below the shoulder point
    const elbow = body.elbow + 1.5                        // the elbow, below the shoulder point
    const share = Math.min(Math.max((elbow - underarm) / Math.max(sleeve - underarm, 1), 0.05), 1)
    const needed = (body.forearm * over - bicep * (1 - share)) / share
    opening = Math.max(opening, Math.min(needed, bicep))
  }
  // A shaped dress: in at the waist (about at the navel), out over the hips, and wider still at its hem.
  const shaped = style.shaped ? {
    waist: Math.max(size.waist ?? body.waist + 8, body.waist + 4),
    waistAt: body.height * 0.235,
    hips: Math.max(size.hips ?? (body.hips ?? body.chest) + 8, (body.hips ?? body.waist) + 5),
    hipAt: body.height * 0.335
  } : null
  return {
    chest,
    shaped,
    shoulders,
    length,
    sleeve,
    hem: shaped ? Math.max(chest, shaped.hips) * 1.22 : Math.min(size.waist ?? chest, chest) * (hemBand ? 1 : 0.99),
    neckWidth: (body.neck ?? 40) / (2 * Math.PI) + (style.collar === "hood" ? 2.2 : 1.5),
    frontNeck: { stand: 6, shirtstand: 7, rib: 6, hood: 8 }[style.collar] ?? 9,
    backNeck: 2,
    shoulderDrop: 4.4,
    armhole: (body.armpit ?? 19) + (fitted ? 0.5 : 2) + roomy / 8,
    bicep,
    opening,
    head: body.head ?? 58
  }
}

// One body panel, front or back, its edges anticlockwise seen from outside.
function bodice(m, side) {
  const cw = m.chest / 4, hw = m.hem / 4, sw = m.shoulders / 2, nw = m.neckWidth
  const neckDepth = side === "front" ? m.frontNeck : m.backNeck
  const underarm = [cw, -m.armhole]
  const shoulder = [sw, -m.shoulderDrop]
  const hps = [nw, 0]
  // The armhole curves in from the underarm to the narrowest point across the chest (the back is a little
  // wider) and back out to the shoulder point.
  const across = side === "front" ? sw - 1.6 : sw - 0.9
  const armhole = bezier(underarm, [across + (cw - across) * 0.1, -m.armhole + 0.3], [across, -m.armhole * 0.42], shoulder, 28)
  const shoulderLine = line(shoulder, hps)
  // The neckline, a quarter ellipse each side from the high point down to the centre (squarer when
  // m.neckSquare is above 2: a straight or square neckline).
  const quarter = []
  const power = 2 / (m.neckSquare ?? 2)
  for (let i = 0; i <= 14; i++) {
    const t = (i / 14) * (Math.PI / 2)
    quarter.push([nw * Math.cos(t) ** power, -neckDepth * Math.sin(t) ** power])
  }
  const neckPlus = quarter, neckMinus = reversed(mirrored(quarter))   // +x high point to centre, centre to -x high point
  // A shaped side runs from the hem in over the hips to the waist, then out to the underarm.
  const sidePlus = m.shaped
    ? [[hw, -m.length], [m.shaped.hips / 4, -m.shaped.hipAt], [m.shaped.waist / 4 + 0.3, -m.shaped.waistAt], underarm]
    : line([hw, -m.length], underarm)
  // +x is the wearer's left on the front and their right on the back.
  const plus = side === "front" ? "L" : "R", minus = side === "front" ? "R" : "L"
  const neck = [{ name: `neck_${plus}`, points: neckPlus }, { name: `neck_${minus}`, points: neckMinus }]
  return [
    { name: "hem", points: line([-hw, -m.length], [hw, -m.length]) },
    { name: `side_${plus}`, points: sidePlus },
    { name: `armhole_${plus}`, points: armhole },
    { name: `shoulder_${plus}`, points: shoulderLine },
    ...neck,
    { name: `shoulder_${minus}`, points: reversed(mirrored(shoulderLine)) },
    { name: `armhole_${minus}`, points: reversed(mirrored(armhole)) },
    { name: `side_${minus}`, points: reversed(mirrored(sidePlus)) }
  ]
}

// A sleeve seen from outside the arm, cap at the top. On the left arm the front of the body is on the
// viewer's left (-x); on the right arm, their right (+x). Each half of the cap is as long as the armhole it's
// sewn into, plus a little ease.
function sleeve(m, side, frontArmhole, backArmhole) {
  const half = m.bicep / 2
  const height = capHeight(half, (length(frontArmhole) + length(backArmhole)) / 2 + 0.4)
  const capHalf = []   // from the top of the cap down to the underarm, on the +x side
  for (let i = 0; i <= 24; i++) {
    const x = (i / 24) * half
    capHalf.push([x, -height * (1 - Math.cos((Math.PI * x) / half)) / 2])
  }
  const hemHalf = (m.opening ?? m.bicep - 3) / 2
  const seamPlus = line([hemHalf, -m.sleeve], [half, -height])
  const plusIsFront = side === "R"
  const [plus, minus] = plusIsFront ? ["front", "back"] : ["back", "front"]
  return [
    { name: "hem", points: line([-hemHalf, -m.sleeve], [hemHalf, -m.sleeve]) },
    { name: `seam_${plus}`, points: seamPlus },
    { name: `cap_${plus}`, points: reversed(capHalf) },
    { name: `cap_${minus}`, points: mirrored(capHalf) },
    { name: `seam_${minus}`, points: reversed(mirrored(seamPlus)) }
  ]
}

// The cap height that makes half the cap's curve (top to underarm) as long as `armhole`.
function capHeight(half, armhole) {
  let low = 1, high = 30
  for (let i = 0; i < 40; i++) {
    const h = (low + high) / 2
    const pts = []
    for (let k = 0; k <= 40; k++) {
      const x = (k / 40) * half
      pts.push([x, -h * (1 - Math.cos((Math.PI * x) / half)) / 2])
    }
    if (length(pts) > armhole) high = h
    else low = h
  }
  return (low + high) / 2
}

// A band sewn along one or more edges in turn (a neckline's three parts, a hem's two, a sleeve's hem): a strip
// `stretch` times as long as them, `height` tall, its ends sewn together. "up" bands (collars) stand up from
// their sewn edge, "down" ones (cuffs, waistbands) hang from it. The sewn edge is split into parts sewn_0,
// sewn_1, ... in proportion to the edges, running the opposite way to them.
function band(lengths, stretch, height, direction) {
  const cuts = [0]
  for (const l of lengths) cuts.push(cuts[cuts.length - 1] + l * stretch)
  const width = cuts[cuts.length - 1]
  if (direction === "up") {
    // Sewn by its lower edge (y = 0, running left to right); it stands up to y = height.
    return [
      ...lengths.map((_, i) => ({ name: `sewn_${i}`, points: line([cuts[i], 0], [cuts[i + 1], 0]) })),
      { name: "end_b", points: line([width, 0], [width, height]) },
      { name: "rim", points: line([width, height], [0, height]) },
      { name: "end_a", points: line([0, height], [0, 0]) }
    ]
  }
  // Sewn by its upper edge (y = 0, running right to left); it hangs down to y = -height.
  return [
    { name: "rim", points: line([0, -height], [width, -height]) },
    { name: "end_b", points: line([width, -height], [width, 0]) },
    ...lengths.map((_, i) => ({ name: `sewn_${i}`, points: line([width - cuts[i], 0], [width - cuts[i + 1], 0]) })),
    { name: "end_a", points: line([0, 0], [0, -height]) }
  ]
}

// A collar that lies down round the neck: sewn by its upper edge (as a "down" band), its outer edge `fall`
// times as long, so the strip is a slice of a ring and lies flat over the shoulders.
function fallingCollar(lengths, height, fall) {
  const cuts = [0]
  for (const l of lengths) cuts.push(cuts[cuts.length - 1] + l)
  const width = cuts[cuts.length - 1], extra = (width * (fall - 1)) / 2
  return [
    { name: "rim", points: line([-extra, -height], [width + extra, -height]) },
    { name: "end_b", points: line([width + extra, -height], [width, 0]) },
    ...lengths.map((_, i) => ({ name: `sewn_${i}`, points: line([width - cuts[i], 0], [width - cuts[i + 1], 0]) })),
    { name: "end_a", points: line([0, 0], [-extra, -height]) }
  ]
}

// A two-piece hood. Each half, seen from outside, has its neck edge along the bottom (sewn to that side's
// neckline, from the centre front to the centre back), the crown seam up the back of the head and over the
// top to the forehead (sewn to the other half), and the face opening coming back down to the centre front.
// On the left half the face is on the viewer's left; the right half is its mirror image.
function hoodHalf(m, side, frontHalf, backHalf) {
  const w = frontHalf + backHalf
  const tall = m.head * 0.6, deep = m.head * 0.41
  const crown = [
    ...bezier([w, 0], [w + 5.5, tall * 0.34], [w + 3.5, tall * 0.84], [w - 5, tall], 18),
    ...bezier([w - 5, tall], [w - 9, tall * 1.06], [w - deep + 4, tall * 1.04], [w - deep, tall * 0.96], 12).slice(1)
  ]
  const brow = crown[crown.length - 1]
  const face = bezier(brow, [brow[0] - 3.5, tall * 0.6], [0.5, tall * 0.2], [0, 0], 18)
  const edges = [
    { name: "sewn_0", points: line([0, 0], [frontHalf, 0]) },
    { name: "sewn_1", points: line([frontHalf, 0], [w, 0]) },
    { name: "crown", points: crown },
    { name: "face", points: face }
  ]
  if (side === "L") return edges
  // The mirror image runs clockwise, so turn it back round: its edges in reverse order, each reversed. Its
  // neck edge then runs centre back to centre front, and its parts swap.
  return edges.slice().reverse().map(e => ({ name: e.name, points: reversed(mirrored(e.points)) }))
    .map(e => ({ ...e, name: e.name === "sewn_0" ? "sewn_1" : e.name === "sewn_1" ? "sewn_0" : e.name }))
}

export function edge(edges, name) {
  const found = edges.find(e => e.name === name)
  if (!found) throw new Error(`no edge ${name}`)
  return found.points
}

// A panel's outline as one closed list of points, each corner once.
export function outline(panel) {
  return panel.edges.flatMap(e => e.points.slice(0, -1))
}

// Dresses

// The cloth a dress is drafted in (for its drape): its cut's.
const DRESS_CLOTH = { stretch: "stretch", leather: "leather", silk: "silk", jersey: "jersey", cotton: "twill" }

// The dress style with the cut's cloth, sleeves and neckline (for dresses with sleeves, drafted as a top).
function dressStyle(style, cut) {
  if (!style.shaped || !cut) return style
  return { ...style, fabric: DRESS_CLOTH[cut.fabric] ?? style.fabric, sleeve: cut.sleeves === "long" ? "long" : "short",
           collar: ["round", "high"].includes(cut.neckline) ? "band" : null }
}

// Where the skirt goes in to the waist and out over the hips, and how wide its hem is, by its fit: fitted
// (a pencil skirt), slim, relaxed or flared.
const HEM_FLARE = { fitted: 0.98, slim: 1.05, relaxed: 1.15, flared: 1.5 }
function shapeSkirt(m, size, body, cut) {
  const fit = cut?.fit ?? "slim"
  const roomy = fit === "relaxed" || fit === "flared"
  m.shaped = {
    waist: size.waist ?? (roomy ? body.waist + 14 : body.waist + 4),
    waistAt: body.height * 0.235,
    hips: size.hips ?? (cut?.stretch ? (body.hips ?? body.chest) * 0.97 : (body.hips ?? body.chest) + 6),
    hipAt: body.height * 0.335
  }
  m.hem = Math.max(m.shaped.hips, m.chest * 0.9) * (HEM_FLARE[fit] ?? 1.05)
  // A shaped side can't come in to a waist wider than the chest.
  m.shaped.waist = Math.min(m.shaped.waist, m.chest)
}

// A tank top: a front and a back joined at the sides and over the shoulders on wide straps, its armholes
// cut deep and its neck scooped, both faced (no bands).
function draftTank(size, body) {
  const style = STYLES.tank
  const m = measures({ ...style, sleeve: "short" }, size, body)
  const shoulderBone = body.shoulders / 2
  m.shoulders = 2 * (shoulderBone - 4)
  m.neckWidth = Math.max(m.neckWidth + 1.5, shoulderBone - 4 - 6)
  m.shoulderDrop = 2
  m.armhole += 5
  m.frontNeck = 13
  m.backNeck = 4
  const panels = {
    front: { edges: bodice(m, "front"), place: { at: "torso", side: "front" }, fabric: "main" },
    back: { edges: bodice(m, "back"), place: { at: "torso", side: "back" }, fabric: "main" }
  }
  const seams = []
  for (const s of ["L", "R"]) {
    seams.push(["front", `side_${s}`, "back", `side_${s}`])
    seams.push(["front", `shoulder_${s}`, "back", `shoulder_${s}`])
  }
  return { panels, seams, style: "tank", closure: null, fabric: style.fabric, measures: m }
}

// How each sleeveless cut sits on the shoulder: how far in from the shoulder bone its strap's outside edge is,
// the strap's width (cm), and the neck's depth at the back. A strap is drawn at least two of the cloth's point
// spacings wide (dress.js), or it would have nothing to hold it together: thin straps show about 3.5 cm.
const STRAPS = {
  none: { inset: 1.5, width: null, back: 3 },
  straps: { inset: 5.5, width: 5, back: 12 },
  thin_straps: { inset: 6.5, width: 3.6, back: 16 }
}
const NECK_DEPTH = { round: 9, high: 3, straight: 11, scoop: 15, plunge: 24 }

// A dress with no sleeves: sleeveless, on straps, strapless, or over one shoulder. Its armholes, neckline and
// top edge are finished edges (no bands); only its side and shoulder (strap) seams are sewn.
function draftDress(size, body, cut) {
  const style = { ...STYLES.dress, fabric: DRESS_CLOTH[cut.fabric] ?? "jersey" }
  const m = measures({ ...style, sleeve: "short" }, size, body)
  shapeSkirt(m, size, body, cut)
  const neckline = cut.neckline ?? "round"
  m.neckSquare = neckline === "straight" ? 6 : 2
  const panels = {}, seams = []
  const shoulderBone = body.shoulders / 2
  if (cut.sleeves === "strapless") {
    // Straight across just above the bust, at the front of the armpits; its length runs from that top edge.
    m.top = Math.max(11, (body.armpit ?? 19) - 5)
    for (const side of ["front", "back"]) panels[side] = { edges: topless(m, side, null), place: { at: "torso", side }, fabric: "main" }
    for (const s of ["L", "R"]) seams.push(["front", `side_${s}`, "back", `side_${s}`])
  } else if (cut.sleeves === "one_shoulder") {
    // Over the left shoulder on a wide strap; the top edge runs across from it to the right armpit.
    m.top = Math.max(11, (body.armpit ?? 19) - 4)
    m.shoulders = 2 * (shoulderBone - 3)
    m.neckWidth = shoulderBone - 3 - 6
    for (const side of ["front", "back"]) panels[side] = { edges: topless(m, side, "L"), place: { at: "torso", side }, fabric: "main" }
    for (const s of ["L", "R"]) seams.push(["front", `side_${s}`, "back", `side_${s}`])
    seams.push(["front", "shoulder_L", "back", "shoulder_L"])
  } else {
    const strap = STRAPS[cut.sleeves] ?? STRAPS.none
    const outside = Math.min(size.shoulders ? size.shoulders / 2 : Infinity, shoulderBone - strap.inset)
    m.shoulders = 2 * outside
    if (strap.width) m.neckWidth = Math.max(outside - strap.width, m.neckWidth)
    m.shoulderDrop = strap.width ? 1.5 : 3
    m.armhole += strap.width ? 3 : 1.5
    m.frontNeck = NECK_DEPTH[neckline] ?? 9
    m.backNeck = strap.back
    panels.front = { edges: bodice(m, "front"), place: { at: "torso", side: "front" }, fabric: "main" }
    panels.back = { edges: bodice(m, "back"), place: { at: "torso", side: "back" }, fabric: "main" }
    for (const s of ["L", "R"]) {
      seams.push(["front", `side_${s}`, "back", `side_${s}`])
      seams.push(["front", `shoulder_${s}`, "back", `shoulder_${s}`])
    }
  }
  return { panels, seams, style: "dress", closure: null, fabric: style.fabric, measures: m }
}

// A body panel that starts below the shoulders: straight across at m.top below the shoulder's high point
// (strapless), or, with `strap` ("L"), rising to a strap over that shoulder and running down across to under
// the other arm. Its hem is m.length below its top edge (strapless) or below the shoulder (one shoulder).
function topless(m, side, strap) {
  const cw = m.chest / 4, hw = m.hem / 4
  const top = -(m.top + (side === "back" ? 1.5 : 0))
  const hem = strap ? -m.length : top - m.length
  const sideLine = halfSide => (m.shaped
    ? [[hw, hem], [m.shaped.hips / 4, -m.shaped.hipAt], [Math.min(m.shaped.waist / 4 + 0.3, cw), -m.shaped.waistAt], [cw, top]]
    : line([hw, hem], [cw, top])).map(([x, y]) => [x * halfSide, y])
  const plusSide = sideLine(1), minusSide = reversed(sideLine(-1))
  // +x is the wearer's left on the front and their right on the back.
  const plus = side === "front" ? "L" : "R", minus = side === "front" ? "R" : "L"
  const edges = [{ name: "hem", points: line([-hw, hem], [hw, hem]) }, { name: `side_${plus}`, points: plusSide }]
  if (!strap) {
    edges.push({ name: "top", points: line([cw, top], [-cw, top]) })
  } else {
    // The strap's side: +x on the front, -x on the back.
    const sign = (side === "front") === (strap === "L") ? 1 : -1
    const sw = m.shoulders / 2, nw = m.neckWidth
    const underarm = [cw * sign, top]
    const shoulder = [sw * sign, -1.5]
    const armhole = bezier(underarm, [(sw - 0.5) * sign, top * 0.6], [(sw - 0.3) * sign, top * 0.25], shoulder, 20)
    const strapTop = line(shoulder, [nw * sign, 0])
    // From the strap's inside edge, down and across to under the other arm.
    const across = bezier([nw * sign, 0], [(nw - 3) * sign, top * 0.5], [-cw * 0.5 * sign, top], [-cw * sign, top], 24)
    if (sign > 0) {
      edges.push({ name: `armhole_${plus}`, points: armhole }, { name: `shoulder_${plus}`, points: strapTop }, { name: "top", points: across })
    } else {
      // The strap is on the -x side: across first (from under the +x arm, reversed), then the strap.
      edges.push({ name: "top", points: reversed(across) }, { name: `shoulder_${minus}`, points: reversed(strapTop) }, { name: `armhole_${minus}`, points: reversed(armhole) })
    }
  }
  edges.push({ name: `side_${minus}`, points: minusSide })
  return edges
}
