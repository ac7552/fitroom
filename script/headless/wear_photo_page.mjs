// For render.mjs --script, and wear_photo.mjs: checks laying a picture back onto the clothes (stage.js#wearPhoto).
// Dresses the women's example body in the Kith hoodie and sweatpants (kith.mjs, photos in tmp/kith), takes the
// page's own front photo (the capture), then:
//   SELF-TEST  wears that very photo: the front view must come out as it went in, and the views at +-0.6 rad
//              as the page's own (mean abs difference per channel, 0..255, over the whole picture and over the
//              front's figure), in each light mode (see fabric.js's PROJECTION: 0 as is, 1 flat-divided, 2 divided
//              by the page's light), against the noise floor of two unworn photos (their grain).
//   STAND-IN   wears the photo with a loud pattern painted over the clothes only (diagonal magenta stripes and
//              "AI" on the chest, inside the garments' mask), in place of a real AI picture, so the projection,
//              its occlusion (a sleeve over the torso) and its falloff round the sides show in renders at 0, 0.6,
//              1.5 and 3.1 rad from the capture camera.
// Pictures are left on window.wearShots (name -> PNG base64) for the runner to save; the numbers are returned.
import kith from "/harness/kith.mjs"

const W = 960, H = 1280
const ANGLES = { "0.0": 0, "0.6": 0.6, "-0.6": -0.6, "1.5": 1.5, "3.1": 3.1 }

export default async function (stage) {
  const shots = (window.wearShots = {})
  const details = { self: {}, modes: {} }
  await kith(stage, "after")
  // Nothing may move the camera between shots but turned(): the outfit's framing move and fades are brought to
  // their end, and the idle turn (OrbitControls' auto-rotate, on 8 s after the last touch, and started again
  // after a reveal or faceFront) and the reveal's turn are stopped for good.
  // Every piece on screen first (a piece is shown on the frame after the drape settles), then at rest.
  for (let i = 0; i < 100 && Object.values(stage.slots).some(d => d && !d.shown); i++) {
    stage.advanceDrape()
    await new Promise(r => setTimeout(r, 20))
  }
  stage.finishMoves()
  stage.revealTurns = false
  stage.revealed = false
  stage.turn = null
  stage.idle?.stop()
  if (stage.idle) stage.idle.later = () => {}
  stage.controls.autoRotate = false
  stage.controls.enableDamping = false
  stage.faceFront()   // the capture camera; everything after is turned from here
  const home = stage.camera.position.clone()
  const drift = () => +stage.camera.position.distanceTo(home).toFixed(6)
  const passes = await stage.photoPasses({ width: W, height: H, guides: true, front: false })
  shots.capture = await base64(passes.image)
  shots.mask = await base64(passes.mask)
  const before = await pixels(passes.image)
  const mask = await pixels(passes.mask)

  // The page's own views, unworn; and the noise floor (two photos of the same view differ by their grain).
  const plain = {}
  for (const [name, angle] of Object.entries(ANGLES)) {
    const blob = await turned(stage, angle)
    plain[name] = await pixels(blob)
    shots[`plain-${name}`] = await base64(blob)
  }
  details.noise = diff(before, plain["0.0"], mask)

  // Self-test: the page's own photo worn must give back the page's own views, from the front and turned.
  for (const mode of [2, 1, 0]) {
    stage.projectionMode = mode
    await stage.wearPhoto(passes.image)
    for (const [name, angle] of Object.entries(ANGLES)) {
      if (mode !== 2 && angle) continue
      const blob = await turned(stage, angle)
      const d = diff(name === "0.0" ? before : plain[name], await pixels(blob), mask)
      if (mode === 2) details.self[name] = d
      else details.modes[mode] = d
      shots[`self-mode${mode}-${name}`] = await base64(blob)
    }
  }
  details.modes[2] = details.self["0.0"]
  await stage.wearPhoto(null)

  // The stand-in: the garments' own mask (the skin hidden), then the pattern inside it over the photo.
  const body = stage.meshes.body
  body.visible = false
  const feet = stage.feet.meshes.map(m => [m, m.visible])
  feet.forEach(([m]) => { m.visible = false })
  const garments = await stage.photoPasses({ width: W, height: H, guides: true, front: false, record: false })
  body.visible = true
  feet.forEach(([m, shown]) => { m.visible = shown })
  shots["garment-mask"] = await base64(garments.mask)
  const standIn = await paintStandIn(passes.image, garments.mask)
  shots.standin = standIn.toDataURL("image/png").split(",")[1]
  for (const mode of [2, 1, 0]) {
    stage.projectionMode = mode
    await stage.wearPhoto(standIn)
    for (const [name, angle] of Object.entries(ANGLES)) {
      if (mode !== 2 && angle) continue
      shots[`ai-mode${mode}-${name}`] = await base64(await turned(stage, angle))
    }
  }
  details.tint = stage.worn?.tint
  details.depth = Boolean(stage.capture?.depth)
  details.drift = drift()
  details.shown = Object.fromEntries(Object.entries(stage.slots).filter(([, d]) => d).map(([slot, d]) => [slot, d.shown]))
  return details
}

// A photo (PNG Blob) from `angle` rad round the figure from the capture camera, which the camera goes back to
// exactly after.
async function turned(stage, angle) {
  const home = stage.camera.position.clone()
  stage.turnCamera(angle)
  stage.controls.update()
  try {
    return await stage.photo({ width: W, height: H })
  } finally {
    stage.camera.position.copy(home)
    stage.controls.update()
  }
}

// The photo with diagonal magenta stripes and "AI" over the clothes (mask: white where they are).
async function paintStandIn(photo, maskBlob) {
  const [image, mask] = await Promise.all([createImageBitmap(photo), createImageBitmap(maskBlob)])
  const canvas = document.createElement("canvas")
  canvas.width = W
  canvas.height = H
  const g = canvas.getContext("2d")
  g.drawImage(image, 0, 0, W, H)
  const pattern = document.createElement("canvas")
  pattern.width = W
  pattern.height = H
  const p = pattern.getContext("2d")
  p.save()
  p.translate(W / 2, H / 2)
  p.rotate(Math.PI / 4)
  p.fillStyle = "#e0119a"
  for (let x = -W - H; x < W + H; x += 56) p.fillRect(x, -W - H, 18, 2 * (W + H))
  p.restore()
  p.fillStyle = "#101216"
  p.font = "bold 150px sans-serif"
  p.textAlign = "center"
  p.textBaseline = "middle"
  p.fillText("AI", W / 2, H * 0.4)
  p.strokeStyle = "#ffffff"
  p.lineWidth = 6
  p.strokeText("AI", W / 2, H * 0.4)
  // Keep the pattern inside the clothes: the mask's brightness as its alpha.
  const m = document.createElement("canvas")
  m.width = W
  m.height = H
  const mg = m.getContext("2d")
  mg.drawImage(mask, 0, 0, W, H)
  const data = mg.getImageData(0, 0, W, H)
  for (let i = 0; i < data.data.length; i += 4) data.data[i + 3] = data.data[i]
  mg.putImageData(data, 0, 0)
  p.globalCompositeOperation = "destination-in"
  p.drawImage(m, 0, 0)
  g.globalAlpha = 0.9
  g.drawImage(pattern, 0, 0)
  g.globalAlpha = 1
  return canvas
}

async function pixels(blob) {
  const image = await createImageBitmap(blob)
  const canvas = document.createElement("canvas")
  canvas.width = W
  canvas.height = H
  const g = canvas.getContext("2d", { willReadFrequently: true })
  g.drawImage(image, 0, 0, W, H)
  return g.getImageData(0, 0, W, H).data
}

// Mean absolute difference per channel (0..255), over everything and over the figure (mask bright).
function diff(a, b, mask) {
  let all = 0, figure = 0, n = 0, m = 0, worst = 0
  for (let i = 0; i < a.length; i += 4) {
    const d = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3
    all += d
    n++
    if (mask[i] > 128) { figure += d; m++; worst = Math.max(worst, d) }
  }
  return { all: +(all / n).toFixed(3), figure: +(figure / Math.max(1, m)).toFixed(3), worst }
}

async function base64(blob) {
  const buffer = new Uint8Array(await blob.arrayBuffer())
  let s = ""
  for (let i = 0; i < buffer.length; i += 0x8000) s += String.fromCharCode.apply(null, buffer.subarray(i, i + 0x8000))
  return btoa(s)
}
