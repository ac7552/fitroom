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
  // Its height over the garment's length, against the photo's: within 1/1.3 to 1.3 times.
  size: 1.3,
  // Its shape (width over height) against the photo's: a worn front curves round the body, so it reads a
  // little narrower.
  shape: 1.4,
  // How much of the front is graphic, over the photo's: within 1/1.8 to 1.8 times (when the photo has one). A
  // worn front curves round the body, so less of it is seen from in front and a graphic is a bigger share of
  // it: a good render reads about 1.4.
  printed: 1.8,
  // A render with no graphic in the photo may still read a little (folds, the collar's shadow).
  stray: 0.06,
  // DINOv2 likeness of the two garments (cosine): a flat photo and a worn render are rarely above 0.7, a
  // different garment rarely above 0.3.
  likeness: 0.35
}

// The photo's look and the render's (lookOf), and optionally the likeness score. Returns { ok, failed: [names],
// checks: { colour, place, printed, likeness? } }, each { score, pass } (score null when it doesn't apply).
// named: the colour the listing names ("Black"), when it's a plain one, which the photo's reading is held to
// as well (a photo of another colourway, or a misread colour, shows up there).
export function compareLooks(photo, render, { likeness = null, named = null, bars = BARS } = {}) {
  const checks = {}
  if (!photo || !render) return { ok: false, failed: ["unread"], checks }
  const de = colourGap(photo.color, render.color)
  checks.colour = { score: round(de), pass: de <= bars.colour }
  if (named) {
    const gap = colourGap(named, photo.color)
    checks.named = { score: round(gap), pass: gap <= bars.named }
  }

  // How much is printed: an all-over print or stripes against a graphic is the clearest misreading.
  if (photo.allOver !== render.allOver) checks.printed = { score: render.allOver ? "all over" : "not all over", pass: false }
  else if (photo.allOver) checks.printed = { score: null, pass: true }
  else if (photo.coverage > 0.015) {
    const ratio = render.coverage / photo.coverage
    checks.printed = { score: round(ratio), pass: ratio <= bars.printed && ratio >= 1 / bars.printed }
  } else checks.printed = { score: round(render.coverage), pass: render.coverage <= bars.stray }

  // Where the graphic sits and how big it is: its top edge and middle (what moves when the front's top is
  // misread), its height over the garment's length (what grows when it's laid too big: the length is the same
  // on a flat photo and a worn render, where its width depends on how the sleeves lie), and its shape.
  if (photo.box && render.box) {
    const p = photo.box, r = render.box
    const top = Math.abs(p.top - r.top), middle = Math.abs((p.left + p.right) / 2 - (r.left + r.right) / 2)
    const size = (r.bottom - r.top) / Math.max(1e-3, p.bottom - p.top)
    const shape = p.shape && r.shape ? r.shape / p.shape : 1
    checks.place = {
      score: round(Math.max(top, middle)), size: round(size), shape: round(shape),
      pass: top <= bars.place && middle <= bars.place && size <= bars.size && size >= 1 / bars.size && shape <= bars.shape && shape >= 1 / bars.shape
    }
  } else if (photo.box && !render.box) checks.place = { score: "missing", pass: false }
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
