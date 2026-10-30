// A garment's sizes as one bar of segments, in the store's order (XS to XXL, 28 to 38), in the look of the
// page's other controls (the size tabs in step 1, the stage's toggles): the size shown filled in, the best
// size marked "★ Best" as the garment's row marks it. A size named two ways ("XXS / US 34", "M (2)") shows
// its first name, with the second small under it, so the names don't run past their segments. Each segment
// is a button the page's pickSize answers; dragging along the bar or the arrow keys move between them (the
// page's slideSize and keySize). Many sizes scroll sideways. Pants sold by waist and leg (30x32, 32/34) get
// one bar for the waist and one for the leg, so a store with dozens of them is still two short rows.

// Each size's place along the line, as a share (0 to 1): evenly spread, a single size in the middle.
export function stopPlaces(count) {
  if (count <= 1) return [0.5]
  return Array.from({ length: count }, (_, i) => i / (count - 1))
}

// The stop nearest a share along the line.
export function stopNear(share, count) {
  if (count <= 1) return 0
  return Math.max(0, Math.min(count - 1, Math.round(share * (count - 1))))
}

// Which stops get a written name when there are too many to fit (more than `room`): every few, and always
// the first, the last, the one shown and the best.
export function namedStops(names, shown, best, room = 9) {
  const step = Math.ceil(names.length / room)
  return names.map((name, i) => step <= 1 || i % step === 0 || i === names.length - 1 || name === shown || name === best)
}

const WAIST_LEG = /^\s*W?(\d{2})\s*(?:[x×\/]|\s)\s*L?(\d{2})\s*$/i

// Pants named by waist and leg ("30x32", "W32 L34", "32/30"): { waists, legs, of(waist, leg) } or null
// when the names aren't all like that (or there are few enough for one line).
export function waistAndLeg(names) {
  if (names.length < 8 || !names.every(n => WAIST_LEG.test(n))) return null
  const parts = names.map(n => n.match(WAIST_LEG).slice(1, 3).map(Number))
  const waists = [...new Set(parts.map(p => p[0]))].sort((a, b) => a - b)
  const legs = [...new Set(parts.map(p => p[1]))].sort((a, b) => a - b)
  if (waists.length < 2 || legs.length < 2) return null
  const of = (waist, leg) => names[parts.findIndex(p => p[0] === waist && p[1] === leg)] ?? null
  return { waists, legs, of, partsOf: name => parts[names.indexOf(name)] ?? null }
}

// The size a waist or a leg picks, keeping the other as near as the store sells it.
export function nearestSize(split, waist, leg) {
  const exact = split.of(waist, leg)
  if (exact) return exact
  const legs = split.legs.filter(l => split.of(waist, l)).sort((a, b) => Math.abs(a - leg) - Math.abs(b - leg))
  if (legs.length) return split.of(waist, legs[0])
  const waists = split.waists.filter(w => split.of(w, leg)).sort((a, b) => Math.abs(a - waist) - Math.abs(b - waist))
  return waists.length ? split.of(waists[0], leg) : null
}

// A size's name split into what's shown big and what's shown small under it: "XXS / US 34" is XXS over
// US 34, "M (2)" is M over 2. One name stays whole.
export function sizeName(name) {
  const text = String(name ?? "").trim()
  const two = text.match(/^(.+?)\s*\/\s*(.+)$/) ?? text.match(/^(.+?)\s*\((.+)\)$/)
  return two && two[1].length <= 6 ? { main: two[1], sub: two[2] } : { main: text, sub: null }
}

// The slider's HTML. sizes: [{ size, verdict }] in the store's order; shown: the size on the mannequin;
// best: the best size (null for clothes Fitroom doesn't fit, which get no "Best").
export function sizeSlider({ kind, label, sizes, shown, best }) {
  const names = sizes.map(s => s.size)
  const split = waistAndLeg(names)
  if (split) {
    const [waist, leg] = split.partsOf(shown) ?? [split.waists[0], split.legs[0]]
    const [bestWaist, bestLeg] = (best && split.partsOf(best)) ?? []
    const line = (axis, values, current, bestValue) => {
      const options = values.map(v => {
        const name = axis === "waist" ? nearestSize(split, v, leg) : nearestSize(split, waist, v)
        return { size: name, name: String(v), on: v === current, best: v === bestValue, sold: Boolean(axis === "waist" ? split.of(v, leg) : split.of(waist, v)) }
      })
      return track(kind, `${label} ${axis}`, axis === "waist" ? "Waist" : "Leg", options)
    }
    return line("waist", split.waists, waist, bestWaist) + line("leg", split.legs, leg, bestLeg)
  }
  const named = namedStops(names, shown, best)
  const options = sizes.map((s, i) => ({ size: s.size, name: s.size, on: s.size === shown, best: s.size === best && sizes.length > 1, verdict: s.verdict, named: named[i], sold: true }))
  return track(kind, `${label} size`, null, options)
}

function track(kind, label, title, options) {
  const stops = options.map(o => {
    const { main, sub } = sizeName(o.name)
    return `
      <button type="button" role="radio" aria-checked="${o.on}" tabindex="${o.on ? 0 : -1}"
              class="sizer-stop${o.on ? " is-on" : ""}${o.verdict ? ` is-${o.verdict}` : ""}${o.sold ? "" : " is-unsold"}"
              data-kind="${kind}" data-size="${escape(o.size)}" data-action="fitting-room#pickSize"
              aria-label="${escape(o.name)}${o.best ? ", best" : ""}" title="${escape(o.name)}"><span>${escape(main)}</span>${sub ? `<small>${escape(sub)}</small>` : ""}${o.best ? "<em>★ Best</em>" : ""}</button>`
  }).join("")
  return `
    <div class="sizer${title ? " sizer--split" : ""}">
      ${title ? `<span class="sizer-title">${title}</span>` : ""}
      <div class="sizer-bar" role="radiogroup" aria-label="${escape(label)}" data-kind="${kind}"
           data-action="pointerdown->fitting-room#slideSize keydown->fitting-room#keySize">${stops}</div>
    </div>`
}

function escape(text) {
  return String(text ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}
