// Step 1's gate, without rendering (docs/plan-2026-11-accuracy.md, 3.1): every listing in the Kith sample read
// as the import reads it (the controller's readShop), and the photos it took held to the labels
// (kith_20261107/photo_roles.json): the front a photo of it on its own (a shoe's side its side), the back one of
// its back, the close-up a close-up. Development only, in the page at http://localhost:3000, served from
// public/validation/ with photo_roles_truth.json beside it:
//
//   const C = await import("/validation/photo_roles_check.js"); await C.check({ from: 0, to: 400 }); C.report()
const { readShop } = await import("controllers/fitting_room_controller")
const truth = await fetch(`/validation/photo_roles_truth.json?v=${Date.now()}`).then(r => r.json())
const LETTER = { F: "flat_front", B: "flat_back", M: "on_model", C: "closeup", S: "sole", A: "angled", P: "pair", V: "view", T: "tag", O: "other" }
const STATE = window.__rolesCheck = window.__rolesCheck ?? { results: {}, running: false }
// (Kith turns a browser away for a while after a few hundred quick requests: `pause` ms between listings,
// and a listing it didn't answer is tried again on the next call.)
export async function check({ from = 0, to = Infinity, handles = Object.keys(truth.roles), pause = 1500 } = {}) {
  STATE.running = true
  STATE.stop = false
  try {
    for (const handle of handles.slice(from, to)) {
      if (STATE.stop) break
      if (STATE.results[handle] && !STATE.results[handle].error) continue
      if (pause) await new Promise(r => setTimeout(r, pause))
      const t0 = performance.now()
      const shop = await readShop(`https://kith.com/products/${handle}`).catch(error => ({ error: error.message }))
      const roles = [...truth.roles[handle]].map(c => LETTER[c])
      STATE.results[handle] = shop?.error || !shop ? { handle, error: shop?.error ?? "no answer" } : {
        handle, ms: Math.round(performance.now() - t0), rolesMs: shop.photoRolesMs, by: shop.photoRolesBy,
        read: shop.photoRoles, front: shop.photoIndex, back: shop.photoBackIndex, closeup: shop.photoCloseupIndex, worn: shop.photoRole === "on_model",
        // (A shoe: whether a side was read from it at all; without one, the photo gives the shoe its colour only.)
        side: shop.shoeViews != null,
        truth: roles, foreign: truth.foreign?.[handle] ?? []
      }
    }
  } finally { STATE.running = false }
  return Object.keys(STATE.results).length
}
// What the gate holds to: no front (or side) that's on a model, a close-up, a sole, an angled shot or a pair
// while the listing has a photo of it on its own; no back that isn't its back; no close-up that isn't one.
export function report() {
  const out = { listings: 0, errors: [], front: [], back: [], closeup: [], worn: [], noSide: [], ms: [], rolesMs: [] }
  for (const r of Object.values(STATE.results)) {
    out.listings++
    if (r.error) { out.errors.push(`${r.handle}: ${r.error}`); continue }
    out.ms.push(r.ms); out.rolesMs.push(r.rolesMs)
    const t = r.truth, has = t.includes("flat_front")
    const shoe = /sole|angled|pair|view/.test(t.join(" "))
    if (has && t[r.front] !== "flat_front" && !(shoe && !r.side)) out.front.push(`${r.handle}: ${r.front} is ${t[r.front]}${shoe ? " (as its side)" : ""}`)
    if (shoe && !r.side) out.noSide.push(r.handle)
    if (!has && ["closeup", "sole"].includes(t[r.front])) out.front.push(`${r.handle}: ${r.front} is ${t[r.front]} (no photo on its own)`)
    if (r.back != null && (t[r.back] !== "flat_back" || r.foreign.includes(r.back))) out.back.push(`${r.handle}: ${r.back} is ${t[r.back]}${r.foreign.includes(r.back) ? " (another garment)" : ""}`)
    if (r.closeup != null && t[r.closeup] !== "closeup") out.closeup.push(`${r.handle}: ${r.closeup} is ${t[r.closeup]}`)
    if (r.worn) out.worn.push(r.handle)
  }
  const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null }
  const p90 = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length * 0.9)] : null }
  return { ...out, ms: { median: median(out.ms), p90: p90(out.ms) }, rolesMs: { median: median(out.rolesMs), p90: p90(out.rolesMs) },
    backsUsed: Object.values(STATE.results).filter(r => r.back != null).length, closeupsUsed: Object.values(STATE.results).filter(r => r.closeup != null).length }
}
export default { check, report }
