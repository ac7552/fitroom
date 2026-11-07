// How well photo_roles.js tells a listing's photos apart, on the Kith sample's labelled photos
// (kith_20261107/photo_roles.json), and the examples it ships (photo_role_examples.js) built from them.
// Development only, in the page at http://localhost:3000 after the crawl (public/validation/roles_crawl.js),
// served from public/validation/:
//
//   const E = await import("/validation/photo_roles_eval.js")
//   E.evaluate()              // leave-one-listing-out: each listing's photos against the others' examples
//   E.pack({ perRole: 24 })   // the examples to ship, as photo_role_examples.js's EXAMPLES
const R = await import("lib/garments/photo_roles")
const P = await import("lib/garments/print")
const LETTER = { F: "flat_front", B: "flat_back", M: "on_model", C: "closeup", S: "sole", A: "angled", P: "pair", V: "view", T: "tag", O: "other" }
const truth = await fetch(`/validation/photo_roles_truth.json?v=${Date.now()}`).then(r => r.json())
const SHOE = /^f[mw]_/
const crawl = window.CRAWL
const listings = () => {
  const seen = new Set(), out = []
  for (const p of Object.values(crawl.products)) {
    if (seen.has(p.handle) || !truth.roles[p.handle]) continue
    seen.add(p.handle)
    // A listing is shoes by its group, or the person's links by the photos' labels.
    const shoe = SHOE.test(p.group) || /[SAPV]/.test(truth.roles[p.handle])
    out.push({ ...p, shoe, roles: [...truth.roles[p.handle]].map(c => LETTER[c]) })
  }
  return out
}

// Examples packed as photo_role_examples.js holds them, from [{ emb, role }].
export function packRows(rows, roles = R.ROLE_NAMES) {
  const dims = rows[0].emb.length
  const bytes = new Uint8Array(rows.length * dims)
  rows.forEach((r, e) => { const u = R.unit(r.emb); for (let d = 0; d < dims; d++) bytes[e * dims + d] = Math.max(-127, Math.min(127, Math.round(u[d] * 127))) & 255 })
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b)
  // (Each example's listing: 0 a garment's, 1 a shoe's.)
  return { dims, count: rows.length, roles, labels: rows.map(r => roles.indexOf(r.role)), shoes: rows.map(r => (r.shoe ? 1 : 0)), data: btoa(bin) }
}

function rowsOf(list) {
  return list.flatMap(p => p.images.map((im, i) => ({ emb: im.emb, u: im.emb && (im.u ??= R.unit(im.emb)), role: p.roles[i], handle: p.handle, shoe: p.shoe })).filter(r => r.emb && r.role))
}

// Each listing's photos read with the others' examples (or with `examples` for all), words and measurements
// as given: { photos, confusion, picks: { front, back, closeup, side } }.
// The garment's colour in each photo (print.js's traits, from the crawl's small copy), for the back's check.
export async function colours() {
  for (const p of Object.values(crawl.products)) for (const im of p.images) if (im.thumb && !im.colour) im.colour = (await P.readPhotoTraits(im.thumb).catch(() => null))?.colour ?? null
}
const gap = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : 0)
export function evaluate({ words = true, summaries = true, traits = true, examples = null, k = 7, perRole = null, centroids = null } = {}) {
  const list = listings(), all = rowsOf(list)
  const confusion = {}, picks = { front: [0, 0], frontWorn: 0, frontBad: [], backBad: [], closeBad: [], sideBad: [], sideMissed: [] }
  let right = 0, total = 0
  for (const p of list) {
    const rest = all.filter(r => r.handle !== p.handle)
    const ex = examples ?? (centroids ? packRows(centroidRows(rest, centroids)) : perRole ? packRows(spread(rest, perRole)) : packRows(rest))
    const photos = p.images.map(im => ({ image: words ? { src: im.src, alt: im.alt } : { src: "x.jpg", alt: "" }, traits: traits ? im.traits : null, summary: summaries ? im.emb : null }))
    const read = R.photoRoles(photos, { shoe: p.shoe, examples: ex })
    read.forEach((r, i) => {
      const t = p.roles[i]
      confusion[t] ??= {}; confusion[t][r.role] = (confusion[t][r.role] ?? 0) + 1
      total++; if (r.role === t) right++
    })
    const pk = R.pickPhotos(read)
    const front = pk.front ?? 0
    picks.front[1]++
    const hasFlat = p.roles.includes("flat_front")
    if (p.roles[front] === "flat_front" || (!hasFlat && pk.front == null)) picks.front[0]++
    else picks.frontBad.push(`${p.handle}:${front}${p.roles[front]?.[0] ?? "?"}/${read.map(r => r.role.slice(0, 2)).join(",")}`)
    // The first back candidate the shape check would see must be a back (the shape check is run on photos in
    // the page, not here: a candidate that's on a model or a close-up is the miss).
    const foreign = truth.foreign?.[p.handle] ?? []
    const back = pk.backs.find(i => p.images[i].traits?.garment && p.images[i].traits.touches === 0 && gap(p.images[i].colour, p.images[front]?.colour) <= 22)
    if (!p.shoe && back != null && (p.roles[back] !== "flat_back" || foreign.includes(back))) picks.backBad.push(`${p.handle}:${back}${p.roles[back][0]}`)
    for (const i of pk.closeups) if (p.roles[i] !== "closeup") picks.closeBad.push(`${p.handle}:${i}${p.roles[i][0]}`)
    // A shoe's side is read from the first photo read as flat_front (the controller's readShoePhotos): one
    // that isn't its side is a miss, and so is none at all while it has one (the shoe goes without).
    if (p.shoe) {
      const side = read.findIndex(r => r.role === "flat_front")
      if (side >= 0 && p.roles[side] !== "flat_front") picks.sideBad.push(`${p.handle}:${side}${p.roles[side]}`)
      if (side < 0 && p.roles.includes("flat_front")) picks.sideMissed.push(`${p.handle}/${read.map(r => r.role.slice(0, 2)).join(",")}`)
    }
  }
  return { photos: `${right}/${total} (${(100 * right / total).toFixed(1)}%)`, front: `${picks.front[0]}/${picks.front[1]}`, frontBad: picks.frontBad, backBad: picks.backBad, closeBad: picks.closeBad.length, closeBadList: picks.closeBad.slice(0, 20), sideBad: picks.sideBad, sideMissed: picks.sideMissed, confusion }
}

// The examples to ship: per role, up to perRole photos spread over the sample (farthest-first from the role's
// mean, so the odd ones are in it too), as photo_role_examples.js's EXAMPLES.
export function pack({ perRole = 24, centroids = null } = {}) {
  const rows = rowsOf(listings())
  return packRows(centroids ? centroidRows(rows, centroids) : spread(rows, perRole))
}
function spread(rows, perRole) {
  const chosen = []
  for (const role of R.ROLE_NAMES) {
    const of = rows.filter(r => r.role === role).map(r => ({ ...r, u: r.u ?? R.unit(r.emb) }))
    if (!of.length) continue
    const pick = [of[0]]
    const dist = of.map(r => 1 - dot(r.u, of[0].u))
    while (pick.length < Math.min(perRole, of.length)) {
      let far = 0
      for (let i = 1; i < of.length; i++) if (dist[i] > dist[far]) far = i
      pick.push(of[far])
      of.forEach((r, i) => { dist[i] = Math.min(dist[i], 1 - dot(r.u, of[far].u)) })
    }
    chosen.push(...pick)
  }
  return chosen
}
// k centroids a role (spherical k-means from a spread start), as examples.
function centroidRows(rows, k) {
  const out = []
  // A garment's photos and a shoe's apart: a shoe from the side and a tee laid flat are both flat_front.
  for (const shoe of [false, true]) for (const role of R.ROLE_NAMES) {
    const of = rows.filter(r => r.role === role && Boolean(r.shoe) === shoe).map(r => ({ ...r, u: r.u ?? R.unit(r.emb) }))
    if (!of.length) continue
    let centres = spread(of, k).map(r => Float32Array.from(r.u))
    for (let it = 0; it < 8; it++) {
      const sums = centres.map(c => new Float32Array(c.length))
      for (const r of of) { let best = 0, bd = -2; centres.forEach((c, j) => { const d = dot(c, r.u); if (d > bd) { bd = d; best = j } }); for (let d = 0; d < r.u.length; d++) sums[best][d] += r.u[d] }
      centres = sums.map((s, j) => (s.some(Boolean) ? R.unit(s) : centres[j]))
    }
    out.push(...centres.map(c => ({ emb: Array.from(c), role, shoe })))
  }
  return out
}
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }
export default { evaluate, pack, packRows, colours }

// The photo choice before photo_roles.js (the controller's garmentPhotoIndex and readBackPhoto of 6 November),
// on the same labels, for the record: the front, and the first back it would try. Garments only (a shoe's
// front was its first photo, and its side the first photo after that its outline reader took).
export function before() {
  const list = listings().filter(p => !p.shoe)
  const words = im => `${im.alt ?? ""} ${String(im.src ?? "").split("/").pop().split("?")[0].replace(/[-_.]+/g, " ")}`
  const ofBack = im => /\b(?:from|of) the back\b|\bback (?:view|side|shot)\b|\bfrom behind\b|\brear view\b|\bshown (?:from )?(?:the )?back\b/i.test(im.alt ?? "") || /(?:^|[-_ ])back(?:[-_ .]|$)/i.test(String(im.src).split("/").pop().split("?")[0])
  const out = { front: [0, list.length], frontBad: [], backBad: [], picks: {} }
  for (const p of list) {
    const first = p.images.slice(0, 6), back = first.map(ofBack), allowed = i => !back[i] || back.every(Boolean)
    let front = first.findIndex((im, i) => allowed(i) && /\bfront\b/i.test(words(im)) && !/\b(?:on|worn|model)\b/i.test(im.alt ?? ""))
    if (front < 0) front = first.findIndex((im, i) => allowed(i) && im.traits?.garment && im.traits.touches === 0 && im.traits.skin < 0.01)
    if (front < 0) front = first.findIndex((im, i) => allowed(i) && im.traits?.garment && im.traits.touches === 0 && im.traits.skin < 0.05)
    if (front < 0) front = Math.max(0, first.findIndex((_, i) => allowed(i)))
    if (p.roles[front] === "flat_front") out.front[0]++
    else out.frontBad.push(`${p.handle}:${front}${p.roles[front]}`)
    const rest = p.images.map((im, i) => i).filter(i => i !== front).slice(0, 5)
    const named = rest.find(i => ofBack(p.images[i]))
    const b = named ?? rest.find(i => p.images[i].traits?.garment && p.images[i].traits.touches === 0)
    if (b != null && p.roles[b] !== "flat_back") out.backBad.push(`${p.handle}:${b}${p.roles[b]}`)
    out.picks[p.handle] = { front, back: b ?? null }
  }
  return out
}
