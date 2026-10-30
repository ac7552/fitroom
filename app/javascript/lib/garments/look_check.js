// Checking the 3D view against the shop's photo before it's shown. The page photographs its own draped
// garment alone on a plain backdrop (stage.js's lookShot) and reads that picture exactly as it read the shop's
// photo (print.js's findPrint), so both come down to the same few numbers (print.js's lookOf): the cloth's
// colour, how much of the front is graphic, and where the graphic sits. A worn garment never matches a flat
// shop photo exactly, so each check allows what a good render differs by; what it catches is a misreading
// (a chest graphic laid as stripes all round, a graphic pushed up under the collar and blown up, the wrong
// colour). An AI likeness score (likeness.js, DINOv2 in the browser) is a fourth check when its model is there.
//
// Both pictures are read the plain way (PLAIN: no guessing at a hood, stripes or an all-over print, or sleeve
// graphics), whatever reading the 3D view was made from: a guess that went wrong in the 3D view (a T-shirt's
// shoulders taken for a hood, a chest graphic taken for stripes) then shows up as a difference, where a
// render held to the same guessed reading would agree with its own mistake.
//
// Pure functions here; the page runs them (fitting_room_controller.js's checkLook).
export const PLAIN = { hood: false, patterns: false, sleeves: false }

// How far apart a good render and its photo can be. Each is a starting point set from renders of the test
// outfits (script/headless/look_bars.mjs prints them), not a guess.
export const BARS = {
  // Colour difference, with lightness counted at half (the render's light isn't the studio's): ΔE.
  colour: 16,
  // The photo's colour against the one the listing names (the server's colour for "Black", "White"...).
  named: 35,
  // Where the graphic sits: its top edge, as a share of the front's length, and its middle, of its width.
  place: 0.08,
  // Its height over the garment's length, against the photo's: within 1/1.35 to 1.35 times (good renders of the
  // test tee read about 1.2, one with its graphic half as big again about 1.5).
  size: 1.35,
  // Its shape (width over height) against the photo's: a worn front curves round the body, so it reads a
  // little narrower.
  shape: 1.4,
  // A render with no graphic in the photo may still read a little (folds, the collar's shadow).
  stray: 0.06,
  // DINOv2 likeness of the two garments (cosine): a flat photo and a worn render are rarely above 0.7, a
  // different garment rarely above 0.3.
  likeness: 0.35,
  // A dress's flare (its hem's width over its hips') on the render against its photo's, as worn (see
  // WORN_FLARE): from 1/1.15 to 1.3 times. Renders of twelve Kith dresses that hang as their photos show
  // read 0.86 to 1.11 (the Desma's and the Saja's, which flare a little less than their photos, 0.86); the
  // Desma drawn as a tube, 0.77. Too little flare is what goes wrong; a little more is held less tightly.
  flare: [1 / 1.15, 1.3]
}

// The collar's band at the top of a front, which lookOf (print.js) leaves out: a share of the front's length.
const COLLAR_BAND = 0.08
// How much less a worn dress widens from its hips to its hem than the same dress laid flat (a worn hem
// curves round the legs; a flat one is spread out): the render's flare is held to the photo's times this,
// the middle of the matrix renders'.
export const WORN_FLARE = 0.95
// A photo whose flare reads outside this wasn't measured right (a hanger's bar, a model's legs): no check.
const PHOTO_FLARE = [0.8, 2.5]

// A dress's outline against its photo's (print.js's measureDress, of the shop photo and of the render alone):
// how much each widens from its hips to its hem (a tube's hem is as wide as its hips; an A-line's, wider).
// { score (the render's flare over the photo's, as worn), photo, render, pass }, or null when either can't
// be read. A dress drawn as a tube when its photo flares scores well under 1.
export function compareShapes(photo, render, bars = BARS) {
  const flare = shape => (shape?.hem > 0 && shape?.hips > 0 ? shape.hem / shape.hips : null)
  const p = flare(photo), r = flare(render)
  if (!p || !r || p < PHOTO_FLARE[0] || p > PHOTO_FLARE[1] || r < 0.5) return null
  const score = r / (p * WORN_FLARE)
  return { score: round(score), photo: round(p), render: round(r), pass: score >= bars.flare[0] && score <= bars.flare[1] }
}

// The photo's outline drawn again where a render's didn't match: its hem scaled by how far the render's flare
// fell short of (or went past) the photo's, at most half again either way. Null when there's nothing to scale.
export function reshaped(cutShape, check) {
  if (!cutShape?.hem || !(check?.score > 0)) return null
  const k = Math.min(1.5, Math.max(1 / 1.5, 1 / check.score))
  return { ...cutShape, hem: round(Math.max(cutShape.hips ?? 0, cutShape.hem * k)) }
}

// The photo's look and the render's (lookOf), and optionally the likeness score. Returns { ok, failed: [names],
// checks: { colour, place, printed, likeness? } }, each { score, pass } (score null when it doesn't apply).
// named: the colour the listing names ("Black"), when it's a plain one, which the photo's reading is held to
// as well (a photo of another colourway, or a misread colour, shows up there).
// unprinted: the garment is drawn with no print whatever its photo shows (a dress whose listing doesn't say
// it's printed: its ties, ruching, a leather's shine or the inside seen through an open back read as a
// graphic in the photo), so only its colour and likeness are checked.
export function compareLooks(photo, render, { likeness = null, named = null, bars = BARS, unprinted = false } = {}) {
  const checks = {}
  if (!photo || !render) return { ok: false, failed: ["unread"], checks }
  const de = colourGap(photo.color, render.color)
  checks.colour = { score: round(de), pass: de <= bars.colour }
  if (named) {
    const gap = colourGap(named, photo.color)
    checks.named = { score: round(gap), pass: gap <= bars.named }
  }

  if (unprinted) {
    if (typeof likeness === "number") checks.likeness = { score: round(likeness), pass: likeness >= bars.likeness }
    const failed = Object.entries(checks).filter(([, c]) => !c.pass).map(([name]) => name)
    return { ok: failed.length === 0, failed, checks }
  }

  // How much is printed: an all-over print or stripes against a graphic is the clearest misreading, and a
  // plain photo's render mustn't have a graphic of its own. (The share of the front that's graphic isn't held
  // to the photo's: a worn front wraps round the body, so less of it shows and a graphic is a bigger share of
  // it, by more the looser it is. Its size is checked by its height instead, below.)
  if (photo.allOver !== render.allOver) checks.printed = { score: render.allOver ? "all over" : "not all over", pass: false }
  else if (photo.allOver || photo.box) checks.printed = { score: round(render.coverage / Math.max(1e-3, photo.coverage)), pass: true }
  else checks.printed = { score: round(render.coverage), pass: render.coverage <= bars.stray }

  // Where the graphic sits and how big it is: its top edge and middle (what moves when the front's top is
  // misread), its height over the garment's length (what grows when it's laid too big: the length is the same
  // on a flat photo and a worn render, where its width depends on how the sleeves lie), and its shape.
  if (photo.box && render.box) {
    const p = photo.box, r = render.box
    // Its middle across is where most of it is, when both readings have that: a box's middle moves a long
    // way when a scrap of print at one side is or isn't read (the render's at another screen's sharpness).
    const across = (box) => typeof box.cx === "number" ? box.cx : (box.left + box.right) / 2
    const top = Math.abs(p.top - r.top), middle = Math.abs(across(p) - across(r))
    const size = (r.bottom - r.top) / Math.max(1e-3, p.bottom - p.top)
    // A graphic running most of the way across the front (a wide scene, a print to the side seams) is as
    // wide as the front: a worn front shows less of its width than a flat one, so its shape isn't held.
    const wide = p.right - p.left > 0.7
    // A graphic just under the collar in the photo (a logo at the back of the neck) runs up into the collar's
    // band, which isn't read (lookOf), and a render's collar stands a little higher or lower than the photo's:
    // how much of it is cut off there differs, so its height and shape aren't held, only where it sits. (A
    // render's graphic pushed up under a collar the photo's isn't under is still held to its size.)
    const underCollar = p.top <= COLLAR_BAND + 0.005
    const shape = p.shape && r.shape && !wide && !underCollar ? r.shape / p.shape : 1
    // And for the same reason its middle across is allowed twice as far: a scene to one side of a wide
    // print sits further out on the curve of a worn front (a good render of one read 0.11 off).
    const sideways = wide ? bars.place * 2 : bars.place
    checks.place = {
      score: round(Math.max(top, middle)), top: round(top), middle: round(middle), size: round(size), shape: round(shape),
      pass: top <= bars.place && middle <= sideways && (underCollar || (size <= bars.size && size >= 1 / bars.size)) && shape <= bars.shape && shape >= 1 / bars.shape
    }
  } else if (photo.box && !render.box) {
    // A small logo can read just under the size a graphic needs to have its place found (lookOf): it's
    // missing only when the render has next to none of the photo's graphic.
    checks.place = { score: "missing", pass: render.coverage >= photo.coverage * 0.3 && photo.coverage < 0.01 }
  }
  else checks.place = { score: null, pass: true }

  if (typeof likeness === "number") checks.likeness = { score: round(likeness), pass: likeness >= bars.likeness }

  const failed = Object.entries(checks).filter(([, c]) => !c.pass).map(([name]) => name)
  return { ok: failed.length === 0, failed, checks }
}

// The readings to try, in turn, when a render doesn't match its photo: which of print.js's guesses to turn off
// (readPhoto's options) and whether to take the listing's named colour over the photo's. The second try is
// aimed at what failed; the third is the safe reading (the cloth's colour and the front's graphic only).
export function nextReading(attempt, failed) {
  if (attempt > 3) return null
  if (attempt === 2) {
    const reading = { hood: true, patterns: true, sleeves: true, back: true, listingColour: false }
    if (failed.includes("colour") || failed.includes("named")) reading.listingColour = true
    if (failed.includes("place") || failed.includes("likeness")) reading.hood = false
    if (failed.includes("printed") || failed.includes("likeness")) Object.assign(reading, { patterns: false, sleeves: false })
    return reading
  }
  return { hood: false, patterns: false, sleeves: false, back: false, listingColour: failed.includes("colour") || failed.includes("named") }
}

// A top the store gives no length for (its sizes are guessed from usual ones) whose photo shows it short (a
// cropped hoodie, a cropped polo): its length from the photo's own proportions, so it isn't drawn to the hip.
// Tops of usual length keep the usual lengths: the photo's proportion is only trusted where it says cropped.
export function croppedLengths(chart, look) {
  const proportion = look?.proportion
  if (!["body", "sizes"].includes(chart?.kind) || !(proportion > 0.3 && proportion < 1.05)) return null
  const sizes = chart.sizes.map(size => size.chest > 0 ? { ...size, length: Math.round((size.chest / 2) * proportion) } : size)
  return sizes.some((size, i) => size.length !== chart.sizes[i].length) ? sizes : null
}

// ΔE between two "#rrggbb" colours in Lab, lightness counted at half.
export function colourGap(a, b) {
  const [l1, a1, b1] = lab(a), [l2, a2, b2] = lab(b)
  return Math.hypot((l1 - l2) * 0.5, a1 - a2, b1 - b2)
}

function lab(hex) {
  const v = [1, 3, 5].map(i => parseInt(String(hex).slice(i, i + 2), 16) / 255 || 0)
    .map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  const x = (v[0] * 0.4124 + v[1] * 0.3576 + v[2] * 0.1805) / 0.95047
  const y = v[0] * 0.2126 + v[1] * 0.7152 + v[2] * 0.0722
  const z = (v[0] * 0.0193 + v[1] * 0.1192 + v[2] * 0.9505) / 1.08883
  const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
}

function round(n) {
  return typeof n === "number" ? Math.round(n * 1000) / 1000 : n
}
