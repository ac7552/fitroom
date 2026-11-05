// For render.mjs --script: Kith's Daily Paper Boxy Camo Zip Up Hoodie (its shop photos in tmp/kith as
// dp-front.png and dp-back.png, served at /kith/, not in the repo), read through print.js the way the page
// does. ?spec=top (default): as the import now reads it, a cotton hoodie that zips, with its all-over print
// and the back's photo on its back. ?spec=jacket: as it used to (a zip jacket with the front photo laid on).
const FRONT = "/kith/dp-front.png", BACK = "/kith/dp-back.png"
const SIZE = { chest: 124, shoulders: 58, sleeve: 60, length: 68 }   // a boxy M (the shop gives no chart)
export default async function (stage, spec = new URL(import.meta.url).searchParams.get("spec") ?? "top") {
  const print = window.print
  const read = await print.readPhoto(FRONT, { shape: SIZE.length / (SIZE.chest / 2) })
  const back = await print.readPhoto(BACK)
  const details = { spec, color: read?.color, print: Boolean(read?.print), allOver: Boolean(read?.print?.tile), backPrint: Boolean(back?.print), backCoverage: back?.print?.coverage }
  const front = read?.sleeves, behind = back?.sleeves
  const item = {
    kind: spec === "jacket" ? "jacket" : "top", style: spec === "jacket" ? "zip" : "hoodie", zip: true, fabric: "fleece",
    color: read?.color ?? "#6b6450", size: SIZE, photoSize: { chest: SIZE.chest, length: SIZE.length },
    print: read?.print ?? null, backPrint: back?.print ? { image: back.print.image } : null,
    sleevePrint: front || behind ? { right: { front: front?.left ?? null, back: behind?.right ?? null }, left: { front: front?.right ?? null, back: behind?.left ?? null } } : null
  }
  if (spec === "jacket") {
    const map = await print.readDressPhoto(FRONT, {})
    if (map) { item.photoMap = { image: map.image, soft: map.soft, layout: map.layout, color: map.color }; item.print = null }
  }
  // ?redrape=on: the photos laid on point for point after the drape, as the page does (stage.js#advanceRedrape).
  const redrape = new URL(import.meta.url).searchParams.get("redrape") === "on"
  // (As the page does: none for a low-contrast print all over, see fitting_room_controller.js#render.)
  if (redrape && !item.print?.mottled) Object.assign(item, { photo: FRONT, back_photo: BACK, photoPart: null })
  stage.setOutfit([item])
  const deadline = Date.now() + 300000
  while (Date.now() < deadline) {
    stage.advanceDrape(); stage.advanceRedrape?.()
    await new Promise(r => setTimeout(r, 0))
    const d = Object.values(stage.slots).find(Boolean)
    if (stage.settled && (!item.photo || ["done", "off"].includes(d?.redrapeState))) { details.redrape = d?.redrapeState; break }
  }
  return details
}
