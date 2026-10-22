// Turns measurements into shape-key settings for the 3D model (public/models/mannequin.glb).
//
// The model's calibration (mannequin.json) says what the base body, its jacket and its trousers measure,
// and how much each MakeHuman target changes them at full strength. Height is a uniform scale; the other
// measurements are matched by solving for target weights (hips and inseam only when given). Then each
// size's measurements become "ease" settings: how many centimetres to grow or shrink the modelled garment
// in each place.
//
// Pure functions, no three.js, so they can be tested in Node.

const TARGETS = [
  { measure: "chest", keys: ["measure-bust-circ"] },
  { measure: "waist", keys: ["measure-waist-circ"] },
  { measure: "shoulders", keys: ["measure-shoulder-dist"] },
  { measure: "arm", keys: ["measure-upperarm-length", "measure-lowerarm-length"] },
  { measure: "hips", keys: ["measure-hips-circ"], optional: true },
  { measure: "inseam", keys: ["measure-upperleg-height", "measure-lowerleg-height"], optional: true }
]
const MAX_WEIGHT = 2

const JACKET_EASE = { chest: "ease-chest", waist: "ease-waist", shoulders: "ease-shoulders", sleeve: "ease-sleeve", length: "ease-length" }
const TROUSER_EASE = {
  waist: "ease-trousers-waist", seat: "ease-seat", thigh: "ease-thigh", inseam: "ease-inseam", leg_opening: "ease-leg-opening"
}
// However small a size, a garment is drawn at least this much bigger than the body, so it never sinks into
// it; the fit map and the verdict say how tight it really is.
const MIN_ROOM = { chest: 3, waist: 2.5, seat: 2, trouserWaist: 1, casualWaist: 6 }
// A coat is drawn at least this much bigger (and longer) than the jacket under it.
const OVER_ROOM = 2.5
// A casual jacket's length (cm, at the model's height) when its chart doesn't say.
const CASUAL_LENGTH = 66

// body: { chest, waist, shoulders, arm, height, hips?, inseam? } in cm.
// Returns the scale, target weights and shape-key influences, what the modelled body and garments
// measure on it (model cm), and which measurements the model couldn't reach.
export function fitBody(calibration, body) {
  const scale = body.height / calibration.body.height
  const active = TARGETS.map(t => !t.optional || Number.isFinite(body[t.measure]))
  const want = Object.fromEntries(TARGETS.map(t => [t.measure, body[t.measure] / scale]))
  const weights = TARGETS.map(() => 0)

  // Gauss-Seidel: each target takes care of its own measurement, given what the others do to it.
  for (let pass = 0; pass < 25; pass++) {
    TARGETS.forEach((target, i) => {
      if (!active[i]) return
      const others = effect(calibration, weights.map((w, j) => (j === i ? 0 : w)), "body")[target.measure] ?? 0
      const needed = want[target.measure] - calibration.body[target.measure] - others
      const perUnit = Math.abs(keyEffect(calibration, target, needed >= 0 ? "incr" : "decr", "body", target.measure))
      weights[i] = perUnit === 0 ? 0 : clamp(needed / perUnit, -MAX_WEIGHT, MAX_WEIGHT)
    })
  }

  const influences = {}
  TARGETS.forEach((target, i) => {
    for (const key of target.keys) {
      influences[`${key}-incr`] = Math.max(weights[i], 0)
      influences[`${key}-decr`] = Math.max(-weights[i], 0)
    }
  })
  const limited = TARGETS.filter((t, i) => active[i] && Math.abs(weights[i]) >= MAX_WEIGHT - 1e-6).map(t => t.measure)
  return {
    scale, weights, influences, limited,
    body: modelled(calibration, weights, "body"),
    jacket: modelled(calibration, weights, "jacket"),
    casual: calibration.casual ? modelled(calibration, weights, "casual") : null,
    trousers: modelled(calibration, weights, "trousers")
  }
}

// size: one size from a jacket or coat chart, in cm (any value may be null). Returns ease influences.
// layer: which modelled jacket draws it, the suit's ("jacket") or the casual one ("casual").
// over: what the jacket under a coat measures as drawn (see drawnSize), so the coat stays outside it.
export function fitJacket(calibration, fitted, size, { over = null, layer = "jacket" } = {}) {
  const garment = fitted[layer]
  // The casual jacket is built long and cut to length, so it needs a length even when the chart has none.
  if (layer === "casual" && size.length == null) size = { ...size, length: CASUAL_LENGTH * fitted.scale }
  const check = checksFor(calibration, layer)
  const floor = {
    chest: (fitted.body.chest + MIN_ROOM.chest - garment.chest),
    // A casual jacket hangs straight from the chest, so drawn tighter at the waist its front meets the stomach.
    waist: (fitted.body.waist + (layer === "casual" ? MIN_ROOM.casualWaist : MIN_ROOM.waist) - garment.waist)
  }
  if (over) {
    for (const part of Object.keys(JACKET_EASE)) floor[part] = Math.max(floor[part] ?? -Infinity, over[part] + OVER_ROOM - garment[part])
  }
  return easeFor(check, fitted, size, JACKET_EASE, garment, floor)
}

// What a jacket measures as drawn with these ease influences (model cm).
export function drawnSize(calibration, fitted, ease, layer = "jacket") {
  const check = checksFor(calibration, layer)
  const drawn = { ...fitted[layer] }
  for (const [key, influence] of Object.entries(ease)) {
    for (const [part, perUnit] of Object.entries(check[key] ?? {})) {
      if (part in drawn) drawn[part] += influence * perUnit
    }
  }
  return drawn
}

// size: one size from a trousers chart, in cm. Returns ease influences.
export function fitTrousers(calibration, fitted, size) {
  const floor = {
    waist: fitted.body.waist + MIN_ROOM.trouserWaist - fitted.trousers.waist,
    seat: fitted.body.hips + MIN_ROOM.seat - fitted.trousers.seat
  }
  return easeFor(calibration.ease_check, fitted, size, TROUSER_EASE, fitted.trousers, floor)
}

function checksFor(calibration, layer) {
  return layer === "casual" ? calibration.ease_check_casual : calibration.ease_check
}

function easeFor(check, fitted, size, keys, garment, floor) {
  const influences = {}
  for (const [part, key] of Object.entries(keys)) {
    const target = size[part]
    if (target == null) { influences[key] = Math.max(0, (floor[part] ?? -Infinity) / (check[key]?.[part] || 1)); continue }
    const perCm = check[key]?.[part] || 1
    const wanted = target / fitted.scale - garment[part]
    influences[key] = clamp(Math.max(wanted, floor[part] ?? -Infinity) / perCm, -20, 30)
  }
  return influences
}

function modelled(calibration, weights, layer) {
  const change = effect(calibration, weights, layer)
  return Object.fromEntries(Object.entries(calibration[layer]).map(([k, v]) => [k, v + (change[k] ?? 0)]))
}

function effect(calibration, weights, layer) {
  const total = {}
  TARGETS.forEach((target, i) => {
    const w = weights[i]
    if (w === 0) return
    const direction = w > 0 ? "incr" : "decr"
    for (const key of target.keys) {
      for (const [measure, delta] of Object.entries(calibration.targets[`${key}-${direction}`][layer] ?? {})) {
        total[measure] = (total[measure] ?? 0) + Math.abs(w) * delta
      }
    }
  })
  return total
}

function keyEffect(calibration, target, direction, layer, measure) {
  return target.keys.reduce((sum, key) => sum + (calibration.targets[`${key}-${direction}`][layer][measure] ?? 0), 0)
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}
