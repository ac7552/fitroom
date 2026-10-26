// Measures a body from two photos: one from the front, one from the side, plus the person's typed height.
//
// Everything happens in the browser tab. MediaPipe's Pose Landmarker (Apache-2.0) finds 33 body points and
// a person mask in each photo; the maths below turns those into the six numbers step 2 asks for. The photos
// are decoded into bitmaps, read once, and closed. They're never drawn into a canvas that stays around,
// never put in storage, and never sent anywhere. Only the model and its runtime are downloaded.
//
// landmarksToMeasurements() and silhouette() are pure (no MediaPipe types), so Node can test them. The
// MediaPipe runtime is loaded lazily, by a dynamic import of a pinned CDN URL, only when the person asks.

// Pinned: a dynamic import() of an absolute URL needs no importmap pin, and the page only pays for this
// download when someone clicks "Measure from photos".
const CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1"
const MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task"
// Photos are shrunk to this on their longest side before the model sees them: enough for the mask, quick on a phone.
const MAX_PX = 1024

// The MediaPipe pose landmarks this uses, by index (there are 33).
export const LANDMARK = {
  nose: 0, leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14, leftWrist: 15, rightWrist: 16,
  leftHip: 23, rightHip: 24, leftAnkle: 27, rightAnkle: 28, leftHeel: 29, rightHeel: 30
}
const NEEDED = Object.values(LANDMARK)

// Most people's measurements (Fit::MEASUREMENTS usual ranges, cm). Results outside are clamped and flagged.
export const USUAL = { chest: [80, 135], waist: [60, 130], shoulders: [38, 54], arm: [52, 72], hips: [82, 135], inseam: [66, 92] }

// Body proportions (shares of the standing height, from standard anthropometric tables) and tape factors.
const NOSE_TO_HEEL = 0.89       // the nose sits about 11% of the height below the top of the head; the heel points sit on the floor
const ANKLE_TO_FLOOR = 0.04     // the ankle points are about this far above the floor (7 cm on 178 cm)
const CROTCH_BELOW_HIP = 0.15   // the hip points sit this share of the hip-to-ankle length above the crotch
const SHOULDER_TAPE = 1.05      // a tape over the shoulder points runs a little further than the straight line
const WRIST_BONE_CM = 2         // the wrist point is a little short of the wrist bone the tape reaches
const CHEST_LINE = 0.25         // the chest line, as a share of the way from the shoulder points down to the hip points
const WAIST_LINE = 0.55         // the waist line, when no silhouette finds the narrowest place
const HIP_LINE = 1.1            // the hip line sits just below the hip points, when no silhouette finds the widest place
const SECTION = 1.06            // a torso's cross-section is squarer than an ellipse, so its edge is a little longer
const CLOTHES = 1.03            // a tape over fitted clothes
// Without a silhouette: front widths as shares of the shoulder-point span, hips also from the hip-point span,
// and side depths as shares of the front widths.
const WIDTH_OF_SHOULDERS = { chest: 0.78, waist: 0.68, hips: 0.8 }
const HIPS_OF_HIP_POINTS = 1.6
const DEPTH_OF_WIDTH = { chest: 0.71, waist: 0.73, hips: 0.65 }

// Loads MediaPipe's runtime and the pose model once (GPU first, else CPU). Rejects when offline or blocked.
let landmarkerPromise = null
export function loadPoseLandmarker() {
  landmarkerPromise ??= createLandmarker().catch(error => { landmarkerPromise = null; throw error })
  return landmarkerPromise
}

async function createLandmarker() {
  const { FilesetResolver, PoseLandmarker } = await import(`${CDN}/vision_bundle.mjs`)
  const vision = await FilesetResolver.forVisionTasks(`${CDN}/wasm`)
  const options = delegate => ({
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: "IMAGE", numPoses: 1, outputSegmentationMasks: true
  })
  try {
    return await PoseLandmarker.createFromOptions(vision, options("GPU"))
  } catch {
    return await PoseLandmarker.createFromOptions(vision, options("CPU"))
  }
}

// frontFile, sideFile: image Files. heightCm: the typed height. onProgress(text) gets plain-word updates.
// Resolves to { chest, waist, hips, shoulders, arm, inseam, confidence, notes }.
export async function measureFromPhotos(frontFile, sideFile, heightCm, { onProgress = () => {} } = {}) {
  onProgress("Loading the photo tool…")
  const landmarker = await loadPoseLandmarker()

  onProgress("Looking at the front photo…")
  const front = await readPhoto(landmarker, frontFile, "front")
  onProgress("Looking at the side photo…")
  const side = await readPhoto(landmarker, sideFile, "side")

  onProgress("Working out your numbers…")
  return landmarksToMeasurements({
    front: front.landmarks, frontSize: front.size, frontSilhouette: front.silhouette,
    side: side.landmarks, sideSize: side.size, sideSilhouette: side.silhouette,
    heightCm
  })
}

// Decodes one photo (shrunk to MAX_PX), finds the pose and the person's outline, then closes the bitmap. The
// callback form of detect() is used so the mask isn't copied; it's read inside the callback and dropped.
async function readPhoto(landmarker, file, which) {
  const bitmap = await decode(file)
  try {
    let found = null
    landmarker.detect(bitmap, result => {
      const landmarks = result.landmarks?.[0]
      if (!landmarks) return
      const hips = [landmarks[LANDMARK.leftHip], landmarks[LANDMARK.rightHip]]
      const centerX = (hips[0].x + hips[1].x) / 2
      const mask = result.segmentationMasks?.[0]
      const outline = mask ? silhouette(maskData(mask), { centerX }) : null
      found = { landmarks: landmarks.map(({ x, y, z, visibility }) => ({ x, y, z, visibility })), silhouette: outline }
    })
    if (!found) {
      throw plain(`We couldn't find a whole person in the ${which} photo. Make sure your head and your feet are both in it.`)
    }
    return { ...found, size: { width: bitmap.width, height: bitmap.height } }
  } finally {
    bitmap.close()
  }
}

async function decode(file) {
  let bitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw plain("We couldn't open that photo. Try a JPEG or PNG.")
  }
  const longest = Math.max(bitmap.width, bitmap.height)
  if (longest <= MAX_PX) return bitmap
  const scale = MAX_PX / longest
  const small = await createImageBitmap(bitmap, {
    resizeWidth: Math.round(bitmap.width * scale), resizeHeight: Math.round(bitmap.height * scale), resizeQuality: "high"
  })
  bitmap.close()
  return small
}

// A MediaPipe MPMask as plain data: { width, height, data } with data 0..1 (Float32Array) or 0..255 (Uint8Array).
function maskData(mask) {
  const data = mask.hasFloat32Array() ? mask.getAsFloat32Array() : mask.getAsUint8Array()
  return { width: mask.width, height: mask.height, data }
}

// The person's outline from a mask, row by row: the width (in mask pixels) of the run of person pixels that
// contains the body's centre column, so arms held a little out aren't counted. Rows where the centre column
// isn't on the person (between the legs, above the head) are 0.
// image: { width, height, data }, data one value per pixel, 0..1 or 0..255. centerX: normalized 0..1.
export function silhouette(image, { centerX = 0.5, threshold = null } = {}) {
  const { width, height, data } = image
  const cutoff = threshold ?? (data instanceof Uint8Array || data instanceof Uint8ClampedArray ? 128 : 0.5)
  const widths = new Float32Array(height)
  const cx = Math.min(width - 1, Math.max(0, Math.round(centerX * width)))
  let top = -1, bottom = -1
  for (let row = 0; row < height; row++) {
    const start = row * width
    let any = false
    for (let x = 0; x < width; x++) if (data[start + x] >= cutoff) { any = true; break }
    if (any) { if (top < 0) top = row; bottom = row }
    if (data[start + cx] < cutoff) continue
    let left = cx, right = cx
    while (left > 0 && data[start + left - 1] >= cutoff) left--
    while (right < width - 1 && data[start + right + 1] >= cutoff) right++
    widths[row] = right - left + 1
  }
  return { width, height, widths, top, bottom }
}

// The six measurements from two sets of 33 normalized landmarks ({ x, y, z, visibility }, MediaPipe order).
//   front, side: the landmarks; frontSize, sideSize: { width, height } of each photo in pixels.
//   heightCm: the person's typed height. frontSilhouette, sideSilhouette: from silhouette(), optional.
// Returns cm (rounded to 0.5) for chest, waist, hips, shoulders, arm and inseam, a confidence 0..1, and notes
// in plain words about anything that was unsure.
export function landmarksToMeasurements({ front, side, heightCm, frontSize, sideSize, frontSilhouette = null, sideSilhouette = null }) {
  if (!(heightCm > 0)) throw plain("We need your height to work out the size of the photos.")
  if (!complete(front)) throw plain("We couldn't find a whole person in the front photo. Make sure your head and your feet are both in it.")
  if (!complete(side)) throw plain("We couldn't find a whole person in the side photo. Make sure your head and your feet are both in it.")

  const notes = []
  let confidence = 1
  const f = view(front, frontSize, heightCm)
  const s = view(side, sideSize, heightCm)

  const seen = [...NEEDED.map(i => front[i].visibility ?? 1), ...NEEDED.map(i => side[i].visibility ?? 1)]
  const visibility = seen.reduce((a, b) => a + b, 0) / seen.length
  if (visibility < 0.8) {
    confidence *= Math.max(0.4, visibility)
    notes.push("Some parts of your body were hard to see.")
  }
  const lean = Math.abs(f.at(LANDMARK.nose).x - f.mid(LANDMARK.leftHeel, LANDMARK.rightHeel).x) / f.bodyPx
  if (lean > 0.08) { confidence *= 0.85; notes.push("You looked like you were leaning. Stand straight for a better guess.") }

  // Lengths, straight from the points.
  const shoulderSpan = f.dist(LANDMARK.leftShoulder, LANDMARK.rightShoulder) * f.cmPerPx
  const shoulders = shoulderSpan * SHOULDER_TAPE
  const arms = [[11, 13, 15], [12, 14, 16]].map(([a, b, c]) => (f.dist(a, b) + f.dist(b, c)) * f.cmPerPx)
  const arm = (arms[0] + arms[1]) / 2 + WRIST_BONE_CM
  if (Math.abs(arms[0] - arms[1]) > 0.1 * arm) { confidence *= 0.9; notes.push("Your two arms measured differently. Hold them the same way, a little out from your sides.") }
  const hipToAnkle = (f.mid(LANDMARK.leftAnkle, LANDMARK.rightAnkle).y - f.mid(LANDMARK.leftHip, LANDMARK.rightHip).y) * f.cmPerPx
  const inseam = hipToAnkle * (1 - CROTCH_BELOW_HIP) + ANKLE_TO_FLOOR * heightCm

  // Girths: a front width and a side depth at the chest, waist and hip lines, each treated as an ellipse.
  const lines = torsoLines(f, frontSilhouette, shoulderSpan, notes)
  if (!frontSilhouette) { confidence *= 0.7; notes.push("We couldn't see your outline in the front photo, so the chest, waist and hips are rough.") }
  if (!sideSilhouette) { confidence *= 0.7; notes.push("We couldn't see your outline in the side photo, so the chest, waist and hips are rough.") }
  if (frontSilhouette && armsClose(f, shoulderSpan)) { confidence *= 0.85; notes.push("Your arms were close to your body, so the chest and waist may read big.") }

  const girths = {}
  for (const part of ["chest", "waist", "hips"]) {
    const { t, widthCm } = lines[part]
    let depthCm = sideSilhouette ? depthAt(s, sideSilhouette, t) : null
    if (depthCm == null) depthCm = widthCm * DEPTH_OF_WIDTH[part]
    girths[part] = ellipse(widthCm / 2, depthCm / 2) * SECTION * CLOTHES
  }

  const raw = { chest: girths.chest, waist: girths.waist, hips: girths.hips, shoulders, arm, inseam }
  const result = {}
  const clamped = []
  for (const [part, value] of Object.entries(raw)) {
    const [min, max] = USUAL[part]
    const kept = Math.min(max, Math.max(min, value))
    if (kept !== value) clamped.push(part)
    result[part] = Math.round(kept * 2) / 2
  }
  if (clamped.length) {
    confidence *= Math.pow(0.7, clamped.length)
    notes.push(`The ${listed(clamped.map(words))} came out outside the usual range, so we used the nearest usual number. Check ${clamped.length === 1 ? "it" : "them"}.`)
  }
  return { ...result, confidence: Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100, notes }
}

// One photo's landmarks in pixels, with the cm-per-pixel scale from the typed height.
function view(landmarks, size, heightCm) {
  const { width, height } = size
  const at = i => ({ x: landmarks[i].x * width, y: landmarks[i].y * height })
  const mid = (a, b) => ({ x: (at(a).x + at(b).x) / 2, y: (at(a).y + at(b).y) / 2 })
  const dist = (a, b) => Math.hypot(at(a).x - at(b).x, at(a).y - at(b).y)
  const noseToHeel = mid(LANDMARK.leftHeel, LANDMARK.rightHeel).y - at(LANDMARK.nose).y
  if (!(noseToHeel > 0)) throw plain("The person in the photo needs to be standing up, head at the top.")
  const bodyPx = noseToHeel / NOSE_TO_HEEL
  return { width, height, at, mid, dist, bodyPx, cmPerPx: heightCm / bodyPx }
}

// Where the chest, waist and hip lines are (t: share of the way from the shoulder points to the hip points)
// and how wide the body is there in cm, from the front silhouette when there is one.
function torsoLines(f, sil, shoulderSpan, notes) {
  const shoulderY = f.mid(LANDMARK.leftShoulder, LANDMARK.rightShoulder).y
  const hipY = f.mid(LANDMARK.leftHip, LANDMARK.rightHip).y
  const span = hipY - shoulderY
  const guess = { chest: shoulderSpan * WIDTH_OF_SHOULDERS.chest, waist: shoulderSpan * WIDTH_OF_SHOULDERS.waist,
    hips: Math.max(shoulderSpan * WIDTH_OF_SHOULDERS.hips, f.dist(LANDMARK.leftHip, LANDMARK.rightHip) * f.cmPerPx * HIPS_OF_HIP_POINTS) }
  const lines = { chest: { t: CHEST_LINE, widthCm: guess.chest }, waist: { t: WAIST_LINE, widthCm: guess.waist }, hips: { t: HIP_LINE, widthCm: guess.hips } }
  if (!sil) return lines

  const widthAt = row => (row >= 0 && row < sil.height ? sil.widths[row] * (f.width / sil.width) * f.cmPerPx : 0)
  const rowAt = t => Math.round(((shoulderY + t * span) / f.height) * sil.height)
  const tOf = row => ((row / sil.height) * f.height - shoulderY) / span
  const pick = (fromT, toT, better) => {
    let best = null
    for (let row = rowAt(fromT); row <= rowAt(toT); row++) {
      const w = widthAt(row)
      if (w > 0 && (best == null || better(w, best.w))) best = { row, w }
    }
    return best
  }
  const near = row => widthAt(row) || widthAt(row - 1) || widthAt(row + 1) || widthAt(row - 2) || widthAt(row + 2)

  const chest = near(rowAt(CHEST_LINE))
  if (chest) lines.chest.widthCm = chest
  const waist = pick(CHEST_LINE, 1, (w, best) => w < best)
  const hips = waist ? pick(tOf(waist.row), HIP_LINE, (w, best) => w > best) : null
  if (waist) lines.waist = { t: tOf(waist.row), widthCm: waist.w }
  if (hips) lines.hips = { t: tOf(hips.row), widthCm: hips.w }
  if (!chest || !waist || !hips) notes.push("Your outline was hard to follow in the front photo. Wear fitted clothes against a plain wall.")
  return lines
}

// The body's depth (cm) in the side photo at the same share of the way down the torso, or null.
function depthAt(s, sil, t) {
  const shoulderY = s.mid(LANDMARK.leftShoulder, LANDMARK.rightShoulder).y
  const hipY = s.mid(LANDMARK.leftHip, LANDMARK.rightHip).y
  const row = Math.round(((shoulderY + t * (hipY - shoulderY)) / s.height) * sil.height)
  for (const step of [0, -1, 1, -2, 2, -3, 3]) {
    const w = sil.widths[row + step]
    if (w > 0) return w * (s.width / sil.width) * s.cmPerPx
  }
  return null
}

// Elbows less than 5% of the body height out from the shoulders: the upper arms are against the torso.
function armsClose(f, shoulderSpan) {
  const out = [[LANDMARK.leftShoulder, LANDMARK.leftElbow], [LANDMARK.rightShoulder, LANDMARK.rightElbow]]
    .map(([s, e]) => Math.abs(f.at(e).x - f.at(s).x) / f.bodyPx)
  return Math.min(...out) < 0.05
}

// Ramanujan's close guess at an ellipse's edge length, from its half-width a and half-depth b.
export function ellipse(a, b) {
  const h = ((a - b) / (a + b)) ** 2
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)))
}

function complete(landmarks) {
  return Array.isArray(landmarks) && landmarks.length >= 33 && NEEDED.every(i => Number.isFinite(landmarks[i]?.x) && Number.isFinite(landmarks[i]?.y))
}

const WORDS = { chest: "chest", waist: "waist", hips: "hips", shoulders: "shoulders", arm: "arm", inseam: "leg" }
function words(part) { return WORDS[part] ?? part }
function listed(items) {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`
}

// An error in words the page can show as they are (any other error means the tool itself failed).
function plain(message) {
  const error = new Error(message)
  error.plain = true
  return error
}
