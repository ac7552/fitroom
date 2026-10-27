// What the cloth needs to know about the body it's draped on: where its joints are, how far it reaches out
// from its middle at each height and angle (so pattern pieces start outside it), and a quick way to find
// the nearest point of its skin (for collisions). Built from the mannequin's mesh as it's shaped and posed;
// pure functions over typed arrays, in metres, y up, the body facing +z, its left at +x.

const TORSO = /^(pelvis|spine_0[1-3]|clavicle_[lr])$/
const ARM = /^(upperarm|lowerarm|hand|thumb|index|middle|ring|pinky)/
const HEAD = /^(neck_01|head)$/
const LEG = /^(thigh|calf|foot|ball)/

// positions, normals: Float32Array (3 per vertex). skinIndex, skinWeight: 4 per vertex. bones: names by index.
export function bodyFrame({ positions, normals, index, skinIndex, skinWeight, bones }) {
  const count = positions.length / 3
  const part = new Uint8Array(count)    // 0 torso, 1 left arm, 2 right arm, 3 head and neck, 4 legs
  const kinds = bones.map(name => (ARM.test(name) ? (name.endsWith("_l") ? 1 : 2) : HEAD.test(name) ? 3 : LEG.test(name) ? 4 : TORSO.test(name) ? 0 : 0))
  const joints = {}
  const sums = {}
  const add = (key, i, w) => {
    const s = (sums[key] ??= [0, 0, 0, 0])
    s[0] += positions[3 * i] * w; s[1] += positions[3 * i + 1] * w; s[2] += positions[3 * i + 2] * w; s[3] += w
  }
  for (let i = 0; i < count; i++) {
    let best = 0, bestW = -1, second = 0, secondW = -1
    for (let k = 0; k < 4; k++) {
      const w = skinWeight[4 * i + k], b = skinIndex[4 * i + k]
      if (w > bestW) { second = best; secondW = bestW; best = b; bestW = w }
      else if (w > secondW) { second = b; secondW = w }
    }
    part[i] = kinds[best]
    // Where two bones share a vertex about equally, that's their joint.
    if (secondW > 0.25) {
      const pair = [bones[best], bones[second]].sort().join("+")
      add(pair, i, Math.min(bestW, secondW))
    }
  }
  const at = pair => {
    const s = sums[pair]
    return s && s[3] > 0 ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : null
  }
  for (const side of ["l", "r"]) {
    const key = side.toUpperCase()
    joints[`shoulder_${key}`] = at(`clavicle_${side}+upperarm_${side}`)
    joints[`elbow_${key}`] = at(`lowerarm_${side}+upperarm_${side}`)
    joints[`wrist_${key}`] = at(`hand_${side}+lowerarm_${side}`)
  }
  for (const side of ["l", "r"]) {
    const key = side.toUpperCase()
    joints[`hip_${key}`] = at(`pelvis+thigh_${side}`)
    joints[`knee_${key}`] = at(`calf_${side}+thigh_${side}`)
    joints[`ankle_${key}`] = at(`calf_${side}+foot_${side}`)
  }
  joints.neck = at("neck_01+spine_03")
  joints.head = at("head+neck_01")

  // The hand's far end: the arm vertex furthest along the forearm.
  for (const [key, side] of [["L", 1], ["R", 2]]) {
    const e = joints[`elbow_${key}`], w = joints[`wrist_${key}`]
    const axis = normalize(sub(w, e))
    let far = 0
    for (let i = 0; i < count; i++) if (part[i] === side) far = Math.max(far, dot(sub(vec(positions, i), w), axis))
    joints[`hand_${key}`] = add3(w, scale(axis, far))
  }

  // Heights: the floor, the top of the head, and the highest point of the shoulders either side of the neck.
  let floor = Infinity, top = -Infinity
  for (let i = 0; i < count; i++) { floor = Math.min(floor, positions[3 * i + 1]); top = Math.max(top, positions[3 * i + 1]) }

  const torso = reachTable(positions, index, part, [0, 3, 4], floor, top)
  const arms = { L: armReach(positions, part, 1, joints, "L"), R: armReach(positions, part, 2, joints, "R") }
  const legs = joints.hip_L && joints.knee_L && joints.ankle_L && joints.hip_R && joints.knee_R && joints.ankle_R
    ? { L: legReach(positions, part, joints, "L"), R: legReach(positions, part, joints, "R") } : null
  const shoulderTop = shoulderProfile(positions, part, joints)
  const head = headShape(positions, part, joints)
  // The high point of the shoulder: where the top of the shoulders meets the side of the neck.
  const neckSide = neckWidth(positions, part, joints.neck)
  const hps = [neckSide, shoulderTop.at(neckSide + 0.012)]
  const armpitY = armpit(positions, part, joints)
  const crotch = crotchHeight(positions, floor, part)
  const neck = neckRound(positions, part, joints.neck)
  // What the pattern needs to know, in cm: round the neck, armpit below the high point of the shoulder, and
  // round the upper arm, the wrist and the head (from how far each reaches from its middle).
  // The arm's real girth along it (its slices' convex outlines), for the sleeve: the most round the upper arm
  // is from the armpit down to the elbow (upperArm), and round the forearm just below the elbow (forearm),
  // and how far down the arm the elbow is (elbow). (bicep is a rounder guess, kept for the room a loose
  // sleeve adds.)
  const girths = armGirths(positions, index, part, 1, arms.L, armpitY)
  const measures = {
    neck: neck * 100,
    armpit: (hps[1] - armpitY) * 100,
    bicep: 2 * Math.PI * arms.L.reachAt(arms.L.lengths[1] * 0.65) * 0.78 * 100,
    upperArm: girths.upperArm * 100,
    forearm: girths.forearm * 100,
    elbow: arms.L.lengths[1] * 100,
    wrist: 2 * Math.PI * arms.L.reachAt(arms.L.lengths[2] - 0.03) * 0.75 * 100,
    head: Math.PI * (head.rx + head.rz * 0.85) * 100
  }

  const feet = legs ? { L: footHull(positions, part, joints, floor, "L"), R: footHull(positions, part, joints, floor, "R") } : null
  const hands = { L: handShape(positions, part, 1, arms.L, torso.centreAt), R: handShape(positions, part, 2, arms.R, torso.centreAt) }

  return { count, part, joints, floor, top, torso, arms, legs, feet, hands, shoulderTop, head, hps, armpitY, crotch, neckSide, measures }
}

// Where the legs meet: the lowest point of the pelvis on the body's middle line. (Not of the whole body: with
// the legs brought together, the thighs touch the middle line well below it.)
function crotchHeight(positions, floor, part) {
  let low = Infinity, any = Infinity
  const n = positions.length / 3
  for (let i = 0; i < n; i++) {
    const y = positions[3 * i + 1]
    if (Math.abs(positions[3 * i]) >= 0.012 || y <= floor + 0.3) continue
    any = Math.min(any, y)
    if (part[i] === 0) low = Math.min(low, y)
  }
  return isFinite(low) ? low : isFinite(any) ? any : floor + 0.8
}

// How far the body (the given parts) reaches from its vertical middle line, by height (1 cm) and angle round
// it (10°): each horizontal slice through the mesh, as the outline its triangles cut, measured along each
// angle. Where no skin is cut (an arm joins there, say) the neighbouring angles stand in, and each cell is
// widened to its neighbours so nothing starts inside the body. The middle line follows the body front to back.
function reachTable(positions, index, part, parts, floor, top) {
  const rows = Math.ceil((top - floor) / 0.01) + 1
  const sectors = 36
  const keep = Uint8Array.from(part, p => (parts.includes(p) ? 1 : 0))
  // The slices: for each row, its cut segments [x0, z0, x1, z1].
  const segments = Array.from({ length: rows }, () => [])
  const zMin = new Float32Array(rows).fill(Infinity), zMax = new Float32Array(rows).fill(-Infinity)
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2]
    if (!keep[a] || !keep[b] || !keep[c]) continue
    const ya = positions[3 * a + 1], yb = positions[3 * b + 1], yc = positions[3 * c + 1]
    const lo = Math.min(ya, yb, yc), hi = Math.max(ya, yb, yc)
    for (let r = Math.max(0, Math.ceil((lo - floor) / 0.01)); r <= Math.min(rows - 1, Math.floor((hi - floor) / 0.01)); r++) {
      const y = floor + r * 0.01
      const cut = []
      for (const [i, j] of [[a, b], [b, c], [c, a]]) {
        const yi = positions[3 * i + 1], yj = positions[3 * j + 1]
        if ((yi - y) * (yj - y) > 0 || yi === yj) continue
        const u = (y - yi) / (yj - yi)
        cut.push(positions[3 * i] + (positions[3 * j] - positions[3 * i]) * u, positions[3 * i + 2] + (positions[3 * j + 2] - positions[3 * i + 2]) * u)
      }
      if (cut.length >= 4) {
        segments[r].push(cut[0], cut[1], cut[2], cut[3])
        zMin[r] = Math.min(zMin[r], cut[1], cut[3]); zMax[r] = Math.max(zMax[r], cut[1], cut[3])
      }
    }
  }
  // The middle front to back, smoothed over 12 cm so it doesn't jump from slice to slice.
  const centre = new Float32Array(rows)
  for (let r = 0; r < rows; r++) {
    let sum = 0, count = 0
    for (let k = r - 6; k <= r + 6; k++) {
      if (k < 0 || k >= rows || !(zMin[k] <= zMax[k])) continue
      sum += (zMin[k] + zMax[k]) / 2
      count++
    }
    centre[r] = count ? sum / count : r > 0 ? centre[r - 1] : 0
  }
  const reach = new Float32Array(rows * sectors)
  for (let r = 0; r < rows; r++) {
    const seg = segments[r], cz = centre[r]
    for (let k = 0; k < seg.length; k += 4) {
      // Sample along the segment finely enough to touch every sector it crosses.
      const x0 = seg[k], z0 = seg[k + 1] - cz, x1 = seg[k + 2], z1 = seg[k + 3] - cz
      const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.005))
      for (let q = 0; q <= steps; q++) {
        const x = x0 + ((x1 - x0) * q) / steps, z = z0 + ((z1 - z0) * q) / steps
        const cell = r * sectors + sector(Math.atan2(x, z), sectors)
        reach[cell] = Math.max(reach[cell], Math.hypot(x, z))
      }
    }
  }
  const widen = (from, rowSpan, sectorSpan, onlyEmpty) => {
    const to = new Float32Array(rows * sectors)
    for (let r = 0; r < rows; r++) {
      for (let a = 0; a < sectors; a++) {
        const own = from[r * sectors + a]
        if (onlyEmpty && own > 0) { to[r * sectors + a] = own; continue }
        let m = 0
        for (let dr = -rowSpan; dr <= rowSpan; dr++) {
          const rr = r + dr
          if (rr < 0 || rr >= rows) continue
          for (let da = -sectorSpan; da <= sectorSpan; da++) m = Math.max(m, from[rr * sectors + ((a + da + sectors) % sectors)])
        }
        to[r * sectors + a] = m
      }
    }
    return to
  }
  const widened = widen(widen(widen(reach, 1, 2, true), 3, 4, true), 2, 1, false)

  // The envelope: how far each slice's convex outline reaches along each angle. Cloth hanging round the body
  // spans its hollows (between the legs, the small of the back) rather than following them in.
  const hull = new Float32Array(rows * sectors)
  for (let r = 0; r < rows; r++) {
    const seg = segments[r], cz = centre[r]
    if (seg.length < 12) continue
    const pts = []
    for (let k = 0; k < seg.length; k += 2) pts.push([seg[k], seg[k + 1] - cz])
    const outline = convexHull(pts)
    for (let a = 0; a < sectors; a++) {
      const angle = ((a + 0.5) / sectors) * 2 * Math.PI
      hull[r * sectors + a] = rayToPolygon(outline, Math.sin(angle), Math.cos(angle))
    }
  }
  return {
    floor, rows, sectors, centre, reach: widened, hull,
    // The envelope's reach at height y and angle a, between the angles it's sampled at.
    envelope(y, a) {
      const r = clampRow(y, floor, rows)
      const t = ((a / (2 * Math.PI)) * sectors - 0.5 + sectors) % sectors
      const k = Math.floor(t), u = t - k
      return hull[r * sectors + k] * (1 - u) + hull[r * sectors + ((k + 1) % sectors)] * u
    },
    centreAt(y) { return centre[clampRow(y, floor, rows)] },
    // How far the body reaches at height y and angle a (radians from the front, towards +x).
    at(y, a) { return widened[clampRow(y, floor, rows) * sectors + sector(a, sectors)] }
  }
}

export function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross2 = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower = [], upper = []
  for (const p of pts) {
    while (lower.length >= 2 && cross2(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross2(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

// How far a ray from the origin along (dx, dz) runs before leaving a convex polygon of [x, z] points.
function rayToPolygon(polygon, dx, dz) {
  let best = 0
  for (let i = 0; i < polygon.length; i++) {
    const [ax, az] = polygon[i], [bx, bz] = polygon[(i + 1) % polygon.length]
    const ex = bx - ax, ez = bz - az
    const denom = dx * ez - dz * ex
    if (Math.abs(denom) < 1e-12) continue
    const t = (ax * ez - az * ex) / denom
    const u = (ax * dz - az * dx) / denom
    if (t > 0 && u >= -1e-6 && u <= 1 + 1e-6) best = Math.max(best, t)
  }
  return best
}

function clampRow(y, floor, rows) {
  return Math.min(Math.max(Math.floor((y - floor) / 0.01), 0), rows - 1)
}

function sector(a, sectors) {
  const t = ((a / (2 * Math.PI)) % 1 + 1) % 1
  return Math.min(Math.floor(t * sectors), sectors - 1)
}

// An arm's line (shoulder, elbow, wrist, end of the hand) and how far the arm reaches from it along its length
// (1 cm steps).
function armReach(positions, part, which, joints, side) {
  const chain = [joints[`shoulder_${side}`], joints[`elbow_${side}`], joints[`wrist_${side}`], joints[`hand_${side}`]]
  const lengths = [0]
  for (let k = 1; k < chain.length; k++) lengths.push(lengths[k - 1] + norm(sub(chain[k], chain[k - 1])))
  const total = lengths[lengths.length - 1]
  const steps = Math.ceil(total / 0.01) + 1
  const reach = new Float32Array(steps)
  const n = positions.length / 3
  for (let i = 0; i < n; i++) {
    if (part[i] !== which) continue
    const p = vec(positions, i)
    const { t, distance } = project(chain, lengths, p)
    const s = Math.min(Math.max(Math.round(t / 0.01), 0), steps - 1)
    reach[s] = Math.max(reach[s], distance)
  }
  const widened = reach.map((_, s) => Math.max(...[-2, -1, 0, 1, 2].map(d => reach[Math.min(Math.max(s + d, 0), steps - 1)])))
  return {
    chain, lengths, total,
    reachAt(t) { return widened[Math.min(Math.max(Math.round(t / 0.01), 0), steps - 1)] },
    // Where a point falls along the arm (t, metres from the shoulder; negative before it) and how far it is
    // from the arm's line.
    locate(p) {
      const d = normalize(sub(chain[1], chain[0]))
      const before = dot(sub(p, chain[0]), d)
      if (before < 0) return { t: before, distance: norm(sub(p, chain[0])) }
      return project(chain, lengths, p)
    },
    // The point on the arm's line t metres from the shoulder, and the direction it runs there.
    along(t) {
      let k = 1
      while (k < chain.length - 1 && t > lengths[k]) k++
      const a = chain[k - 1], b = chain[k]
      const span = lengths[k] - lengths[k - 1] || 1
      const u = (t - lengths[k - 1]) / span
      return { point: add3(a, scale(sub(b, a), u)), direction: normalize(sub(b, a)) }
    }
  }
}

// How far round an arm is (m) along its length: each slice is the convex outline the triangles of that arm
// cut on a plane across it, every centimetre. upperArm: the most round it is between the armpit (the
// sleeve's underarm sits there) and the elbow; forearm: the most round the forearm is in the 12 cm below the
// elbow (a slim sleeve tapers past it). From the arm's reach when the mesh gives no slices.
function armGirths(positions, index, part, which, arm, armpitY) {
  const [shoulder, elbow] = [arm.lengths[1], arm.lengths[2]]
  const upper = [], lower = []
  const round = t => 2 * Math.PI * arm.reachAt(t) * 0.78
  // The arm's own triangles.
  const tris = []
  for (let k = 0; k < index.length; k += 3) {
    if (part[index[k]] === which && part[index[k + 1]] === which && part[index[k + 2]] === which) tris.push(index[k], index[k + 1], index[k + 2])
  }
  for (let t = 0.03; t < elbow - 0.01; t += 0.01) {
    const { point, direction } = arm.along(t)
    const isUpper = t <= shoulder
    if (isUpper && point[1] > armpitY) continue
    if (!isUpper && t > shoulder + 0.12) break
    // Two axes across the arm, and each triangle edge that crosses the plane, projected onto them.
    const u = normalize(Math.abs(direction[1]) < 0.9 ? cross(direction, [0, 1, 0]) : cross(direction, [1, 0, 0]))
    const v = cross(direction, u)
    const pts = []
    const side = i => (positions[3 * i] - point[0]) * direction[0] + (positions[3 * i + 1] - point[1]) * direction[1] + (positions[3 * i + 2] - point[2]) * direction[2]
    for (let k = 0; k < tris.length; k += 3) {
      const a = tris[k], b = tris[k + 1], c = tris[k + 2]
      for (const [i, j] of [[a, b], [b, c], [c, a]]) {
        const di = side(i), dj = side(j)
        if ((di > 0) === (dj > 0)) continue
        const w = di / (di - dj)
        const q = [positions[3 * i] + (positions[3 * j] - positions[3 * i]) * w - point[0], positions[3 * i + 1] + (positions[3 * j + 1] - positions[3 * i + 1]) * w - point[1], positions[3 * i + 2] + (positions[3 * j + 2] - positions[3 * i + 2]) * w - point[2]]
        pts.push([dot(q, u), dot(q, v)])
      }
    }
    const girth = pts.length >= 6 ? hullPerimeter(pts) : round(t)
    ;(isUpper ? upper : lower).push(girth)
  }
  return {
    upperArm: upper.length ? Math.max(...upper) : round(shoulder * 0.65),
    forearm: lower.length ? Math.max(...lower) : round(shoulder + 0.05)
  }
}

// A foot's solid outline, seen from above, in 1 cm slices from the floor to just over the ankle: each slice's
// convex outline ([x, z] points, anticlockwise), or null. A pant hem falling onto a thin, pointed foot can
// slip through it; held outside these outlines it comes to rest on the instep and the heel.
const FOOT_STEP = 0.01

function footHull(positions, part, joints, floor, side) {
  const top = joints[`ankle_${side}`][1] + 0.03
  const rows = Math.ceil((top - floor) / FOOT_STEP)
  const slices = Array.from({ length: rows }, () => [])
  const sign = side === "L" ? 1 : -1
  const n = positions.length / 3
  for (let i = 0; i < n; i++) {
    if (part[i] !== 4 || positions[3 * i] * sign <= 0) continue
    const r = Math.floor((positions[3 * i + 1] - floor) / FOOT_STEP)
    if (r >= 0 && r < rows) slices[r].push([positions[3 * i], positions[3 * i + 2]])
  }
  const hulls = slices.map(pts => (pts.length >= 3 ? convexHull(pts) : null))
  const rounds = hulls.map(h => (h ? h.reduce((sum, [x, z], k) => sum + Math.hypot(h[(k + 1) % h.length][0] - x, h[(k + 1) % h.length][1] - z), 0) : 0))
  return {
    top, floor, step: FOOT_STEP, hulls,
    // The outline at height y, or null above the foot.
    at(y) {
      const r = Math.floor((y - floor) / FOOT_STEP)
      return r >= 0 && r < rows ? hulls[r] : null
    },
    // How low a ring `round` metres round can slip down the foot: the bottom of the lowest slice it still
    // goes round, coming down from the ankle. A snug cuff stops above the ankle bone; a loose hem reaches
    // the floor.
    lowest(round) {
      for (let r = rows - 1; r >= 0; r--) if (rounds[r] > round) return floor + (r + 1) * FOOT_STEP
      return floor
    }
  }
}

// A leg's line (hip joint, knee, ankle) and how far the leg reaches from it along its length (1 cm steps),
// from that leg's skin alone (the left leg is on +x).
function legReach(positions, part, joints, side) {
  const chain = [joints[`hip_${side}`], joints[`knee_${side}`], joints[`ankle_${side}`]]
  const lengths = [0]
  for (let k = 1; k < chain.length; k++) lengths.push(lengths[k - 1] + norm(sub(chain[k], chain[k - 1])))
  const total = lengths[lengths.length - 1]
  const steps = Math.ceil(total / 0.01) + 1
  const reach = new Float32Array(steps)
  const sign = side === "L" ? 1 : -1
  const n = positions.length / 3
  for (let i = 0; i < n; i++) {
    if (part[i] !== 4 || positions[3 * i] * sign <= 0) continue
    // The foot isn't the leg: below the ankle it would count the foot's length as the leg's reach.
    if (positions[3 * i + 1] < chain[2][1]) continue
    const p = vec(positions, i)
    const { t, distance } = project(chain, lengths, p)
    const s = Math.min(Math.max(Math.round(t / 0.01), 0), steps - 1)
    reach[s] = Math.max(reach[s], distance)
  }
  const widened = reach.map((_, s) => Math.max(...[-2, -1, 0, 1, 2].map(d => reach[Math.min(Math.max(s + d, 0), steps - 1)])))
  return {
    chain, lengths, total,
    reachAt(t) { return widened[Math.min(Math.max(Math.round(t / 0.01), 0), steps - 1)] },
    // The point on the leg's line at height y (between the hip and the ankle), and the direction it runs.
    atHeight(y) {
      for (let k = 1; k < chain.length; k++) {
        const a = chain[k - 1], b = chain[k]
        if (y <= a[1] && y >= b[1] || k === chain.length - 1) {
          const u = (a[1] - y) / ((a[1] - b[1]) || 1)
          return { point: add3(a, scale(sub(b, a), u)), direction: normalize(sub(b, a)), t: lengths[k - 1] + u * (lengths[k] - lengths[k - 1]) }
        }
      }
    }
  }
}

// A hand, as the cloth of pants it hangs beside sees it: the slab it fills, from the wrist to its far end, in
// its own frame. along: the hand's direction (wrist to fingertips); inward: level, across it, toward the
// body's middle line; across: the third way (front to back). Per cm down the hand from the wrist: inner and
// outer (how far it reaches toward the body and away from it, from its middle line), lo and hi (how far it
// reaches either way across). Null without a hand.
// which: the arm's part (1 left, 2 right); arm: its armReach; centreAt: the body's middle (z) by height.
export function handShape(positions, part, which, arm, centreAt) {
  const wrist = arm.chain[2], end = arm.chain[3]
  if (!wrist || !end) return null
  const length = norm(sub(end, wrist))
  if (length < 0.02) return null
  const along = normalize(sub(end, wrist))
  const toMiddle = [-wrist[0], 0, centreAt(wrist[1]) - wrist[2]]
  const inward = normalize(sub(toMiddle, scale(along, dot(toMiddle, along))))
  const across = normalize(cross(along, inward))
  const steps = Math.ceil(length / 0.01) + 1
  const inner = new Float32Array(steps).fill(-Infinity), outer = new Float32Array(steps).fill(Infinity)
  const lo = new Float32Array(steps).fill(Infinity), hi = new Float32Array(steps).fill(-Infinity)
  const n = positions.length / 3
  for (let i = 0; i < n; i++) {
    if (part[i] !== which) continue
    const r = sub(vec(positions, i), wrist)
    const t = dot(r, along)
    if (t < 0 || t > length + 0.005) continue
    const s = Math.min(steps - 1, Math.round(t / 0.01)), a = dot(r, inward), b = dot(r, across)
    inner[s] = Math.max(inner[s], a); outer[s] = Math.min(outer[s], a)
    lo[s] = Math.min(lo[s], b); hi[s] = Math.max(hi[s], b)
  }
  // Each step takes in its neighbours (a slice a centimetre thick can miss a knuckle), and a step with no
  // vertices takes the nearest one's.
  const widen = (values, pick) => values.map((_, s) => pick(...[-1, 0, 1].map(d => values[Math.min(Math.max(s + d, 0), steps - 1)])))
  const shape = { wrist, along, inward, across, length, inner: widen(inner, Math.max), outer: widen(outer, Math.min), lo: widen(lo, Math.min), hi: widen(hi, Math.max) }
  if (!shape.inner.some(Number.isFinite)) return null
  for (const key of ["inner", "outer", "lo", "hi"]) {
    const values = shape[key]
    for (let s = 0; s < steps; s++) {
      if (Number.isFinite(values[s])) continue
      let k = 1
      while (!Number.isFinite(values[Math.max(0, s - k)]) && !Number.isFinite(values[Math.min(steps - 1, s + k)])) k++
      values[s] = Number.isFinite(values[Math.max(0, s - k)]) ? values[Math.max(0, s - k)] : values[Math.min(steps - 1, s + k)]
    }
  }
  return shape
}

// Pants' cloth stays on the body's side of the hands hanging beside them, as a hand rests against a pocket:
// cloth in a hand's slab (or lying over its outside, up to `reach` m out) goes in past its inner face, by the
// cloth's thickness. Pants' collision leaves the arms out (an arm swinging down into a pose would trap the
// cloth against the hips), so without this, wide pants end up over the hands. p: positions, changed in
// place; hands: bodyFrame's hands. Returns how many points moved.
export function keepOffHands(p, hands, thick, reach = 0.02) {
  let moved = 0
  const n = p.length / 3
  for (const hand of [hands?.L, hands?.R]) {
    if (!hand) continue
    const { wrist, along, inward, across, length, inner, outer, lo, hi } = hand
    const far = length + 0.08
    for (let i = 0; i < n; i++) {
      const rx = p[3 * i] - wrist[0], ry = p[3 * i + 1] - wrist[1], rz = p[3 * i + 2] - wrist[2]
      if (Math.abs(rx) > far || Math.abs(ry) > far || Math.abs(rz) > far) continue
      const t = rx * along[0] + ry * along[1] + rz * along[2]
      if (t < 0 || t > length + 0.01) continue
      const s = Math.min(inner.length - 1, Math.round(t / 0.01))
      const b = rx * across[0] + ry * across[1] + rz * across[2]
      if (b < lo[s] - thick || b > hi[s] + thick) continue
      const a = rx * inward[0] + ry * inward[1] + rz * inward[2]
      if (a >= inner[s] + thick || a < outer[s] - reach) continue
      const push = inner[s] + thick - a
      p[3 * i] += inward[0] * push; p[3 * i + 1] += inward[1] * push; p[3 * i + 2] += inward[2] * push
      moved++
    }
  }
  return moved
}

// Where a point falls along a polyline (distance from its start) and how far it is from it.
function project(chain, lengths, p) {
  let best = { t: 0, distance: Infinity }
  for (let k = 1; k < chain.length; k++) {
    const a = chain[k - 1], d = sub(chain[k], a)
    const span = dot(d, d)
    const u = Math.min(Math.max(dot(sub(p, a), d) / span, 0), 1)
    const q = add3(a, scale(d, u))
    const distance = norm(sub(p, q))
    if (distance < best.distance) best = { t: lengths[k - 1] + u * Math.sqrt(span), distance }
  }
  return best
}

// The top of the shoulders across the body (2 cm bins either side of the middle), from the neck out past the
// shoulder joints.
function shoulderProfile(positions, part, joints) {
  const bins = 40, width = 0.02
  const top = new Float32Array(bins).fill(-Infinity)
  const neck = joints.neck
  const n = positions.length / 3
  for (let i = 0; i < n; i++) {
    if (part[i] === 4) continue
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2]
    if (Math.abs(z - neck[2]) > 0.14 || y > neck[1] + 0.03 || y < neck[1] - 0.25) continue
    const b = Math.min(Math.floor(Math.abs(x) / width), bins - 1)
    top[b] = Math.max(top[b], y)
  }
  for (let b = 1; b < bins; b++) if (!isFinite(top[b])) top[b] = top[b - 1]
  return { at(x) { return top[Math.min(Math.floor(Math.abs(x) / width), bins - 1)] } }
}

// Half the neck's width at its base, side to side.
function neckWidth(positions, part, neck) {
  let half = 0
  const n = positions.length / 3
  for (let i = 0; i < n; i++) {
    if (part[i] !== 3) continue
    if (Math.abs(positions[3 * i + 1] - (neck[1] + 0.01)) > 0.008) continue
    half = Math.max(half, Math.abs(positions[3 * i]))
  }
  return half || 0.065
}

// The height of the armpits: going down from the shoulder, where the inside of the arm parts from the side of
// the torso (the gap between them opens past a few centimetres; the mesh is coarse, so slices are thick).
function armpit(positions, part, joints) {
  const shoulder = joints.shoulder_L
  const n = positions.length / 3
  for (let y = shoulder[1] - 0.06; y > shoulder[1] - 0.35; y -= 0.004) {
    let torsoX = 0, armX = Infinity
    for (let i = 0; i < n; i++) {
      if (Math.abs(positions[3 * i + 1] - y) > 0.006 || positions[3 * i] < 0) continue
      if (part[i] === 0) torsoX = Math.max(torsoX, positions[3 * i])
      else if (part[i] === 1) armX = Math.min(armX, positions[3 * i])
    }
    if (armX - torsoX > 0.045) return y + 0.01
  }
  return shoulder[1] - 0.14
}

// Round the neck just above where it meets the shoulders (m): the convex outline of a thin slice.
function neckRound(positions, part, neck) {
  const pts = []
  const n = positions.length / 3
  for (let i = 0; i < n; i++) {
    if (part[i] !== 3 || Math.abs(positions[3 * i + 1] - (neck[1] + 0.025)) > 0.006) continue
    pts.push([positions[3 * i], positions[3 * i + 2]])
  }
  return hullPerimeter(pts) || 0.4
}

function hullPerimeter(points) {
  if (points.length < 3) return 0
  const hull = convexHull(points)
  let total = 0
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length]
    total += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  return total
}

// The head: its middle, its radius side to side and front to back, and its top.
function headShape(positions, part, joints) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  const n = positions.length / 3
  const above = joints.head[1]
  for (let i = 0; i < n; i++) {
    if (part[i] !== 3 || positions[3 * i + 1] < above) continue
    for (let c = 0; c < 3; c++) {
      lo[c] = Math.min(lo[c], positions[3 * i + c]); hi[c] = Math.max(hi[c], positions[3 * i + c])
    }
  }
  const top = hi[1]
  // The middle of the skull: halfway up and side to side; front to back, a little behind the box's middle
  // (the nose sticks out in front).
  const centre = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2] + (hi[2] - lo[2]) * 0.45]
  let rx = 0, rz = 0
  for (let i = 0; i < n; i++) {
    if (part[i] !== 3 || Math.abs(positions[3 * i + 1] - centre[1]) > 0.02) continue
    rx = Math.max(rx, Math.abs(positions[3 * i] - centre[0]))
    rz = Math.max(rz, Math.abs(positions[3 * i + 2] - centre[2]))
  }
  return { centre, rx, rz, top }
}

// The skin as a signed distance field: on a grid (1 cm) reaching a few centimetres either side of the skin,
// how far each grid point is outside it (negative inside) and the skin's normal nearest it. Looking a point
// up blends the eight grid points round it, which is far quicker than finding the nearest triangle, so the
// cloth can be checked against the skin at every small step. positions, normals: Float32Array (3 per
// vertex); index: the triangles. keep: which vertices count (Uint8Array, 1 to keep; a triangle counts when all
// three do), to leave out what the cloth can't reach. ellipsoids: [{ centre, radii }] solid shapes added to
// the skin (a display mannequin's egg head).
export class SkinField {
  constructor(positions, normals, index, { cell = 0.01, band = 0.025, keep = null, ellipsoids = [] } = {}) {
    const n = positions.length / 3
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < n; i++) {
      if (keep && !keep[i]) continue
      for (let c = 0; c < 3; c++) {
        lo[c] = Math.min(lo[c], positions[3 * i + c]); hi[c] = Math.max(hi[c], positions[3 * i + c])
      }
    }
    for (const { centre, radii } of ellipsoids) {
      for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], centre[c] - radii[c]); hi[c] = Math.max(hi[c], centre[c] + radii[c]) }
    }
    this.ellipsoids = ellipsoids.map(({ centre, radii }) => ({ centre: [...centre], radii: [...radii] }))
    const pad = band + 2 * cell
    this.cell = cell
    this.band = band
    this.min = lo.map(v => v - pad)
    this.dims = [0, 1, 2].map(c => Math.ceil((hi[c] - lo[c] + 2 * pad) / cell) + 1)
    const [nx, ny, nz] = this.dims
    const count = nx * ny * nz
    const distance = new Float32Array(count).fill(band)
    const normal = new Int8Array(3 * count)
    const best = new Float32Array(count).fill(band * band)
    const q = new Float64Array(5)
    const P = positions, N = normals, min = this.min
    for (let t = 0; t < index.length; t += 3) {
      const a = index[t], b = index[t + 1], c = index[t + 2]
      if (keep && (!keep[a] || !keep[b] || !keep[c])) continue
      const range = []
      for (let k = 0; k < 3; k++) {
        const low = Math.min(P[3 * a + k], P[3 * b + k], P[3 * c + k]) - band
        const high = Math.max(P[3 * a + k], P[3 * b + k], P[3 * c + k]) + band
        range.push(Math.max(0, Math.ceil((low - min[k]) / cell)), Math.min(this.dims[k] - 1, Math.floor((high - min[k]) / cell)))
      }
      for (let iz = range[4]; iz <= range[5]; iz++) {
        const gz = min[2] + iz * cell
        for (let iy = range[2]; iy <= range[3]; iy++) {
          const gy = min[1] + iy * cell
          for (let ix = range[0]; ix <= range[1]; ix++) {
            const gx = min[0] + ix * cell
            closestOnTriangle(gx, gy, gz, P, a, b, c, q)
            const dx = gx - q[0], dy = gy - q[1], dz = gz - q[2]
            const d2 = dx * dx + dy * dy + dz * dz
            const g = (iz * ny + iy) * nx + ix
            if (d2 >= best[g]) continue
            best[g] = d2
            const u = q[3], w = q[4], s = 1 - u - w
            let mx = N[3 * a] * s + N[3 * b] * u + N[3 * c] * w
            let my = N[3 * a + 1] * s + N[3 * b + 1] * u + N[3 * c + 1] * w
            let mz = N[3 * a + 2] * s + N[3 * b + 2] * u + N[3 * c + 2] * w
            const l = Math.hypot(mx, my, mz) || 1
            mx /= l; my /= l; mz /= l
            const d = Math.sqrt(d2)
            distance[g] = dx * mx + dy * my + dz * mz >= 0 ? d : -d
            normal[3 * g] = Math.round(mx * 127); normal[3 * g + 1] = Math.round(my * 127); normal[3 * g + 2] = Math.round(mz * 127)
          }
        }
      }
    }
    this.distance = distance
    this.normal = normal
    this.hit = new Float32Array(3)   // the skin's normal at the last point looked up
  }

  // How far (x, y, z) is outside the skin (negative inside), with the skin's normal there left in this.hit;
  // this.band when it isn't near the skin.
  at(x, y, z) {
    const d = this.grid(x, y, z)
    if (this.ellipsoids.length === 0) return d
    let best = d
    for (const { centre, radii } of this.ellipsoids) {
      // Near the surface, |p/r| - 1 scaled by |p/r| / |p/r²| is close to the true distance.
      const px = (x - centre[0]) / radii[0], py = (y - centre[1]) / radii[1], pz = (z - centre[2]) / radii[2]
      const k0 = Math.hypot(px, py, pz)
      const gx = px / radii[0], gy = py / radii[1], gz = pz / radii[2]
      const k1 = Math.hypot(gx, gy, gz)
      if (k1 < 1e-9) continue
      const e = (k0 * (k0 - 1)) / k1
      if (e < best) {
        best = e
        this.hit[0] = gx / k1; this.hit[1] = gy / k1; this.hit[2] = gz / k1
      }
    }
    return best
  }

  grid(x, y, z) {
    const cell = this.cell, min = this.min
    const fx = (x - min[0]) / cell, fy = (y - min[1]) / cell, fz = (z - min[2]) / cell
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz)
    const nx = this.dims[0], ny = this.dims[1], nz = this.dims[2]
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx - 1 || iy >= ny - 1 || iz >= nz - 1) return this.band
    const u = fx - ix, v = fy - iy, w = fz - iz
    const D = this.distance, M = this.normal
    const g = (iz * ny + iy) * nx + ix, row = nx, layer = nx * ny
    let d = 0, mx = 0, my = 0, mz = 0
    for (let k = 0; k < 8; k++) {
      const ox = k & 1, oy = (k >> 1) & 1, oz = k >> 2
      const weight = (ox ? u : 1 - u) * (oy ? v : 1 - v) * (oz ? w : 1 - w)
      const j = g + ox + oy * row + oz * layer
      d += D[j] * weight
      mx += M[3 * j] * weight; my += M[3 * j + 1] * weight; mz += M[3 * j + 2] * weight
    }
    const l = Math.hypot(mx, my, mz)
    if (l < 1e-3) return this.band
    const h = this.hit
    h[0] = mx / l; h[1] = my / l; h[2] = mz / l
    return d
  }
}

// The point of triangle abc nearest to p, into out [x, y, z, weight of b, weight of c] (Ericson, Real-Time
// Collision Detection, 5.1.5).
function closestOnTriangle(px, py, pz, P, a, b, c, out) {
  const ax = P[3 * a], ay = P[3 * a + 1], az = P[3 * a + 2]
  const bx = P[3 * b], by = P[3 * b + 1], bz = P[3 * b + 2]
  const cx = P[3 * c], cy = P[3 * c + 1], cz = P[3 * c + 2]
  const abx = bx - ax, aby = by - ay, abz = bz - az
  const acx = cx - ax, acy = cy - ay, acz = cz - az
  const apx = px - ax, apy = py - ay, apz = pz - az
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz
  let v, w
  if (d1 <= 0 && d2 <= 0) { v = 0; w = 0 } else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz
    if (d3 >= 0 && d4 <= d3) { v = 1; w = 0 } else {
      const vc = d1 * d4 - d3 * d2
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { v = d1 / (d1 - d3); w = 0 } else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz
        const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz
        if (d6 >= 0 && d5 <= d6) { v = 0; w = 1 } else {
          const vb = d5 * d2 - d1 * d6
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { v = 0; w = d2 / (d2 - d6) } else {
            const va = d3 * d6 - d5 * d4
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); v = 1 - w } else {
              const denom = 1 / (va + vb + vc)
              v = vb * denom; w = vc * denom
            }
          }
        }
      }
    }
  }
  out[0] = ax + abx * v + acx * w; out[1] = ay + aby * v + acy * w; out[2] = az + abz * v + acz * w
  out[3] = v; out[4] = w
}

// Vector helpers on [x, y, z] arrays.
export function vec(a, i) { return [a[3 * i], a[3 * i + 1], a[3 * i + 2]] }
export function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
export function add3(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]] }
export function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s] }
export function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
export function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
export function norm(a) { return Math.hypot(a[0], a[1], a[2]) }
export function normalize(a) { const l = norm(a) || 1; return [a[0] / l, a[1] / l, a[2] / l] }
