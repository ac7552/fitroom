// For render.mjs --script: any top from its shop photos, read and laid on as the page does (print.js's
// readPhoto, then ?redrape=on the photos re-draped point for point). ?front=URL&back=URL&style=&fabric=; with
// no front, Kith's Daily Paper camo zip hoodie (daily_paper.mjs's photos).
const P = new URL(import.meta.url).searchParams, FRONT = P.get("front") ?? "/kith/dp-front.png", BACK = P.has("front") ? P.get("back") : "/kith/dp-back.png"
const SIZE = { chest: 124, shoulders: 58, sleeve: 60, length: 68 }   // a boxy M (the shop gives no chart)
export default async function (stage, spec = new URL(import.meta.url).searchParams.get("spec") ?? "top") {
  const print = window.print
  const read = await print.readPhoto(FRONT, { shape: SIZE.length / (SIZE.chest / 2) })
  const back = BACK ? await print.readPhoto(BACK) : null
  const details = { spec, color: read?.color, print: Boolean(read?.print), allOver: Boolean(read?.print?.tile), backPrint: Boolean(back?.print), backCoverage: back?.print?.coverage }
  const front = read?.sleeves, behind = back?.sleeves
  const item = {
    kind: spec === "jacket" ? "jacket" : "top", style: P.get("style") ?? (spec === "jacket" ? "zip" : "hoodie"), zip: !P.has("style"), fabric: P.get("fabric") ?? "fleece",
    color: read?.color ?? "#6b6450", photoCloth: P.get("meter") === "off" ? null : read?.color ?? null, size: SIZE, photoSize: { chest: SIZE.chest, length: SIZE.length },
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
  if (redrape && !item.print?.mottled) Object.assign(item, { photo: FRONT, back_photo: BACK ?? null, photoPart: null })
  stage.setOutfit([item])
  const deadline = Date.now() + (Number(P.get("deadline")) || 300000)
  while (Date.now() < deadline) {
    stage.advanceDrape(); stage.advanceRedrape?.()
    await new Promise(r => setTimeout(r, 0))
    const d = Object.values(stage.slots).find(Boolean)
    if (stage.settled && (!item.photo || ["done", "off"].includes(d?.redrapeState)) && (!item.photoCloth || (d?.metered && !d.metering))) { details.redrape = d?.redrapeState; details.meter = await stage.meterReport("top"); details.plain = d?.trust?.plain; details.far = d?.trust?.far; details.rigid = d?.rigid; details.apart = window.sleevesApartOf ?? null; break }
  }
  const d = Object.values(stage.slots).find(Boolean)
  if (Date.now() >= deadline) details.timeout = { metered: d?.metered ?? null, metering: Boolean(d?.metering), shown: d?.shown, done: d?.top?.done, posing: Boolean(d?.posing), redrape: d?.redrapeState ?? null, photoCloth: item.photoCloth ?? null, settled: stage.settled }
  return details
}
