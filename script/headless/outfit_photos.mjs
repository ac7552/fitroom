// For render.mjs --script: reads the fixture shop photos through print.js the way the page does, and dresses the
// mannequin in sweatpants (with the photo laid on), a striped hoodie (with its print) and beige boots.
// Query ?parts=pants,hoodie,boots picks which; default all. Exports default(stage) -> details.
export default async function (stage, parts = (new URL(import.meta.url).searchParams.get("parts") ?? "pants,hoodie,boots").split(",")) {
  const print = window.print
  const items = []
  const details = {}
  if (parts.includes("pants")) {
    const read = await print.readBottomPhoto("/fixtures/photos/sweatpants-front.jpg")
    details.pants = { color: read?.color, layout: Boolean(read?.layout) }
    items.push({
      kind: "trousers", style: "joggers", fabric: "fleece", color: read?.color ?? "#9a9a9a",
      size: { waist: 84, seat: 108, thigh: 66, inseam: 74, leg_opening: 30, rise: 30 },
      photoMap: read ? { image: read.image, soft: read.soft, layout: read.layout, back: null } : null
    })
  }
  if (parts.includes("hoodie")) {
    const read = await print.readPhoto("/fixtures/photos/striped-hoodie-front.jpg", { shape: null })
    details.hoodie = { color: read?.color, print: Boolean(read?.print), coverage: read?.print?.coverage }
    items.push({
      kind: "top", style: "hoodie", fabric: "knit", color: read?.color ?? "#2a6b3f", zip: true,
      size: { chest: 104, shoulders: 46, sleeve: 62, length: 58 },
      print: read?.print ?? null, photoSize: { chest: 104, length: 58 }
    })
  }
  if (parts.includes("boots")) {
    const read = await print.readShoe("/fixtures/photos/beige-boot-side.jpg")
    details.boots = { color: read?.color, sole: read?.sole, side: Boolean(read?.side) }
    items.push({
      kind: "shoes", style: "boot", fabric: "leather", color: read?.color ?? "#c9a66b", sole: read?.sole ?? null, collar: read?.collar ?? null,
      size: {}, shoeSide: read?.side ?? null, shoePhoto: read?.side ? "/fixtures/photos/beige-boot-side.jpg" : null, shoeViews: []
    })
  }
  stage.setOutfit(items)
  const deadline = Date.now() + 300000
  while (!stage.settled && Date.now() < deadline) {
    stage.advanceDrape()
    stage.fitTuck?.()
    await new Promise(r => setTimeout(r, 0))
  }
  // Shoe photos load after the drape.
  await new Promise(r => setTimeout(r, 1500))
  return details
}
