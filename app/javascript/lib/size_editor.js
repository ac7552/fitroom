// Entering a garment's sizes one at a time: a tab per size, the size's measurements below it (each with a
// slider whose ends are the sizes either side, so a typo stands out), and a flat drawing of the garment with
// the measurement being typed drawn on it. A pasted chart is read by the server (as a pasted chart always
// was) and fills the tabs, to be checked before the garment goes on. Numbers are kept in cm; the boxes show
// the person's unit.

// The measurements for each kind of garment, in the order they're asked for. A top and a coat are measured
// as a jacket is. help: where the tape goes, as the diagram draws it.
export const EDITOR_PARTS = {
  jacket: [
    { part: "chest", label: "Chest", help: "Straight across under the arms", flat: true, usual: [80, 150] },
    { part: "waist", label: "Waist", help: "Across the narrowest part", flat: true, usual: [70, 145] },
    { part: "shoulders", label: "Shoulders", help: "Seam to seam across the back", usual: [36, 58] },
    { part: "sleeve", label: "Sleeve", help: "Shoulder seam to the cuff", usual: [15, 72] },
    { part: "length", label: "Length", help: "From the top of the shoulder to the hem", usual: [50, 110] }
  ],
  trousers: [
    { part: "waist", label: "Waist", help: "Across the top of the waistband", flat: true, usual: [60, 120] },
    { part: "seat", label: "Seat", help: "Across the widest part of the hips", flat: true, usual: [80, 140] },
    { part: "thigh", label: "Thigh", help: "Across one leg, just below the crotch", flat: true, usual: [44, 80] },
    { part: "inseam", label: "Inseam", help: "Crotch seam to the hem", usual: [10, 95] },
    { part: "leg_opening", label: "Opening", help: "Across the hem of one leg", flat: true, usual: [28, 60] }
  ]
}

export function partsFor(kind) {
  return EDITOR_PARTS[kind === "trousers" ? "trousers" : "jacket"]
}

// The tabs a new garment starts with: letter sizes, or waists for pants.
export function startingSizes(kind) {
  const names = kind === "trousers" ? ["28", "30", "32", "34", "36"] : ["XS", "S", "M", "L", "XL"]
  return names.map(name => ({ name, cm: {} }))
}

// The name for a size added after the others: the next letter, the next even waist, or "Size 6".
const LETTERS = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL"]
export function nextSizeName(sizes) {
  const last = sizes[sizes.length - 1]?.name ?? ""
  const letter = LETTERS.indexOf(last.toUpperCase())
  if (letter >= 0 && letter < LETTERS.length - 1 && !sizes.some(s => s.name.toUpperCase() === LETTERS[letter + 1])) return LETTERS[letter + 1]
  const number = parseInt(last, 10)
  if (Number.isFinite(number) && String(number) === last.trim()) return String(number + 2)
  return `Size ${sizes.length + 1}`
}

// Whether a size has any of its numbers in.
export function filled(size) {
  return Object.values(size.cm ?? {}).some(v => v > 0)
}

// The slider's ends (cm) for a part of the size at `at`: from the size before it to the size after it, with a
// little either side; one neighbour gives a span round it; none, the usual range for that part.
export function sliderRange(sizes, at, part, usual) {
  const before = sizes.slice(0, at).reverse().find(s => s.cm?.[part] > 0)?.cm[part]
  const after = sizes.slice(at + 1).find(s => s.cm?.[part] > 0)?.cm[part]
  if (before != null && after != null && after > before) {
    const pad = Math.max(1, (after - before) * 0.35)
    return [round(before - pad), round(after + pad)]
  }
  const near = before ?? after
  if (near != null) return [round(near * 0.85), round(near * 1.15)]
  return usual
}

// The tabs from a chart the server read (cm): one per size, with the measurements the editor asks for.
// Returns { sizes, note }: the note says what was done ("5 sizes from the chart. Didn't use: Hem, Rise.").
export function sizesFromChart(chart, kind) {
  const parts = partsFor(kind).map(p => p.part)
  const sizes = (chart?.sizes ?? []).map(size => ({
    name: String(size.name ?? ""),
    cm: Object.fromEntries(parts.filter(p => size[p] > 0).map(p => [p, round(size[p])]))
  }))
  const count = sizes.length === 1 ? "1 size" : `${sizes.length} sizes`
  const how = chart?.kind === "body" ? " (a chart of body sizes: these are the clothes' sizes that fit them)"
    : chart?.kind === "sizes" ? " (the usual measurements for that size)" : ""
  const unused = chart?.unused?.length ? ` Didn't use: ${chart.unused.join(", ")}.` : ""
  return { sizes, note: `${count} from the chart${how}. Check them, then add it.${unused}` }
}

// The garment's chart from the tabs: every size with its main measurement in, each part in cm (doubled when
// it was measured flat, across), and the parts no size has.
export function chartFromSizes(sizes, kind, flat) {
  const parts = partsFor(kind)
  const main = parts[0].part
  const out = sizes.filter(s => s.cm?.[main] > 0).map((s, i) => ({
    name: s.name.trim() || `Size ${i + 1}`,
    ...Object.fromEntries(parts.map(p => [p.part, s.cm?.[p.part] > 0 ? round(s.cm[p.part] * (flat && p.flat ? 2 : 1)) : null]))
  }))
  const missing = parts.map(p => p.part).filter(part => out.every(size => size[part] == null))
  return { sizes: out, unit: "cm", kind: "garment", missing }
}

// A flat drawing of the garment with each measurement's line on it; the part being typed (`on`) is drawn
// dark and the rest faint.
export function diagram(kind, on) {
  const pants = kind === "trousers"
  const coat = kind === "coat"
  const line = (part, d, x, y, text) => `
    <g class="measure${part === on ? " is-on" : ""}" data-part="${part}">
      <path d="${d}"/><text x="${x}" y="${y}">${text}</text>
    </g>`
  if (pants) {
    return `<svg viewBox="0 0 160 200" role="img" aria-label="Where to measure pants">
      <path class="garment" d="M44 16 H116 L126 186 H90 L82 76 H78 L70 186 H34 Z"/>
      <path class="garment-seam" d="M44 26 H116"/>
      ${line("waist", "M44 10 H116", 80, 7, "Waist")}
      ${line("seat", "M40 52 H120", 80, 48, "Seat")}
      ${line("thigh", "M40 88 H78", 59, 84, "Thigh")}
      ${line("inseam", "M86 80 L120 184", 118, 132, "Inseam")}
      ${line("leg_opening", "M90 194 H126", 108, 199, "Opening")}
    </svg>`
  }
  const hem = coat ? 190 : 150
  return `<svg viewBox="0 0 160 200" role="img" aria-label="Where to measure the ${coat ? "coat" : kind === "top" ? "top" : "jacket"}">
    <path class="garment" d="M56 14 L66 10 Q80 22 94 10 L104 14 L132 26 L150 92 L134 98 L118 50 L118 ${hem} H42 L42 50 L26 98 L10 92 L28 26 Z"/>
    ${line("shoulders", "M28 26 Q80 18 132 26", 80, 18, "Shoulders")}
    ${line("chest", "M42 58 H118", 80, 54, "Chest")}
    ${line("waist", `M42 ${coat ? 104 : 94} H118`, 80, coat ? 100 : 90, "Waist")}
    ${line("sleeve", "M134 28 L150 92", 152, 60, "Sleeve")}
    ${line("length", `M50 14 V${hem}`, 54, hem - 12, "Length")}
  </svg>`
}

function round(n) {
  return Math.round(n * 10) / 10
}
