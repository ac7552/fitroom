// For render.mjs --script: the two real Kith listings (their shop photos in tmp/kith, served at /kith/, not in
// the repo), read through print.js the way the page does, on the women's example body: the Adley shrunken
// sweater hoodie over the by Parra sweatpants (with the photo laid on).
// Query ?spec=after (default) dresses them as the import now reads them: a fitted knit zip hoodie, size M.
// ?spec=before is what the import used to make of the hoodie (a cotton zip jacket, size XL), to compare.
// Exports default(stage) -> details.
const HOODIE = "/kith/kith-women-adley-shrunken-multi-sweater-hoodie-legacy-garment.jpg"
const PANTS = "/kith/by-parra-sporte-sweatpant-heather-grey-garment.jpg"
// From tmp/kith/garments.json (Kith's chart, in cm).
const SIZES = {
  M: { chest: 86.36, shoulders: 38.1, sleeve: 65.72, length: 52.71 },
  XL: { chest: 99.06, shoulders: 41.28, sleeve: 67.95, length: 56.52 }
}
const PANTS_XS = { waist: 71, seat: 105, thigh: 63, inseam: 81, leg_opening: 26 }

export default async function (stage, spec = new URL(import.meta.url).searchParams.get("spec") ?? "after") {
  const print = window.print
  const details = { spec }
  const pants = await print.readBottomPhoto(PANTS)
  details.pants = { color: pants?.color, layout: Boolean(pants?.layout) }
  // The page passes the chart's shape (length over the front's width) to find the hem: the middle size's.
  const read = await print.readPhoto(HOODIE, { shape: SIZES.M.length / (SIZES.M.chest / 2) })
  details.hoodie = { color: read?.color, print: Boolean(read?.print), coverage: read?.print?.coverage, stripes: Boolean(read?.print?.stripes) }
  const photoSize = { chest: SIZES.M.chest, length: SIZES.M.length }
  const hoodie = spec === "before"
    ? { kind: "jacket", style: "zip", fabric: "cotton", color: read?.color ?? "#d9d7c6", size: SIZES.XL, print: read?.print ?? null, photoSize }
    : { kind: "top", style: "hoodie", fabric: "knit", zip: true, cut: { fit: "fitted", stretch: true }, color: read?.color ?? "#d9d7c6",
        size: SIZES.M, print: read?.print ?? null, photoSize }
  stage.setOutfit([
    { kind: "trousers", style: "joggers", fabric: "cotton", color: pants?.color ?? "#9fa3ab", size: PANTS_XS,
      photoMap: pants ? { image: pants.image, soft: pants.soft, layout: pants.layout, back: null } : null },
    hoodie
  ])
  const deadline = Date.now() + 300000
  while (!stage.settled && Date.now() < deadline) {
    stage.advanceDrape()
    stage.fitTuck?.()
    await new Promise(r => setTimeout(r, 0))
  }
  return details
}
