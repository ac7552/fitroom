// For render.mjs --script: Kith's Essentials MLB Lounge Sweatpant (its shop photos in tmp/kith as
// ess-front.png and ess-back.png, served at /kith/, not in the repo): "ESSENTIALS" printed down the wearer's
// right leg, along its side seam, seen from the front and again from behind. Read and laid on as the page
// does (print.js's readBottomPhoto, then the photos re-draped point for point, stage.js#advanceRedrape).
// ?redrape=off: the photo map alone. Returns { rigid: graphics laid as one piece, redrape }.
const FRONT = "/kith/ess-front.png", BACK = "/kith/ess-back.png"
const SIZE = { waist: 84, seat: 112, thigh: 72, inseam: 78, leg_opening: 58 }
export default async function (stage) {
  const params = new URL(import.meta.url).searchParams
  const print = window.print
  const front = await print.readBottomPhoto(FRONT), back = await print.readBottomPhoto(BACK)
  const item = {
    kind: "trousers", style: "sweatpants", fabric: "fleece", color: front?.color ?? "#111111", size: SIZE,
    photoMap: front ? { image: front.image, soft: front.soft, layout: front.layout, back: back ? { image: back.image, layout: back.layout } : null } : null
  }
  if (params.get("redrape") !== "off") Object.assign(item, { photo: FRONT, back_photo: BACK })
  stage.setOutfit([item])
  const deadline = Date.now() + 300000, details = {}
  while (Date.now() < deadline) {
    stage.advanceDrape(); stage.advanceRedrape?.()
    await new Promise(r => setTimeout(r, 0))
    const d = Object.values(stage.slots).find(Boolean)
    if (stage.settled && (!item.photo || ["done", "off"].includes(d?.redrapeState))) { Object.assign(details, { redrape: d?.redrapeState, rigid: d?.rigid ?? null }); break }
  }
  return details
}
