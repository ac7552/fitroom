// Where each piece of cloth starts before it's sewn, the way garment tools lay patterns round an avatar: body
// panels curved round the torso in front and behind, sleeves rolled round the arms, a hood round the head, and
// bands, cuffs and collars laid along the edges they're sewn to. Everything starts a little off the body, so
// the sewing can pull it in without anything passing through.
import { add3, cross, normalize, scale, sub } from "lib/garments/body"

const GAP = 0.022          // metres off the body to start
const SLEEVE_START = 0.03
const CROTCH_TURN = 10     // cm up the crotch curve over which pants' pieces turn from round the body to round the leg  // how far down the arm from the shoulder joint the top of the sleeve starts

// cloth: from cloth.js. pattern: from pattern.js. frame: from body.js. Returns { positions (Float32Array, metres),
// lift, attach (see the bands, below) }.
export function placeCloth(cloth, pattern, frame) {
  // A layer over another garment (a jacket over a top) starts further out, clear of the cloth under it.
  const gap = frame.gap ?? GAP
  const n = cloth.points.length
  const out = new Float32Array(3 * n)
  const done = new Uint8Array(n)
  const m = pattern.measures
  // A long garment (a dress) is lifted whole (see torso): fading the lift out would stretch it below the arms,
  // and as it springs back while it's sewn it hauls the skirt up the legs.
  const long = m.length > 85
  const radius = (m.chest ?? m.seat) / (2 * Math.PI) / 100
  const hpsY = frame.hps[1]

  // How far each row (by cm down from the shoulder's high point) of the body panels reaches out to the side.
  const rowWidth = new Map()
  cloth.points.forEach(([px, py], i) => {
    const name = cloth.panels[cloth.panel[i]]
    if (name !== "front" && name !== "back") return
    const row = Math.round(py)
    rowWidth.set(row, Math.max(rowWidth.get(row) ?? 0, Math.abs(px)))
  })

  // Lift the body panels so their shoulder seams start above the shoulders.
  let lift = 0
  for (const name of ["front/shoulder_L", "front/shoulder_R", "back/shoulder_L", "back/shoulder_R"]) {
    for (const i of cloth.edges[name] ?? []) {
      const side = cloth.panels[cloth.panel[i]]
      const [x] = torso(cloth.points[i], side, 0)
      const y = hpsY + cloth.points[i][1] / 100
      lift = Math.max(lift, frame.shoulderTop.at(x) + 0.025 - y)
    }
  }

  // The lift fades out below the armholes, so the hem starts where it'll hang. Where the round would run into
  // an arm (the armholes, beside the arm's root), the front moves forward and the back backward, clear of it.
  function torso([px, py], side, raise) {
    const fade = long ? 1 : Math.min(Math.max(1 - (-py - m.armhole) / 15, 0), 1)
    const y = hpsY + py / 100 + raise * fade
    // Each row goes half way round, front or back: a row wider than the chest (a flared skirt) is wrapped on
    // a wider round, so it doesn't run past the side into the other panel.
    const half = (rowWidth.get(Math.round(py)) ?? 0) / 100
    const round = Math.max(radius, half / (Math.PI / 2) * 1.04)
    const angle = (side === "back" ? Math.PI : 0) + px / 100 / round
    // Below the crotch, cloth goes round both legs together (their convex outline): the reach table fills the
    // gap between them with the widest reach nearby, which would start a skirt far too wide, to shrink and ride
    // up the legs.
    const reach = y < frame.crotch ? frame.torso.envelope(y, angle) : frame.torso.at(y, angle)
    const r = Math.max(round, reach + gap)
    const q = [r * Math.sin(angle), y, frame.torso.centreAt(y) + r * Math.cos(angle)]
    if (side === "front" || side === "back") clearOfArms(q, side === "front" ? 1 : -1)
    return q
  }

  function clearOfArms(q, towards) {
    for (const a of [frame.arms.L, frame.arms.R]) {
      for (let k = 0; k < 40; k++) {
        const { t, distance } = a.locate(q)
        if (t < 0.005 || t > a.lengths[1] || distance >= a.reachAt(t) + gap) break
        q[2] += 0.005 * towards
      }
    }
  }

  // Each arm's frame: along it, the top of the arm ("up") and its front. The sleeve is rolled round the arm
  // row by row, each row's width going once round (the cap's rows as wide as the bicep), so its underarm
  // seam starts closed all the way down to the wrist.
  function arm([px, py], side, widthAt, squeeze) {
    const a = frame.arms[side]
    const t = Math.min(squeeze(-py / 100) + SLEEVE_START, a.total)
    const { point, direction } = a.along(t)
    const up = normalize(sub([0, 1, 0], scale(direction, direction[1])))
    let front = normalize(cross(direction, up))
    if (front[2] < 0) front = scale(front, -1)
    // Seen from outside, +x on the sleeve runs towards the back on the left arm and the front on the right.
    const across = side === "L" ? scale(front, -1) : front
    const half = widthAt(py)
    const rs = half / Math.PI / 100
    const r = Math.max(rs, a.reachAt(t) + gap)
    const angle = (px / half) * Math.PI
    return add3(point, add3(scale(up, r * Math.cos(angle)), scale(across, r * Math.sin(angle))))
  }

  // A sleeve's half width at a pattern row: the bicep's through the cap, then along its underarm seams.
  function sleeveWidth(panel) {
    const seam = panel.edges.find(e => e.name === "seam_front").points
    const [top, bottom] = seam[0][1] > seam[seam.length - 1][1] ? [seam[0], seam[seam.length - 1]] : [seam[seam.length - 1], seam[0]]
    return py => {
      if (py >= top[1]) return Math.abs(top[0])
      const u = Math.min((top[1] - py) / (top[1] - bottom[1] || 1), 1)
      return Math.abs(top[0]) + (Math.abs(bottom[0]) - Math.abs(top[0])) * u
    }
  }

  function head([px, py], side, width, tall) {
    const h = frame.head
    const t = Math.min(Math.max(py / tall, 0), 1.08)
    const neckY = hpsY + lift - 0.01
    const y = neckY + t * (h.top + 0.03 - neckY)
    const fromFront = Math.min(Math.max((side === "L" ? px : -px) / width, 0), 1)
    const open = 1.15 * smoothstep(0.1, 0.8, t)   // the face opening sits round the sides of the face
    const angle = (side === "L" ? 1 : -1) * (open + (Math.PI - open) * fromFront)
    const neckR = frame.neckSide + 0.035, headR = Math.max(h.rx, h.rz) + 0.03
    let r = neckR + (headR - neckR) * smoothstep(0, 0.45, t)
    if (t > 0.6) r *= Math.sqrt(Math.max(0.04, 1 - ((t - 0.6) / 0.48) ** 2))
    return [h.centre[0] + r * Math.sin(angle), y, h.centre[2] + r * Math.cos(angle)]
  }

  // A hood worn down, as a shop photo shows a hoodie (and as it's mostly worn): hanging down the back from the
  // neckline, its crown seam straight down the centre back, the forehead end at the bottom, and the opening's
  // edge running up its sides and over the shoulders. Each point lies as far round from the centre back as it
  // is in from the crown edge on the flat piece, and as far down as it is up the piece. What's sewn to the
  // front neckline stands up round the neck a little and folds back over the shoulder to lie on the back, on
  // top of the rest. crownX: the crown edge's x at a height up the piece.
  function hoodDown([px, py], side, crownX) {
    const sign = side === "L" ? 1 : -1
    const neckY = hpsY + lift - 0.01
    const round = Math.max(radius, frame.torso.at(neckY - 0.1, sign * Math.PI * 0.75) + gap) + 0.012
    const s = Math.max(py, 0) / 100
    const across = Math.max(0, crownX(py) - Math.abs(px)) / 100
    const shoulder = (Math.PI / 2) * 0.92, rise = 0.03
    let fromBack = across / round, y = neckY - s, extra = 0
    if (fromBack > shoulder) {
      // Past the shoulder: sewn to the front neckline. Up the neck, then folded back onto the back.
      if (s <= rise) y = neckY + s
      else { fromBack = Math.max(0, 2 * shoulder - fromBack); y = neckY + rise - (s - rise); extra = 0.012 }
    }
    const a = sign * (Math.PI - fromBack)
    const r = Math.max(radius, frame.torso.at(y, a) + gap) + 0.012 + extra
    const q = [r * Math.sin(a), y, frame.torso.centreAt(y) + r * Math.cos(a)]
    if (y < neckY) clearOfArms(q, -1)
    return q
  }

  // Pants: each leg piece round its quarter of the hips above the crotch, and round its half of the leg
  // below it. The crotch point hangs a little below the body's; a leg longer than the leg starts gathered
  // above the ankle, as extra length stacks there.
  const legRows = new Map()
  function legSpan(name) {
    if (legRows.has(name)) return legRows.get(name)
    const edges = pattern.panels[name].edges
    const along = e => edges.find(x => x.name === e).points
    const xAt = (points, y) => {
      for (let k = 1; k < points.length; k++) {
        const [x0, y0] = points[k - 1], [x1, y1] = points[k]
        if ((y - y0) * (y - y1) <= 0 && y0 !== y1) return x0 + (x1 - x0) * (y - y0) / (y1 - y0)
      }
      // Past its ends: the nearer end's x.
      const first = points[0], last = points[points.length - 1]
      return Math.abs(y - first[1]) < Math.abs(y - last[1]) ? first[0] : last[0]
    }
    const side = along("side"), inseam = along("inseam"), crotch = along("crotch")
    const span = py => [py < -m.rise ? xAt(inseam, py) : xAt(crotch, py), xAt(side, py)]
    legRows.set(name, span)
    return span
  }
  const topY = frame.crotch - 0.015 + m.rise / 100
  // How far off the body to start a waist or a hip: the usual gap where the cloth has room, but no more
  // than its own round allows (a skirt's 72 cm waist on a 71 cm body starts a few millimetres off it, not
  // 2 cm, which would stretch it a fifth bigger and send it riding up as it springs back).
  const girths = new Map()
  const bodyGirth = (y, outline) => {
    const key = `${outline}:${Math.round(y * 500)}`
    if (!girths.has(key)) {
      const at = (yy, a) => frame.torso[outline](yy, a)
      let sum = 0, last = null, first = null
      for (let k = 0; k < 48; k++) {
        const a = (k / 48) * 2 * Math.PI, r = at(y, a), q = [r * Math.sin(a), r * Math.cos(a)]
        if (last) sum += Math.hypot(q[0] - last[0], q[1] - last[1]); else first = q
        last = q
      }
      girths.set(key, sum + Math.hypot(first[0] - last[0], first[1] - last[1]))
    }
    return girths.get(key)
  }
  const gapFor = (y, round, outline) => Math.min(GAP, Math.max(0.003, (round - bodyGirth(y, outline)) / (2 * Math.PI)))
  function leg([px, py], place, name) {
    const [inner, outer] = legSpan(name)(py)
    const sign = place.side === "L" ? 1 : -1
    if (py >= -m.rise) {
      const y = topY + py / 100
      const angle = (place.part === "back" ? Math.PI : 0) + (px / Math.max(Math.abs(outer), 1)) * (Math.PI / 2)
      // The slice's convex outline (the tape's round), not the widened reach kept for collisions, which
      // runs several centimetres bigger.
      const reach = frame.torso.envelope(y, angle)
      const round = (Math.abs(outer) * 4) / 100
      const r = Math.max(reach + gapFor(y, round, "envelope"), round / (2 * Math.PI))
      const around = [r * Math.sin(angle), y, frame.torso.centreAt(y) + r * Math.cos(angle)]
      // The bottom of the crotch curve turns in under the body, towards the leg: laid round the torso, the
      // front's and the back's crotch points would start the body's depth apart (30 cm on roomy pants), and
      // sewing them together hauls the inseams up and crumples the legs.
      const under = (py + m.rise) / CROTCH_TURN
      if (under >= 1) return around
      const below = tube(px, -m.rise, inner, outer, place, sign)
      const k = smoothstep(0, 1, under)
      return [below[0] + (around[0] - below[0]) * k, y, below[2] + (around[2] - below[2]) * k]
    }
    return tube(px, py, inner, outer, place, sign)
  }

  // A leg piece below the crotch, round its half of the leg.
  function tube(px, py, inner, outer, place, sign) {
    const legLine = frame.legs[place.side]
    const below = (-py - m.rise) / 100
    // Down to just above the ankle: a hem laid round the foot would start two or three times its size and
    // snap in. From there it falls, and comes to rest on the instep and the heel (see Drape's stayOffFeet).
    // A cuff hangs below the leg piece, so the piece itself has that much less room.
    const room = frame.crotch - 0.015 - Math.max(frame.floor + 0.02, legLine.chain[2][1] + 0.02) - m.cuff / 100
    const piece = (m.length - m.rise) / 100
    let drop = below
    if (piece > room) {
      const free = 0.55 * room, k = (room - free) / (piece - free)
      drop = below <= free ? below : free + (below - free) * k
    }
    const y = frame.crotch - 0.015 - drop
    const { point, t } = legLine.atHeight(Math.max(y, legLine.chain[2][1]))
    const u = Math.min(Math.max((px - inner) / ((outer - inner) || 1), 0), 1)
    const theta = (u - 0.5) * Math.PI
    const width = Math.abs(outer - inner) / 100
    const r = Math.max(width / Math.PI, legLine.reachAt(t) + GAP)
    const facing = place.part === "back" ? -1 : 1
    return [point[0] + r * Math.sin(theta) * sign, y, point[2] + r * Math.cos(theta) * facing]
  }


  // A skirt: round the hips from its top, and below the crotch round both legs together (their convex
  // outline), a little off them.
  // Below the seat a flared skirt is a cone: its side seams are straight lines that meet above it. Laid on
  // that cone (each piece a slice of it, the way a circle skirt is cut), the cloth starts at its own size
  // both round and down; laid in level rings, its sides would start a few per cent too long and spring
  // back, crumpling the hem.
  const cone = (() => {
    if (!m.skirt) return null
    const hh = m.seat / 4, he = m.hem / 4, run = m.length - m.seatAt
    const k = (he - hh) / run
    if (k < 0.02) return null
    const apex = -m.seatAt + hh / k                    // pattern y where the side lines meet
    const alpha = Math.atan(k)                          // each half piece's angle at the apex
    const spread = (2 * alpha) / Math.PI                // the cone's radius per unit of slant
    return { apex, alpha, spread, fall: Math.sqrt(Math.max(1 - spread * spread, 0)), seatSlant: apex + m.seatAt }
  })()
  function skirt([px, py], place, name) {
    if (cone && py < -m.seatAt) {
      const dy = cone.apex - py, rho = Math.hypot(px, dy), phi = Math.atan2(px, dy)
      const theta = (place.part === "back" ? Math.PI : 0) + (phi / cone.alpha) * (Math.PI / 2)
      // Down its own line from the seat's row, which is level.
      const y = topY + (-m.seatAt - (rho - cone.seatSlant / Math.cos(phi)) * cone.fall) / 100
      const reach = frame.torso.envelope(y, theta)
      const r = Math.max(reach + 0.003, (rho * cone.spread) / 100)
      return [r * Math.sin(theta), y, frame.torso.centreAt(y) + r * Math.cos(theta)]
    }
    const y = topY + py / 100
    const edges = pattern.panels[name].edges
    const sideX = Math.abs(edges.find(e => e.name.startsWith("side_")).points.reduce((best, [x, yy]) => (Math.abs(yy - py) < Math.abs(best[1] - py) ? [x, yy] : best))[0])
    const angle = (place.part === "back" ? Math.PI : 0) + (px / Math.max(sideX, 1)) * (Math.PI / 2)
    const reach = frame.torso.envelope(y, angle)
    const round = (sideX * 4) / 100
    const r = Math.max(reach + gapFor(y, round, "envelope"), round / (2 * Math.PI))
    return [r * Math.sin(angle), y, frame.torso.centreAt(y) + r * Math.cos(angle)]
  }

  cloth.panels.forEach((name, panelIndex) => {
    const place = pattern.panels[name].place
    if (place.at === "band") return
    let width = 0, tall = 0, crownX = null
    if (place.at === "head") {
      tall = Math.max(...pattern.panels[name].edges.flatMap(e => e.points).map(p => p[1]))
      width = pattern.panels[name].edges.filter(e => e.name.startsWith("sewn_")).reduce((s, e) => s + Math.abs(e.points[e.points.length - 1][0] - e.points[0][0]), 0)
      // The crown edge as it rises from the neck (its x at each height), for a hood worn down.
      const crown = pattern.panels[name].edges.find(e => e.name === "crown").points.map(([x, y]) => [Math.abs(x), y])
      if (crown[0][1] > crown[crown.length - 1][1]) crown.reverse()
      const rising = [crown[0]]
      for (const q of crown.slice(1)) { if (q[1] <= rising[rising.length - 1][1]) break; rising.push(q) }
      crownX = y => {
        if (y <= rising[0][1]) return rising[0][0]
        for (let k = 1; k < rising.length; k++) if (y <= rising[k][1]) return rising[k - 1][0] + (rising[k][0] - rising[k - 1][0]) * (y - rising[k - 1][1]) / (rising[k][1] - rising[k - 1][1])
        return rising[rising.length - 1][0]
      }
    }
    const widthAt = place.at === "arm" ? sleeveWidth(pattern.panels[name]) : null
    // A sleeve (and its cuff) longer than the arm starts gathered up the forearm, the way extra length bunches
    // above a cuff, so the cuff begins at the wrist; the upper arm keeps its length.
    let squeeze = s => s
    if (place.at === "arm") {
      const cuff = pattern.panels[`cuff_${place.side}`]
      const cuffLength = cuff ? Math.max(...cuff.edges.flatMap(e => e.points).map(q => Math.abs(q[1]))) / 100 : 0
      const room = frame.arms[place.side].lengths[2] - SLEEVE_START - cuffLength - 0.01
      const length = m.sleeve / 100
      if (length > room) {
        const free = 0.45 * room, k = (room - free) / (length - free)
        squeeze = s => (s <= free ? s : free + (s - free) * k)
      }
    }
    for (let i = 0; i < n; i++) {
      if (cloth.panel[i] !== panelIndex) continue
      const p = cloth.points[i]
      const q = place.at === "torso" ? torso(p, place.side, lift) : place.at === "arm" ? arm(p, place.side, widthAt, squeeze)
        : place.at === "leg" ? leg(p, place, name) : place.at === "skirt" ? skirt(p, place, name) : place.down ? hoodDown(p, place.side, crownX) : head(p, place.side, width, tall)
      out.set(q, 3 * i)
      done[i] = 1
    }
  })

  // Bands go along the edges they're sewn to, then off them in their own direction. Each band point is kept
  // as an attachment (between which two points of the edge it's sewn to, how far off it, and which way), so
  // the drape can hold bands on their edges while the body's seams close and only then let them go.
  const sewnTo = new Map()
  for (const [a, b] of cloth.sewing) {
    sewnTo.set(a, b)
    sewnTo.set(b, a)
  }
  const attach = { points: [], from: [], to: [], u: [], offset: [], direction: [] }
  for (let pass = 0; pass < 3; pass++) {
    cloth.panels.forEach((name, panelIndex) => {
      const panel = pattern.panels[name]
      if (panel.place.at !== "band") return
      // The sewn edge's points in order along the band (by x), with the placed points they're sewn to.
      const along = []
      for (const e of panel.edges) {
        if (!e.name.startsWith("sewn_")) continue
        for (const i of cloth.edges[`${name}/${e.name}`]) {
          const host = sewnTo.get(i)
          if (host !== undefined && done[host]) along.push([cloth.points[i][0], host])
        }
      }
      if (along.length < 2) return
      along.sort((a, b) => a[0] - b[0])
      const fall = panel.place.toward === "fall"
      const panelDirection = panel.place.toward === "up" ? [0, 1, 0] : panel.place.toward === "down" || fall ? [0, -1, 0]
        : frame.arms[panel.place.side].along(frame.arms[panel.place.side].total).direction
      const width = along[along.length - 1][0] - along[0][0]
      for (let i = 0; i < n; i++) {
        if (cloth.panel[i] !== panelIndex || done[i]) continue
        let [px, py] = cloth.points[i]
        // A falling collar's wider outer edge maps back onto its sewn edge, spreading out as it goes down.
        if (fall) {
          const extra = (width * (panel.place.spread - 1)) / 2 * (Math.abs(py) / Math.max(...panel.edges.find(e => e.name === "end_a").points.map(q => Math.abs(q[1]))))
          px = along[0][0] + ((px - along[0][0] + extra) * width) / (width + 2 * extra || 1)
        }
        let k = 1
        while (k < along.length - 1 && along[k][0] < px) k++
        const [x0, h0] = along[k - 1], [x1, h1] = along[k]
        const u = x1 === x0 ? 0 : Math.min(Math.max((px - x0) / (x1 - x0), 0), 1)
        const base = [0, 1, 2].map(c => out[3 * h0 + c] * (1 - u) + out[3 * h1 + c] * u)
        // A falling collar goes out from the neck as much as down, over the shoulders.
        let direction = panelDirection
        if (fall) {
          const ox = base[0], oz = base[2] - frame.torso.centreAt(base[1]), ol = Math.hypot(ox, oz) || 1
          direction = [0.72 * ox / ol, -0.69, 0.72 * oz / ol]
        }
        out.set(add3(base, scale(direction, Math.abs(py) / 100)), 3 * i)
        attach.points.push(i); attach.from.push(h0); attach.to.push(h1); attach.u.push(u)
        attach.offset.push(Math.abs(py) / 100); attach.direction.push(...direction)
        done[i] = 1
      }
    })
  }
  return {
    positions: out, lift,
    attach: {
      points: Int32Array.from(attach.points), from: Int32Array.from(attach.from), to: Int32Array.from(attach.to),
      u: Float32Array.from(attach.u), offset: Float32Array.from(attach.offset), direction: Float32Array.from(attach.direction)
    }
  }
}

function smoothstep(a, b, x) {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}
