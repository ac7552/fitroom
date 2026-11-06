// Colour arithmetic for metering the drawn cloth to its shop photo (stage.js#meter) and the accuracy checks.
// An sRGB colour (hex, or [r, g, b] 0 to 255) in linear light, 0 to 1.
export function linearOf(color) {
  const rgb = typeof color === "string" ? [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16)) : color
  return rgb.map(v => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 })
}

// CIE76 colour difference between two sRGB colours ([r, g, b], 0 to 255): about 2.3 is a just-noticeable step.
export function deltaE(a, b) {
  const lab = rgb => {
    const [r, g, bl] = linearOf(rgb)
    const xyz = [(0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047, 0.2126 * r + 0.7152 * g + 0.0722 * bl, (0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883]
    const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
    const [fx, fy, fz] = xyz.map(f)
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
  }
  const p = lab(a), q = lab(b)
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
}
