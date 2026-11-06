// The yarn pitch of a cloth close-up (see texture.js). No DOM or three.js here, so it can be tested in Node.

// The first clear peak of the luminance's autocorrelation along x (pixels), from 3 up to a quarter of the
// width, over the middle rows; null for no clear peak (a plain cloth, or one whose pitch is under 3 px).
export function yarnPitch(data, size) {
  const rows = []
  for (let y = Math.round(size * 0.3); y < size * 0.7; y += 4) {
    const row = new Float32Array(size)
    let mean = 0
    for (let x = 0; x < size; x++) { const i = 4 * (y * size + x); row[x] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; mean += row[x] }
    mean /= size
    for (let x = 0; x < size; x++) row[x] -= mean
    rows.push(row)
  }
  const most = Math.floor(size / 4)
  const corr = new Float32Array(most + 1)
  for (let lag = 0; lag <= most; lag++) {
    let sum = 0, count = 0
    for (const row of rows) for (let x = 0; x + lag < size; x++) { sum += row[x] * row[x + lag]; count++ }
    corr[lag] = count ? sum / count : 0
  }
  if (!(corr[0] > 0)) return null
  for (let lag = 1; lag <= most; lag++) corr[lag] /= corr[0]
  // The first local maximum past the first trough, standing clearly above its neighbours and above 0.1.
  let trough = -1
  for (let lag = 2; lag < most; lag++) { if (corr[lag] < corr[lag - 1] && corr[lag] < corr[lag + 1]) { trough = lag; break } }
  if (trough < 0) return null
  for (let lag = Math.max(3, trough + 1); lag < most; lag++) {
    if (corr[lag] > 0.1 && corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1]) return lag
  }
  return null
}

