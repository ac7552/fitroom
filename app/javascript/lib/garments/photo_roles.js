// Every photo of a listing gets a role before anything is read from it (docs/plan-2026-11-accuracy.md, 3.1):
//
//   flat_front  the garment on its own, laid out or hung, from the front (a shoe: from the side, standing)
//   flat_back   the garment on its own from behind
//   on_model    someone wearing it
//   closeup     its cloth or a detail filling the frame (a pocket, a collar, a print)
//   sole        a shoe's underside
//   angled      a shoe from an angle (three-quarter on, or from above at a slant)
//   pair        a pair of shoes crossed, stacked or one behind the other
//   view        a shoe square on from above, behind or in front (print.js's shoeView reads these)
//   tag         a size or care label
//   other       anything else (a box, a bag, several things together)
//
// From three readings, any of which can be missing: what the shop says the photo is (its alt text and file
// name), what's measured in it (print.js's photoTraits: does the garment stand clear of a plain backdrop, is
// there skin, is it words on a label), and which of a few labelled example photos it's most like to DINOv2
// (likeness.js's photoSummary; the examples, from the Kith sample of 7 November, in photo_role_examples.js).
// A wrong guess in the photo tray is changed by hand; a photo whose role was set by hand keeps it.

import { EXAMPLES } from "lib/garments/photo_role_examples"

export const ROLE_NAMES = ["flat_front", "flat_back", "on_model", "closeup", "sole", "angled", "pair", "view", "tag", "other"]

// The tray's names for them (what a person picks from).
export const ROLES = { flat_front: "Front", flat_back: "Back", on_model: "Worn", closeup: "Close-up", tag: "Size tag", sole: "Sole", angled: "Angled", pair: "Pair", view: "Top or end", other: "Other" }

// The roles a shoe's photos take, and a garment's: a garment's photos are never soles or pairs, a shoe's
// never flat backs (its heel square on is a view).
const SHOE_ROLES = ["flat_front", "on_model", "closeup", "sole", "angled", "pair", "view", "tag", "other"]
const GARMENT_ROLES = ["flat_front", "flat_back", "on_model", "closeup", "tag", "other"]

// The old kinds (front, back, closeup, tag, worn, other), which the readers and the server knew, onto roles.
export const OLD_ROLE = { front: "flat_front", back: "flat_back", worn: "on_model", closeup: "closeup", tag: "tag", other: "other" }

// One photo's kind from its traits alone, as before: "worn" (skin that isn't the garment's colour), "tag" (a
// frame of small dark-on-light words, filling the frame or small in it), "closeup" (cloth filling the frame),
// or "garment" (a full shot, clear of its backdrop). Skin alone misses a model in dark clothes or with darker
// skin, and calls a tan plaid worn: photoRoles below holds it to the examples too.
export function photoKind(traits) {
  if (!traits) return "garment"
  if (traits.skin > 0.03) return "worn"
  const wordy = traits.busy > 0.05 && traits.dark > 0.04 && traits.light > 0.2
  if (!traits.garment) return wordy ? "tag" : "closeup"
  if (traits.fills < 0.3 && wordy) return "tag"
  return "garment"
}

// What the shop's words for a photo say it is: { role: weight } for the roles they name (weight 1 is sure,
// less is a hint). Its alt text first; its file name's words ("…-Front.jpg", "…-BACK.jpg") as hints. Shops
// describe photos at length, so a role is read only from how photos are described ("Back view of",
// "Model wearing", "Close-up of", "on a hanger"), never from a garment's parts ("zip front", "back pocket").
// others: the listing's other photos' file names, so a word every one of them carries ("Detail") says nothing.
export function wordsRole(image, { shoe = false, others = [] } = {}) {
  const alt = String(image?.alt ?? "").replace(/\s+/g, " ").trim()
  const out = {}
  const say = (role, weight) => { out[role] = Math.max(out[role] ?? 0, weight) }
  if (alt) {
    if (WORN.test(alt)) say("on_model", 1)
    if (CLOSE.test(alt)) say("closeup", 1)
    // "Back view" is which way round, not whether it's worn: a back view on a hanger is the back; one of a
    // model from behind is on_model (the examples say which).
    const flat = FLAT.test(alt)
    if (BACK.test(alt) && !shoe) say("flat_back", out.closeup ? 0.3 : flat ? 0.95 : 0.5)
    if (FRONT.test(alt)) say("flat_front", flat ? 0.9 : 0.5)
    // On a hanger or laid flat says it's on its own, not which way round.
    if (flat && !out.on_model && !out.closeup && !out.flat_back && !out.flat_front) { say("flat_front", 0.6); say("flat_back", 0.6) }
    if (TAG.test(alt)) say("tag", 0.8)
    if (BOXED.test(alt)) say("other", 0.8)
    if (shoe) {
      if (SOLE.test(alt)) say("sole", 1)
      if (ANGLED.test(alt)) say("angled", 0.8)
      if (VIEW.test(alt)) say("view", 0.8)
      if (SIDE.test(alt)) say("flat_front", 0.8)
      if (PAIR.test(alt) && !out.view && !out.sole) say("pair", 0.6)
    }
  }
  // The file's own words, when its listing's other files don't all share them.
  const words = fileWords(image?.src)
  // ("Detail" only says something beside other photos that aren't called it: some shops call every photo so.)
  const common = word => (word === "detail" && others.length < 2) || (others.length > 1 && others.every(src => fileWords(src).includes(word)))
  for (const [word, role, weight] of FILE_WORDS) {
    if (!words.includes(word) || common(word)) continue
    if (role === "flat_back" && shoe) continue
    if (role === "sole" && !shoe) continue
    say(role, weight)
  }
  return out
}

const WORN = /^(?:a |an |the )?(?:models?|man|men|woman|women|person|people|guy|girl|boy|kid|child)\b(?!['’]s)|\b(?:models?|man|woman|person|guy|girl|boy)\b(?: [\w'’,-]+){0,6} (?:wearing|wears|dressed in|sporting)\b|\bworn (?:by|on)\b|\bon (?:a |the )?models?\b|\bmodell?ed\b|\bon[- ]body\b|\bon[- ]figure\b/i
const CLOSE = /\bclose[- ]?ups?\b|\bdetail(?:ed)? (?:view|shot)s?\b|\bmacro\b|\bzoomed[- ]in\b|\bclose view\b/i
const BACK = /\b(?:back|rear) views?\b|\b(?:viewed|seen|shown|photographed|laid|lying|displayed|hung|hanging|pictured)(?: flat| out)? from (?:the )?(?:back|behind|rear)\b|\bview from (?:the )?(?:back|behind|rear)\b|\bfrom behind\b|^(?:the )?(?:back|rear) (?:of|side)\b|\bback side\b|,\s*back view\b/i
const FRONT = /\bfront views?\b|\bviewed? from the front\b|\b(?:shown|seen|photographed|laid flat|displayed) from the front\b/i
const FLAT = /\bon (?:(?:a|an|the|its|black|white|wooden|wood|metal|matching) )*hangers?\b|\bhung\b|\bhanging\b|\blaid (?:out )?flat\b|\bflat[- ]?lay\b|\bshown flat\b|\blaid out\b|\blying flat\b|\bdisplayed (?:flat|on)\b|\bon a (?:mannequin|dress form|form)\b/i
const TAG = /\b(?:size|care|wash(?:ing)?|content) (?:tags?|labels?)\b|\bhang ?tags?\b/i
const BOXED = /\bgift box\b|\b(?:shoe ?)?box(?:es)?\b(?= with| showing| and| for| containing)|\bdust ?bags?\b|\bpackaging\b/i
// Several garments in one photo (a three-pack of tees): photoRoles marks it `several`.
export const SEVERAL = /\b(?:two|three|four|five|six|2|3|4|5|6)[- ]?(?:pack|pk)s?\b|\b(?:two|three|four|five|six) (?:[\w-]+ ){0,3}(?:t-shirts|tees|shirts|undershirts|tanks|briefs|boxers|socks)\b/i
const SOLE = /\b(?:out)?soles? (?:view|shown|up|facing)\b|\bunderside\b|\bbottom (?:view|of the (?:shoe|sneaker|boot|sandal|sole)s?)\b|\bview of (?:the |its |their )?(?:out)?soles?\b|\b(?:tread|traction|lug) pattern\b|\bupside[- ]down\b|^(?:the )?(?:out)?soles? of\b/i
const ANGLED = /\bthree[- ]quarters?\b|\bangled\b|\bat an angle\b|\b3\/4\b/i
const VIEW = /\btop[- ]down\b|\bfrom above\b|\boverhead\b|\bbird['’]?s[- ]eye\b|\bheel (?:view|counter view)\b|\bfrom (?:the )?heel\b|\btoe (?:view|on)\b|\bhead[- ]on\b|\bfrom (?:the )?front\b|\bfrom behind\b/i
const SIDE = /\bside (?:view|profile)\b|\bin profile\b|\bprofile view\b|\b(?:shown|seen|viewed|photographed|pictured) (?:from|in) (?:the )?side\b|\b(?:lateral|medial|outer|inner|outside|inside) (?:side|view|profile)\b/i
const PAIR = /^(?:a |the )?pair of\b|\bpairs? (?:shown|seen|placed|side by side|crossed|stacked)\b|\bside by side\b|\bcrossed over\b/i
const FILE_WORDS = [["front", "flat_front", 0.6], ["back", "flat_back", 0.6], ["rear", "flat_back", 0.6], ["detail", "closeup", 0.35], ["closeup", "closeup", 0.6],
  ["sole", "sole", 0.6], ["bottom", "sole", 0.4], ["model", "on_model", 0.6], ["worn", "on_model", 0.6], ["onbody", "on_model", 0.6], ["tag", "tag", 0.4], ["label", "tag", 0.4]]

function fileWords(src) {
  const name = String(src ?? "").split("/").pop().split("?")[0].replace(/\.[a-z0-9]+$/i, "")
  // Shopify's de-duplicating suffix (…_9ad34ef2-c392-4424-…) isn't words.
  return name.replace(/_[0-9a-f]{8}-[0-9a-f-]{20,}$/i, "").toLowerCase().split(/[^a-z]+/).filter(Boolean)
}

// The examples' likeness to a photo's summary (an array of 384 numbers): { role: share } over the roles
// allowed, from its nearest examples, or null without a summary. Each of the k nearest votes for its role,
// the nearer the more.
export function exampleRole(summary, { allowed = ROLE_NAMES, k = 7, examples = EXAMPLES, shoe = null } = {}) {
  if (!summary || !examples?.count) return null
  const near = nearest(summary, examples, k, allowed, shoe)
  if (!near.length) return null
  const best = near[0].similarity
  const votes = {}
  for (const { role, similarity } of near) votes[role] = (votes[role] ?? 0) + Math.exp((similarity - best) / 0.03)
  const total = Object.values(votes).reduce((a, b) => a + b, 0)
  return Object.fromEntries(Object.entries(votes).map(([role, v]) => [role, v / total]))
}

const unpackedOf = new WeakMap()
function nearest(summary, examples, k, allowed, shoe) {
  if (!unpackedOf.has(examples)) unpackedOf.set(examples, unpack(examples))
  const unpacked = unpackedOf.get(examples)
  const q = unit(summary)
  const keep = new Set(allowed)
  const out = []
  for (let e = 0; e < unpacked.roles.length; e++) {
    if (!keep.has(unpacked.roles[e])) continue
    // A shoe's photos are held to shoes' examples, a garment's to garments' (when the examples say which).
    if (shoe != null && unpacked.shoes && unpacked.shoes[e] !== (shoe ? 1 : 0)) continue
    let dot = 0
    const row = unpacked.vectors.subarray(e * unpacked.dims, (e + 1) * unpacked.dims)
    for (let d = 0; d < unpacked.dims; d++) dot += q[d] * row[d]
    out.push({ role: unpacked.roles[e], similarity: dot })
  }
  return out.sort((a, b) => b.similarity - a.similarity).slice(0, k)
}

// The examples as packed in photo_role_examples.js: unit vectors at 8 bits a number (base64), each row's role
// as an index into roles, and whether it's a shoe's photo (shoes: 1) or a garment's (0).
export function unpack(examples) {
  const bytes = typeof atob === "function" ? Uint8Array.from(atob(examples.data), c => c.charCodeAt(0)) : new Uint8Array(Buffer.from(examples.data, "base64"))
  const dims = examples.dims, count = examples.count
  const vectors = new Float32Array(dims * count)
  for (let i = 0; i < dims * count; i++) vectors[i] = ((bytes[i] << 24) >> 24) / 127
  for (let e = 0; e < count; e++) {
    let n = 0
    for (let d = 0; d < dims; d++) n += vectors[e * dims + d] ** 2
    n = Math.sqrt(n) || 1
    for (let d = 0; d < dims; d++) vectors[e * dims + d] /= n
  }
  return { dims, vectors, roles: Array.from(examples.labels, i => examples.roles[i]), shoes: examples.shoes ?? null }
}

export function unit(v) {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  return Float32Array.from(v, x => x / n)
}

// What the measurements say, as a factor on each role's likelihood: a photo with no garment standing clear of
// a plain backdrop is a close-up (or a label), not a front; one with words on a light label is a tag; skin
// that isn't the garment's colour is a little more likely someone wearing it.
export function traitsFactor(traits, roles, { shoe = false } = {}) {
  const f = Object.fromEntries(roles.map(r => [r, 1]))
  if (!traits) return f
  const wordy = traits.busy > 0.05 && traits.dark > 0.04 && traits.light > 0.2
  const standing = traits.garment && traits.touches <= 1
  // A shoe too small in the frame to cut out (a thin sandal from the side) runs off no edge and leaves the
  // frame nearly all backdrop: that's no close-up. (Cloth filling the frame can be all one light colour too,
  // a white tee's close-up, so this is for shoes only.)
  const tiny = shoe && !traits.garment && traits.touches === 0 && traits.light > 0.9 && traits.plain > 0.95
  if (tiny) return f
  if (!traits.garment || traits.touches >= 3) {
    for (const r of ["flat_front", "flat_back", "view", "sole", "angled", "pair"]) if (r in f) f[r] = 0.25
    if ("closeup" in f) f.closeup = 2
  } else if (standing) {
    if ("closeup" in f) f.closeup = traits.fills > 0.55 ? 0.8 : 0.4
  }
  if (wordy && (!traits.garment || traits.fills < 0.3) && "tag" in f) f.tag = 3
  if (traits.skin > 0.03 && "on_model" in f) f.on_model = 1.6
  return f
}

// Each photo's role, with how sure: [{ role, scores }], from what's known of each photo: { image: { src, alt },
// traits, summary, role?, picked? } (picked: its role was set by hand, and stays). shoe: the listing is shoes.
// The examples decide most; the words, when a shop writes them, move it; the measurements rule out the
// impossible (a front that runs off three edges of the frame).
export function photoRoles(photos, { shoe = false, examples = EXAMPLES } = {}) {
  const roles = shoe ? SHOE_ROLES : GARMENT_ROLES
  const others = photos.map(p => p.image?.src).filter(Boolean)
  return photos.map((p, index) => {
    if (p.picked && p.role) return { role: p.role, scores: { [p.role]: 1 }, picked: true }
    const prior = Object.fromEntries(roles.map(r => [r, PRIOR[r] ?? 0.05]))
    // Shops lead a shoe's photos with its side (89 of the sample's 90 shoe listings): the first photo is
    // twice as likely its side as the examples alone would say. (A pair from the side looks much like one.)
    if (shoe && index === 0) prior.flat_front *= 2
    const seen = exampleRole(p.summary, { allowed: roles, examples, shoe })
    const words = wordsRole(p.image, { shoe, others })
    // On a hanger or laid flat is no one wearing it.
    const flatWords = FLAT.test(String(p.image?.alt ?? ""))
    const traits = traitsFactor(p.traits, roles, { shoe })
    const scores = {}
    for (const r of roles) {
      // Without the examples, the old kinds from the measurements stand in for them.
      // (Floored, so the shop's plain words for a photo can still outweigh the examples' nearest few.)
      const look = seen ? (seen[r] ?? 0) * 0.9 + 0.03 : fromKind(p.traits, r)
      const said = words[r] ? 1 + 8 * words[r] : Object.keys(words).length ? Math.max(0.15, 1 - 0.85 * Math.max(...Object.values(words))) : 1
      scores[r] = prior[r] * look * said * traits[r] * (flatWords && r === "on_model" && !words.on_model ? 0.15 : 1)
    }
    const total = Object.values(scores).reduce((a, b) => a + b, 0) || 1
    for (const r of roles) scores[r] /= total
    const role = roles.reduce((a, b) => (scores[b] > scores[a] ? b : a))
    return { role, scores, words, several: SEVERAL.test(String(p.image?.alt ?? "")) }
  })
}

const PRIOR = { flat_front: 0.3, flat_back: 0.15, on_model: 0.2, closeup: 0.2, sole: 0.04, angled: 0.08, pair: 0.06, view: 0.08, tag: 0.03, other: 0.03 }

function fromKind(traits, role) {
  const kind = photoKind(traits)
  const table = {
    garment: { flat_front: 0.5, flat_back: 0.3, on_model: 0.08, closeup: 0.04, view: 0.2, angled: 0.15, pair: 0.1, sole: 0.08, tag: 0.01, other: 0.03 },
    worn: { flat_front: 0.15, flat_back: 0.08, on_model: 0.6, closeup: 0.1, view: 0.05, angled: 0.05, pair: 0.05, sole: 0.02, tag: 0.01, other: 0.03 },
    closeup: { flat_front: 0.03, flat_back: 0.02, on_model: 0.1, closeup: 0.8, view: 0.02, angled: 0.05, pair: 0.02, sole: 0.1, tag: 0.05, other: 0.05 },
    tag: { flat_front: 0.02, flat_back: 0.02, on_model: 0.02, closeup: 0.3, view: 0.02, angled: 0.02, pair: 0.02, sole: 0.02, tag: 0.8, other: 0.05 }
  }
  return (table[kind] ?? table.garment)[role] ?? 0.02
}

// The photos a garment uses, from the roles (photoRoles'), in the listing's order:
//   front: the first photo of it on its own (flat_front or flat_back) that the shop's words don't call its
//     back (for a shoe: its side), else the first back, else the first on_model (worn: true; the garment is
//     drafted from its chart, its colour and parts read from the photo masked to the garment), else null;
//   backs: the other photos of it on its own, backs first, in order, for the caller to hold to the front's
//     outline and colour (only one that matches goes on the back);
//   closeups: the close-ups (texture only); model: the first on_model; views: a shoe's square-on views;
//   tags: the labels. A sole, an angled shot or a pair is never any of these.
export function pickPhotos(read) {
  const at = role => read.map((r, i) => (r.role === role ? i : -1)).filter(i => i >= 0)
  const flats = at("flat_front"), backs = at("flat_back"), worn = at("on_model")
  let front = flats[0] ?? -1, wornFront = false
  // The examples barely tell a garment's front from its back (laid out, they look alike), and shops show the
  // front first: the first photo of it on its own is the front unless the shop's words call it the back.
  const saysBack = i => (read[i].words?.flat_back ?? 0) >= 0.5 && !(read[i].words?.flat_front >= 0.5)
  const first = [...flats, ...backs].sort((a, b) => a - b).find(i => !saysBack(i))
  if (first != null && (front < 0 || first < front)) front = first
  if (front < 0 && backs.length) front = backs[0]
  if (front < 0 && worn.length) { front = worn[0]; wornFront = true }
  return {
    front: front < 0 ? null : front, worn: wornFront,
    backs: [...backs, ...flats].filter(i => i !== front).sort((a, b) => order(read, a) - order(read, b)),
    closeups: at("closeup"), model: worn[0] ?? null, views: at("view"), tags: at("tag")
  }
}

// Backs in order: the ones called backs before later fronts (Kith: front, model, back, details).
function order(read, i) {
  return (read[i].role === "flat_back" ? 0 : 100) + i
}

// The photo tray's roles (guessRoles), each photo { traits, summary?, role?, picked? }: the same reading,
// then one front and one back, the rest of the full shots "other".
export function guessRoles(photos) {
  const read = photoRoles(photos.map(p => ({ ...p, image: p.image ?? null })))
  const roles = read.map(r => r.role)
  const taken = new Set(photos.filter(p => p.picked).map(p => p.role))
  return roles.map((role, i) => {
    if (photos[i].picked) return photos[i].role
    if (role !== "flat_front" && role !== "flat_back") return role
    for (const r of [role, role === "flat_front" ? "flat_back" : "flat_front"]) if (!taken.has(r)) { taken.add(r); return r }
    return "other"
  })
}

// The photo for each role the garment uses (the first of each), from the tray.
export function photosByRole(photos) {
  const out = {}
  for (const p of photos) if (p.role && p.role !== "other" && !out[p.role]) out[p.role] = p.url
  // No front: the first full shot (or the first photo but a label or a close-up) stands in, a worn one last.
  out.flat_front ??= photos.find(p => p.role === "other")?.url ?? photos.find(p => !["tag", "closeup", "on_model"].includes(p.role))?.url ?? photos.find(p => p.role === "on_model")?.url ?? null
  return out
}
