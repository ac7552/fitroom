// A fit result in words and bars: each part of the garment as a bar from tight to loose (narrow to wide at
// the shoulders, short to long for a length), with a marker where this size falls, the range that fits
// shaded in the middle, and a few words; one sentence for the size; and the parts that couldn't be checked,
// in one line. The API sends each check's ease (cm: the garment less the body) and the range of ease that
// fits for the cut the person chose (good_cm); nothing here decides what fits.
import { formatAbout, formatLength } from "lib/format"

const ENDS = { shoulders: ["Narrow", "Wide"], sleeve: ["Short", "Long"], length: ["Short", "Long"], inseam: ["Short", "Long"] }
const LENGTHS = ["sleeve", "length", "inseam"]
const NAMES = { inseam: "Leg length", leg_opening: "Leg opening", sleeve: "Sleeves" }
// Where a part is, in a sentence: "2 in wide at the shoulders", "3 in long in the sleeves".
const WHERE = {
  chest: "at the chest", waist: "at the waist", hips: "at the hips", seat: "at the seat", shoulders: "at the shoulders",
  sleeve: "in the sleeves", length: "in the length", inseam: "in the leg"
}

// The good range sits in the middle third of the bar.
export const OK_FROM = 1 / 3
export const OK_TO = 2 / 3

export function partName(check) {
  return NAMES[check.part] ?? check.label
}

// Where a size's ease falls along its bar, as a share of the bar (0.03 to 0.97): the good range is the
// middle third, so its ends are at a third and two thirds, and a size as far again outside it is near an end
// of the bar. A range narrower than 2 cm is drawn as 2 cm, so a tape measure's error doesn't fill the bar.
// Null when there's nothing to place (no ease, or no range).
export function barPlace(ease, good) {
  if (ease == null || !Array.isArray(good)) return null
  const [lo, hi] = good
  const middle = (lo + hi) / 2, half = Math.max((hi - lo) / 2, 1)
  const at = 0.5 + ((ease - middle) / half) * (OK_TO - 0.5)
  return Math.min(0.97, Math.max(0.03, at))
}

// How far outside its good range a size is (cm, 0 inside it); without a range, its ease.
function off(check) {
  if (!Array.isArray(check.good_cm)) return Math.abs(check.ease_cm ?? 0)
  const [lo, hi] = check.good_cm
  return check.ease_cm < lo ? lo - check.ease_cm : check.ease_cm > hi ? check.ease_cm - hi : 0
}

// "tight" for too tight or too short, "loose" for too loose or too long, else "good".
export function markClass(status) {
  return status === "tight" || status === "short" ? "tight" : status === "loose" || status === "long" ? "loose" : "good"
}

// A few words for one part of a size: "5 in room", "1 in too wide", "Just right".
export function barWords(check, unit) {
  const amount = check.ease_cm == null ? null : formatLength(check.ease_cm, unit)
  const away = howFar(off(check), unit)
  const tailor = check.fix ? ` ✂ A tailor can ${check.fix.text.toLowerCase()}.` : ""
  if (check.status === "good" && check.note) return check.note
  if (amount == null) return check.note ?? ""
  if (LENGTHS.includes(check.part)) {
    if (check.status === "good") return "Just right"
    return `${away} too ${check.status === "short" || check.status === "tight" ? "short" : "long"}.${tailor}`
  }
  if (check.part === "shoulders") {
    if (check.status === "good") return "The seam sits on your shoulder"
    return `${away} too ${check.status === "tight" ? "narrow" : "wide"}.${tailor}`
  }
  if (check.status === "good") return check.ease_cm < 0 ? `${amount} under you: it stretches` : `${amount} room`
  if (check.status === "tight") return check.ease_cm < 0 ? `${amount} smaller than you.${tailor}` : `Only ${amount} room.${tailor}`
  return `${amount} room, ${away} too much.${tailor}`
}

// One part's row: its name, its bar (when the API gave a range to place it in) and its words.
export function partRow(check, unit) {
  const at = barPlace(check.ease_cm, check.good_cm)
  const [low, high] = ENDS[check.part] ?? ["Tight", "Loose"]
  const bar = at == null ? `<span class="part-bar part-bar--none"></span>` : `
      <span class="part-bar" role="img" aria-label="${escape(`${partName(check)}: ${barWords(check, unit)}`)}">
        <span class="part-line"></span>
        <span class="part-ok" style="left:${pct(OK_FROM)};width:${pct(OK_TO - OK_FROM)}"></span>
        <span class="part-mark part-mark--${markClass(check.status)}" style="left:${pct(at)}"></span>
        <span class="part-ends"><span>${low}</span><span>${high}</span></span>
      </span>`
  return `
    <li class="part${check.fix ? " part--tailor" : ""}">
      <span class="part-name">${escape(partName(check))}</span>${bar}
      <span class="part-say">${escape(barWords(check, unit))}</span>
    </li>`
}

// The parts that couldn't be checked, in one line, or "" when every part was: "Not checked: waist (the chart
// doesn't say) and seat (add your hips)."
export function uncheckedLine(checks) {
  const unknown = checks.filter(c => c.status === "unknown")
  if (!unknown.length) return ""
  const why = c => c.note ? c.note.replace(/\s+to check (?:this|it)\.?$/i, "").replace(/^./, s => s.toLowerCase()) : "the chart doesn't say"
  return `Not checked: ${listed(unknown.map(c => `${partName(c).toLowerCase()} (${why(c)})`))}.`
}

// The sentence for a size: "M fits best. Nothing needs to change." / "L fits after a tailor: take in the
// waist by about 1 inch." / "XL: 2 in wide at the shoulders and 3 in long in the sleeves. A tailor can't fix
// those." Returns { lead, rest }: the bold words, then the rest.
export function verdictWords(result, best, unit) {
  const size = result.size
  const isBest = size === best
  const fixes = result.checks.filter(c => c.fix)
  const problems = result.checks.filter(c => !c.fixable && c.status !== "unknown")
  if (result.verdict === "fits") return { lead: isBest ? `${size} fits best.` : `${size} fits too.`, rest: "Nothing needs to change." }
  if (result.verdict === "alter") {
    const list = fixes.map(c => `${c.fix.text.toLowerCase()} by ${formatAbout(c.fix.amount_cm, unit)}`)
    return { lead: `${size} fits after a tailor:`, rest: `${capitalize(listed(list))}.` }
  }
  const words = problems.map(c => {
    const how = LENGTHS.includes(c.part) ? (c.status === "short" || c.status === "tight" ? "short" : "long")
      : c.part === "shoulders" ? (c.status === "tight" ? "narrow" : "wide")
      : c.status === "tight" ? "tight" : "loose"
    return `${howFar(off(c), unit)} ${how} ${WHERE[c.part] ?? `in the ${partName(c).toLowerCase()}`}`
  })
  return {
    lead: isBest ? `${size} is the nearest:` : `${size}:`,
    rest: `${capitalize(listed(words))}. A tailor can't fix ${problems.length === 1 ? "that" : "those"}.`
  }
}

// An amount off, as a tape reads it, or "a little" when it rounds to nothing.
function howFar(cm, unit) {
  const amount = formatLength(cm, unit)
  return /^0 /.test(amount) ? "a little" : amount
}

function pct(share) {
  return `${(share * 100).toFixed(1)}%`
}

function listed(words) {
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`
}

function capitalize(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text
}

function escape(text) {
  return String(text ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}
