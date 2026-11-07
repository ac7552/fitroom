// For render.mjs --script: what shoeSide reads off a photo. ?photo=URL.
export default async function () {
  const P = new URL(import.meta.url).searchParams
  const read = await window.print.readShoe(P.get("photo"))
  const { measureSide } = await import("lib/garments/lasts")
  const s = read?.side
  if (!s) return { side: null }
  const pick = list => list.filter((_, i) => i % 4 === 0).map(v => +v.toFixed(3))
  return { left: s.left, right: s.right, height: s.height, toeRight: s.toeRight, top: pick(s.top), bottom: pick(s.bottom), sole: pick(s.sole), profile: s.soleProfile && pick(s.soleProfile), measured: measureSide(s) }
}
