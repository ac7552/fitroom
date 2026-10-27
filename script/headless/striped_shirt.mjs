// For render.mjs --script: reads a striped shirt's shop photo through print.js the way the page does and
// dresses the mannequin in it. Default: the synthetic fixture test/fixtures/files/photos/striped-shirt-front.jpg
// (faint vertical stripes, see make_striped_shirt.py) as a short-sleeve button-up for the men's example body.
// Query ?photo=/kith/...jpg&style=shirt picks another photo or style. Exports default(stage) -> details.
const SIZE = { chest: 116, shoulders: 48, sleeve: 24, length: 74 }

export default async function (stage) {
  const params = new URL(import.meta.url).searchParams
  const photo = params.get("photo") ?? "/fixtures/photos/striped-shirt-front.jpg"
  const style = params.get("style") ?? "shortshirt"
  const size = style === "shirt" ? { ...SIZE, sleeve: 64 } : SIZE
  const read = await window.print.readPhoto(photo, { shape: size.length / (size.chest / 2) })
  const details = {
    color: read?.color, print: Boolean(read?.print), coverage: read?.print?.coverage,
    stripes: Boolean(read?.print?.stripes), vertical: Boolean(read?.print?.vertical), across: read?.print?.stripAcross ?? null
  }
  stage.setOutfit([{ kind: "top", style, fabric: "cotton", color: read?.color ?? "#c6d3e4", size, print: read?.print ?? null, photoSize: size }])
  const deadline = Date.now() + 300000
  while (!stage.settled && Date.now() < deadline) {
    stage.advanceDrape()
    stage.fitTuck?.()
    await new Promise(r => setTimeout(r, 0))
  }
  return details
}
