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

export function toCm(value, unit) {
  return unit === "in" ? value * 2.54 : value
}
