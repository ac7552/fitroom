// How the 3D view frames the figure, like a lookbook photo: head to toe, filling most of the picture's
// height, kept clear of the controls over the top of the picture and the size rows over its bottom. Pure
// sums, so they can be tested without a browser.

// How much of the picture's height the figure takes, on a wide screen and on a phone (where the picture is
// narrow and tall, and a little more room round the figure reads better).
export const FILL = { wide: 0.78, narrow: 0.72, least: 0.66 }

// A gentle start and stop (smoothstep), for the camera's moves and the garments' fades.
export function easeInOut(t) {
  const x = Math.min(1, Math.max(0, t))
  return x * x * (3 - 2 * x)
}

// height: the figure's, in metres (feet at 0). fov: the camera's vertical field of view, degrees.
// pictureHeight: pixels. insets: { top, bottom } pixels of the picture taken by things laid over it (the
// figure is centred in the band between them). narrow: a phone-width picture.
// Returns { distance } from the band's centre to the camera, { centreY } the height the camera looks at (the
// figure's middle, moved so it's centred in the band), and { fill } the share of the picture the figure takes.
export function framing({ height, fov = 22, pictureHeight = 0, insets = { top: 0, bottom: 0 }, narrow = false }) {
  const top = Math.max(0, insets?.top ?? 0), bottom = Math.max(0, insets?.bottom ?? 0)
  const px = pictureHeight > 0 ? pictureHeight : 1000
  // The band between the things laid over the picture; never less than half of it, or the figure would
  // shrink to a toy when the controls wrap onto many lines.
  const band = Math.max(px * 0.5, px - top - bottom)
  const want = narrow ? FILL.narrow : FILL.wide
  // The figure fills the band nearly whole when the band is tight, but never less than `least` of the picture.
  const fill = Math.max(FILL.least, Math.min(want, (band / px) * 0.96))
  const visible = height / fill   // the picture's height in metres at the figure
  const distance = (visible / 2) / Math.tan((fov * Math.PI) / 360)
  // The band's centre, as a share of the picture from the top, against the picture's own centre.
  const bandCentre = (Math.min(top, px - band) + band / 2) / px
  const centreY = height / 2 - (0.5 - bandCentre) * visible
  return { distance, centreY, fill }
}
