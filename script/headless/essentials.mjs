// For render.mjs --script: Kith's Essentials MLB Lounge Sweatpant (its shop photos in tmp/kith as
// ess-front.png and ess-back.png, served at /kith/, not in the repo): "ESSENTIALS" printed down the wearer's
// right leg, along its side seam, seen from the front and again from behind. Read and laid on as the page
// does (fitting_room_controller.js: print.js's readBottomPhoto, the legs' graphics by leg_prints.js, then the
// photos re-draped point for point, stage.js#advanceRedrape).
// ?redrape=off: no re-draping. ?legs=off: the graphics left in the photo, as before leg_prints.js.
// Returns { prints: graphics found [front, back], rigid, redrape }.
const SIZE = { waist: 84, seat: 112, thigh: 72, inseam: 78, leg_opening: 58 }
export default async function (stage) {
  const params = new URL(import.meta.url).searchParams
  // ?front=URL&back=URL: another pair of pants' photos (back may be left off).
  const FRONT = params.get("front") ?? "/kith/ess-front.png", BACK = params.has("front") ? params.get("back") : "/kith/ess-back.png"
  const print = window.print
  const { readLegPrints, legPrintAtlas } = await import("lib/garments/leg_prints")
  let front = await print.readBottomPhoto(FRONT), back = BACK ? await print.readBottomPhoto(BACK) : null
  let photos = { front: FRONT, back: BACK ?? null }, legPrints = null
  const details = {}
  if (params.get("legs") !== "off") {
    const legs = await readLegPrints(FRONT, front.layout), legsBack = back ? await readLegPrints(BACK, back.layout, { behind: true }) : null
    details.prints = [legs?.prints.length ?? 0, legsBack?.prints.length ?? 0]
    details.boxes = [legs?.prints.map(p => p.box.map(Math.round)), legsBack?.prints.map(p => p.box.map(Math.round))]
    const atlas = legPrintAtlas(legs, legsBack)
    if (atlas) legPrints = { front: { prints: legs?.prints ?? [], layout: front.layout }, back: legsBack ? { prints: legsBack.prints, layout: back.layout } : null, atlas }
    photos = { front: legs?.cleaned ?? FRONT, back: legsBack?.cleaned ?? BACK ?? null }
    if (legs) { const c = await print.readBottomPhoto(legs.cleanedSmall.toDataURL("image/png")); front = { ...front, image: c.image, soft: c.soft } }
    if (legsBack) { const c = await print.readBottomPhoto(legsBack.cleanedSmall.toDataURL("image/png")); back = { ...back, image: c.image } }
    window.legsDebug = { legs, legsBack, atlas }
  }
  const item = {
    kind: "trousers", style: "sweatpants", fabric: "fleece", color: front?.color ?? "#111111", size: SIZE, legPrints,
    photoMap: front ? { image: front.image, soft: front.soft, layout: front.layout, back: back ? { image: back.image, layout: back.layout } : null } : null
  }
  if (params.get("redrape") !== "off") Object.assign(item, { photo: photos.front, back_photo: photos.back ?? null })
  stage.setOutfit([item])
  const deadline = Date.now() + 300000
  while (Date.now() < deadline) {
    stage.advanceDrape(); stage.advanceRedrape?.()
    await new Promise(r => setTimeout(r, 0))
    const d = Object.values(stage.slots).find(Boolean)
    if (stage.settled && (!item.photo || ["done", "off"].includes(d?.redrapeState))) { Object.assign(details, { redrape: d?.redrapeState, rigid: d?.rigid ?? null }); break }
  }
  return details
}
