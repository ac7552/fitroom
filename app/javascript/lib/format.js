// Display helpers. The API answers in centimetres; inches round to the nearest quarter, the way a tape
// measure reads.
export function formatLength(cm, unit) {
  if (unit === "in") {
    const quarters = Math.round(Math.abs(cm) / 2.54 * 4)
    const whole = Math.floor(quarters / 4)
    const frac = ["", "¼", "½", "¾"][quarters % 4]
    return `${whole === 0 && frac ? frac : `${whole}${frac}`} in`
  }
  return `${Math.round(Math.abs(cm) * 2) / 2} cm`
}

// A rough amount in plain words, for results: "about ½ inch", "about 2 inches", "about 3 cm". Inches round
// to the nearest half, centimetres to the nearest whole one, and never to nothing.
export function formatAbout(cm, unit) {
  if (unit === "in") {
    const halves = Math.max(1, Math.round((Math.abs(cm) / 2.54) * 2))
    const whole = Math.floor(halves / 2), half = halves % 2 ? "½" : ""
    const amount = whole === 0 ? "½" : `${whole}${half}`
    return `about ${amount} ${halves <= 2 ? "inch" : "inches"}`
  }
  const whole = Math.max(1, Math.round(Math.abs(cm)))
  return `about ${whole} cm`
}

export function toCm(value, unit) {
  return unit === "in" ? value * 2.54 : value
}
