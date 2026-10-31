// How much of a sheer cloth's colour shows (1: all of it, none of the body behind). The listing's word says how
// much the body should show, as a change in how light the cloth looks (CIE L*): hardly any for semi-sheer
// (in its photo it reads as its own colour), a little for a printed sheer (its print is what's seen), plainly
// for sheer. The share follows from the cloth's colour against the mannequin's pale skin behind it (the
// palest a body can be): a dark cloth over pale skin shows it far more than a pale one does at the same
// share, so a charcoal semi-sheer lets about 1% through and a white one far more. (A fixed share of 0.9 made
// a charcoal jersey look see-through.)
export const SHEER_SKIN = 0.7   // the mannequin's skin, as linear luminance
export function sheerShow(color, kind, printed) {
  const target = kind === "semi" ? 3 : printed ? 7 : 12
  const hex = /^#?([0-9a-f]{6})$/i.exec(String(color ?? ""))?.[1] ?? "808080"
  const linear = k => { const v = parseInt(hex.slice(2 * k, 2 * k + 2), 16) / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  const Y = 0.2126 * linear(0) + 0.7152 * linear(1) + 0.0722 * linear(2)
  const lightness = y => (y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y)
  const luminance = l => (l > 8 ? ((l + 16) / 116) ** 3 : l / 903.3)
  const to = Math.min(100, Math.max(0, lightness(Y) + (SHEER_SKIN > Y ? target : -target)))
  const share = 1 - Math.abs(luminance(to) - Y) / Math.max(1e-4, Math.abs(SHEER_SKIN - Y))
  return Math.min(0.99, Math.max(0.55, share))
}
