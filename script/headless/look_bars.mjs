// For render.mjs --script: how the 3D view's check (look_check.js) scores good and bad readings of a tee
// photo, to set its bars. Draws a shop-style photo of a tee with a chest graphic, reads it as the page does,
// lays it on the draped tee, photographs the tee alone (stage.lookShot), reads that, and compares. Then the
// same with known misreadings: the graphic blown up and pushed under the collar, stripes laid all round, and
// the wrong colour. Prints each case's checks.
//   node script/headless/render.mjs --script look_bars.mjs --out tmp/shots/look.png \
//     --items '[{"kind":"top","style":"tee","size":{"chest":112,"shoulders":46,"sleeve":20,"length":72},"color":"#f4f3ef","fabric":"jersey"}]'
import { compareLooks, PLAIN } from "/lib/garments/look_check.js"

export default async function (stage) {
  const P = window.print
  window.LOOK_DUMP = true
  const photo = teePhoto()
  const read = await P.readPhoto(photo.toDataURL("image/png"))
  const plain = await P.readPhoto(photo.toDataURL("image/png"), PLAIN)
  const base = { kind: "top", style: "tee", size: { chest: 112, shoulders: 46, sleeve: 20, length: 72 }, fabric: "jersey", photoSize: { chest: 112, length: 72 } }
  const cases = {
    good: { ...base, color: read.color, print: read.print },
    "too big, too high": { ...base, color: read.color, print: { ...read.print, image: shifted(read.print.image, 1.5, -0.18) } },
    "stripes all round": { ...base, color: read.color, print: { ...read.print, strip: stripes(), stripes: true, stripSpan: 1 } },
    "wrong colour": { ...base, color: "#1d1e22", print: read.print }
  }
  const out = { photo: plain.look }
  for (const [name, item] of Object.entries(cases)) {
    stage.setOutfit([item])
    for (let i = 0; i < 2000 && !stage.settled; i++) { stage.advanceDrape(); await new Promise(r => setTimeout(r, 0)) }
    const shot = await stage.lookShot("top")
    const found = P.findPrint(shot.data, shot.width, shot.height, null, PLAIN)
    out[name] = { look: found?.look, result: compareLooks(plain.look, found?.look) }
    if (window.LOOK_DUMP && name === "good") {
      const c = document.createElement("canvas"); c.width = shot.width; c.height = shot.height
      c.getContext("2d").putImageData(shot, 0, 0)
      out.goodShot = c.toDataURL("image/png")
      if (found?.print) { const q = document.createElement("canvas"); q.width = found.print.width; q.height = found.print.height; q.getContext("2d").putImageData(new ImageData(found.print.data, q.width, q.height), 0, 0); out.goodPrint = q.toDataURL("image/png") }
    }
  }
  return out
}

// A flat-lay tee on a pale backdrop: white, short sleeves out to the sides, a yellow block with navy lines.
function teePhoto() {
  const c = document.createElement("canvas")
  c.width = 640
  c.height = 640
  const g = c.getContext("2d")
  g.fillStyle = "#eeeeec"
  g.fillRect(0, 0, 640, 640)
  g.fillStyle = "#f6f6f4"
  g.beginPath()
  g.moveTo(255, 120); g.quadraticCurveTo(320, 160, 385, 120)   // collar
  g.lineTo(470, 150); g.lineTo(520, 260); g.lineTo(455, 285)    // right sleeve
  g.lineTo(445, 540); g.lineTo(195, 540); g.lineTo(185, 285)    // body
  g.lineTo(120, 260); g.lineTo(170, 150); g.closePath()          // left sleeve
  g.fill()
  g.fillStyle = "#1c2440"
  g.fillRect(255, 200, 130, 10)
  g.fillStyle = "#f2e46a"
  g.fillRect(232, 222, 176, 70)
  g.fillStyle = "#1c2440"
  for (let x = 240; x < 400; x += 26) g.fillRect(x, 228, 12, 58)
  g.fillRect(240, 302, 160, 10)
  return c
}

// The print, scaled about its top middle and moved up by a share of its height.
function shifted(image, scale, up) {
  const c = document.createElement("canvas")
  c.width = image.width
  c.height = image.height
  const g = c.getContext("2d")
  g.translate(image.width / 2, image.height * up)
  g.scale(scale, scale)
  g.drawImage(image, -image.width / 2, 0)
  return c
}

function stripes() {
  const c = document.createElement("canvas")
  c.width = 4
  c.height = 64
  const g = c.getContext("2d")
  for (let y = 0; y < 64; y++) { g.fillStyle = Math.floor(y / 6) % 2 ? "#c03030" : "#e8d040"; g.fillRect(0, y, 4, 1) }
  return c
}
