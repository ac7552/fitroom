// For render.mjs --script: shoes on the mannequin from a side photo, read as the page reads it (print.js's
// readShoe) and lofted from its last (lasts.js). ?photo=URL (default: the fixture boot), ?style=boot|sneaker|
// loafer|sandal|hightop (photo=none: from the style and words alone), ?words=... (the listing's words, for the family), ?name=...
// Returns the last's family and params, and the side reading's sole profile.
export default async function (stage) {
  const P = new URL(import.meta.url).searchParams
  const photo = P.get("photo") ?? "/fixtures/photos/beige-boot-side.jpg"
  const style = P.get("style") ?? "boot"
  const print = window.print
  const { lastFor, measureSide } = await import("lib/garments/lasts")
  const read = photo === "none" ? null : await print.readShoe(photo)
  const words = P.get("words") ?? P.get("name") ?? ""
  const last = lastFor(words, style, read?.side)
  stage.setOutfit([
    { kind: "top", style: "tee", size: { chest: 106, shoulders: 47, sleeve: 21, length: 72 }, color: "#b33a3a", fabric: "cotton" },
    { kind: "shoes", style, fabric: P.get("fabric") ?? "leather", color: read?.color ?? "#c9a66b", sole: read?.sole ?? null, collar: read?.collar ?? null,
      size: {}, name: P.get("name") ?? "", words, shoeSide: read?.side ?? null, shoePhoto: read?.side ? photo : null, shoeViews: [] }
  ])
  const deadline = Date.now() + 240000
  while (!stage.settled && Date.now() < deadline) { stage.advanceDrape(); await new Promise(r => setTimeout(r, 0)) }
  for (let i = 0; i < 30; i++) { stage.draw(); await new Promise(r => setTimeout(r, 50)) }
  const m = measureSide(read?.side)
  const rise = stage.feet.rise && { angle: +stage.feet.rise.angle.toFixed(3), lift: +stage.feet.rise.lift.toFixed(4) }
  const THREE = await import("three")
  const box = stage.feet.shoes.L && new THREE.Box3().setFromObject(stage.feet.shoes.L)
  const ankle = stage.model.getObjectByName("foot_l")?.getWorldPosition(new THREE.Vector3())
  let toe = null
  if (stage.feet.shoes.L) {
    const m = stage.feet.shoes.L, p = m.geometry.attributes.position
    let best = -1, bi = 0
    for (let i = 0; i < p.count; i++) if (p.getZ(i) > best) { best = p.getZ(i); bi = i }
    const flat = new THREE.Vector3().fromBufferAttribute(p, bi), world = flat.clone().applyMatrix4(m.matrixWorld)
    const q = m.getWorldQuaternion(new THREE.Quaternion())
    let lowY = Infinity, li = 0
    for (let i = 0; i < p.count; i++) { const wy = new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld).y; if (wy < lowY) { lowY = wy; li = i } }
    const lowFlat = new THREE.Vector3().fromBufferAttribute(p, li)
    toe = { low: [+lowY.toFixed(4), ...lowFlat.toArray().map(v => +v.toFixed(4))], stems: stage.feet.meshes.length, flat: flat.toArray().map(v => +v.toFixed(4)), world: world.toArray().map(v => +v.toFixed(4)), pitch: +(2 * Math.atan2(q.x, q.w)).toFixed(3), qyz: [+q.y.toFixed(3), +q.z.toFixed(3)] }
  }
  const where = box && { toe, shoeY: [+box.min.y.toFixed(4), +box.max.y.toFixed(4)], shoeZ: [+box.min.z.toFixed(4), +box.max.z.toFixed(4)], ankle: ankle && [+ankle.y.toFixed(4), +ankle.z.toFixed(4)], modelY: +stage.model.position.y.toFixed(4) }
  return { family: last.family, rise, where, params: Object.fromEntries(Object.entries(last.params).map(([k, v]) => [k, typeof v === "number" ? +v.toFixed(4) : v])), measured: m && { sole: m.sole, collar: m.collar, taper: +m.taper.toFixed(3), heelRise: +m.heelRise.toFixed(3) }, profile: read?.side?.soleProfile?.map(v => +v.toFixed(2)) }
}
