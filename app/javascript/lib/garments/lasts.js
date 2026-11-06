// Lasts: what shape a shoe is, read from its side photo and its listing, as the numbers accessories.js
// lofts a shoe from. A shop's five drawing styles (sneaker, high-top, boot, loafer, sandal) are the same
// shoe in different colours; a last says how this shoe differs: the family it's built on (a runner's
// rockered sole and low collar, a court shoe's flat sole, a chunky sneaker's tall sole, a Chelsea boot's
// shaft, a derby's thin welt, a pump's heel, a slide's open top), and the measurements the photo shows:
// the sole's thickness heel to toe (a heel's height), how high the collar comes, how blunt the toe is.
//
// Everything is in shares of the foot's length (so it scales with the body) or of the shoe's height, from
// print.js's shoeSide reading ({ top, bottom, sole, soleProfile, front, back, height, aspect }).

// The families and their defaults, over accessories.js's SHOES (m, for a 1.76 m body): the drawing style
// to build on, the collar's heights, the sole, and what's special.
export const FAMILIES = {
  runner: { style: "sneaker", back: 0.095, front: 0.08, sole: 0.03, box: 0.042, rocker: 0.012, toeSpring: 0.018 },
  court: { style: "sneaker", back: 0.095, front: 0.085, sole: 0.024, box: 0.044, rocker: 0.004, toeSpring: 0.008 },
  chunky: { style: "sneaker", back: 0.105, front: 0.09, sole: 0.042, box: 0.05, flare: 0.008, rocker: 0.01, toeSpring: 0.014 },
  hightop: { style: "hightop" },
  chelsea: { style: "boot", back: 0.17, front: 0.16, dip: 0.002, lugs: 0, pad: 0, square: 2.0, box: 0.06, laces: false },
  combat: { style: "boot" },
  // A knee-high boot (a rain boot, a riding boot): a shaft to under the knee, pulled on, a round toe.
  tall: { style: "boot", back: 0.4, front: 0.38, dip: 0.004, lugs: 0, pad: 0, square: 2.4, sole: 0.03, box: 0.062, laces: false },
  derby: { style: "loafer", back: 0.07, front: 0.058, sole: 0.018, box: 0.038, square: 1.9, toeSpring: 0.01 },
  loafer: { style: "loafer", laces: false },
  pump: { style: "loafer", back: 0.06, front: 0.04, dip: 0.02, sole: 0.008, box: 0.03, square: 1.6, heel: 0.07, toeSpring: 0.004, laces: false },
  flat: { style: "loafer", back: 0.045, front: 0.03, dip: 0.016, sole: 0.008, box: 0.028, square: 1.7, laces: false },
  sandal: { style: "sandal", laces: false },
  slide: { style: "sandal", strap: [0.03, 0.07], sole: 0.028, laces: false }
}

// The family from the listing's words (the name and category first), else from the drawing style.
export function familyFromWords(words, style = "sneaker") {
  const w = String(words ?? "")
  const rules = [
    ["slide", /\bslides?\b|\bmules?\b|\bclogs?\b|\bslippers?\b/i],
    ["sandal", /sandals?|flip[- ]?flops?|birkenstock/i],
    ["pump", /\bpumps?\b|stiletto|\bheels?\b|platform heel|kitten/i],
    ["flat", /ballet|ballerina|\bflats?\b|mary jane/i],
    ["tall", /rain boots?|wellington|wellies?|dry boot|rubber boot|galosh|knee[- ]high|over[- ]the[- ]knee|thigh[- ]high|tall boot|riding boot|boot high\b/i],
    ["chelsea", /chelsea|zip boot|ankle boot|boot(?!ie).*(?:leather|suede)(?!.*(?:combat|hiking|lace))/i],
    ["combat", /combat|hiking|lace[- ]up boot|work boot|\bboots?\b/i],
    ["hightop", /high[- ]?tops?|\bhi\b|mid[- ]top/i],
    ["derby", /derby|oxford|brogue|monk|dress shoe|wingtip|blucher/i],
    ["loafer", /loafers?|moccasin|penny|driver|boat shoe|espadrille/i],
    ["runner", /running|runner|racer|trail|gel[- ]|pegasus|cloud(?:monster|swift|surfer|tilt)|\bhoka\b|asics|\b990|\b1906|\b2002|\b9060|\b550\b.*run|air max|zoom|ultraboost|marathon|jogger/i],
    ["chunky", /chunky|dad shoe|\bdad\b|\b9060\b|\bozweego\b|\bbalenciaga\b|platform sneaker|\btriple s\b/i],
    ["court", /court|air force|\baf1\b|\b550\b|stan smith|superstar|samba|gazelle|campus|dunk|low[- ]top|tennis|skate|\bvans\b|old skool|chuck/i]
  ]
  for (const [family, pattern] of rules) if (pattern.test(w)) return family
  return { sneaker: "court", hightop: "hightop", boot: "combat", loafer: "loafer", sandal: "sandal" }[style] ?? "court"
}

// What the side photo measures, as shares: the sole's thickness at the heel, the ball and the toe (of the
// shoe's height), the collar's height at the back and front (of the height), the toe's bluntness (how far
// the front edge's top is behind its bottom, of the length: a pointed toe tapers, a boot's is blunt), and
// the heel's rise (the sole at the heel over the sole at the ball, of the height: a heel).
export function measureSide(side) {
  if (!side?.top || !side.bottom) return null
  const n = side.top.length
  const at = (list, u) => list[Math.min(n - 1, Math.max(0, Math.round(u * (n - 1))))]
  const H = side.height || 1
  const tallAt = u => at(side.bottom, u) - at(side.top, u)
  const soleAt = u => (side.soleProfile ? at(side.soleProfile, u) : (at(side.bottom, u) - at(side.sole, u)) / H)
  // (The heel's: the thickest over the back fifth, where a heel's stem is tallest.)
  let heelSole = 0
  for (let u = 0.04; u <= 0.2; u += 0.02) heelSole = Math.max(heelSole, soleAt(u))
  const sole = { heel: heelSole, ball: soleAt(0.62), toe: soleAt(0.92) }
  // Collar: the top edge's height over the floor at the back (heel, 10 %) and at the front of the ankle
  // (40 % along); over the shoe's height.
  const floor = Math.max(...side.bottom)
  const collar = { back: (floor - at(side.top, 0.1)) / H, front: (floor - at(side.top, 0.42)) / H }
  // The toe's taper from the front edge per height row (side.front: shares of the length, floor up): how
  // much less far the toe reaches at a third of the shoe's height than at the sole (0: an upright, blunt
  // toe, a boot's; 0.08: a pointed one).
  const front = side.front ?? []
  const taper = front.length ? Math.max(0, (front[1] ?? front[0] ?? 1) - (front[Math.round(front.length * 0.3)] ?? 1)) : 0
  return { sole, collar, taper, heelRise: Math.max(0, sole.heel - sole.ball), tall: tallAt(0.5) / H }
}

// The last for a shoe: its family's defaults, then what the photo measured laid over them (in metres for a
// 1.76 m body, as SHOES is: the foot is about 0.26 m of it). words: the listing's; style: the import's
// drawing style; side: shoeSide's reading, or null. Returns { family, params } for accessories.js.
export function lastFor(words, style, side) {
  const family = familyFromWords(words, style)
  const base = FAMILIES[family] ?? FAMILIES.court
  const params = { ...base }
  const m = measureSide(side)
  if (m) {
    // The photo's shoe height in metres: its height over its length, times a foot's length plus the toe room.
    const length = 0.27
    const shoeHeight = (side.height * side.aspect) / ((side.right - side.left) || 1) * length
    // Sole: the ball's thickness (a heel's height is the rise above it).
    params.sole = clamp(m.sole.ball * shoeHeight, 0.008, 0.06)
    params.heel = clamp(m.heelRise * shoeHeight, 0, 0.11)
    params.toeSole = clamp(m.sole.toe * shoeHeight, 0.004, params.sole)
    // Collar heights, back and front, where the photo shows a shaft or a low cut.
    params.back = clamp(m.collar.back * shoeHeight, 0.03, 0.55)
    params.front = clamp(m.collar.front * shoeHeight, 0.025, params.back)
    // The toe: blunter (a squarer cross-section) when its front edge is upright, pointed when it tapers.
    params.square = clamp(2.3 - m.taper * 8, 1.5, 3.0)
    params.measured = true
  }
  // Laced, unless the family isn't or the listing says it's pulled or zipped on.
  if (/slip[- ]?on|pull[- ]?on|\bzip|chelsea|wellington|mule|clog|elastic/i.test(String(words ?? ""))) params.laces = false
  return { family, params }
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)) }
