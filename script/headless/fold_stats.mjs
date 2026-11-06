// For render.mjs --script: the folds' numbers for each garment on (wrinkles.js): how much of the cloth is
// squeezed past the fold threshold, the amplitude's spread (mm), and the fine mesh's size.
export default async function (stage) {
  const deadline = Date.now() + 300000
  while (!stage.settled && Date.now() < deadline) { stage.advanceDrape(); await new Promise(r => setTimeout(r, 0)) }
  const out = {}
  for (const [slot, d] of Object.entries(stage.slots)) {
    if (!d?.top) continue
    const fine = d.top.fine
    const amp = fine?.amp
    let folded = 0, max = 0, sum = 0
    if (amp) for (const a of amp) { if (a > 0) { folded++; sum += a; max = Math.max(max, a) } }
    out[slot] = { coarse: d.top.cloth.points.length, fine: fine?.count ?? null, wavelengthCm: d.top.wavelength ?? null,
      foldedShare: amp ? +(folded / amp.length).toFixed(3) : 0, ampMeanMm: folded ? +(sum / folded * 1000).toFixed(2) : 0, ampMaxMm: +(max * 1000).toFixed(2) }
  }
  out.updateMs = await timing(stage)
  return out
}
// (Timing: how long a frame's fine-mesh update takes per garment, ms, averaged over 10.)
export async function timing(stage) {
  const out = {}
  for (const [slot, d] of Object.entries(stage.slots)) {
    if (!d?.top?.fine) continue
    let t = performance.now()
    for (let k = 0; k < 10; k++) d.top.fine.update()
    const fine = (performance.now() - t) / 10
    t = performance.now()
    for (let k = 0; k < 10; k++) { d.top.foldsAt = 0; d.top.markStrain() }
    out[slot] = { fineMs: +fine.toFixed(1), strainAndFoldsMs: +((performance.now() - t) / 10).toFixed(1) }
  }
  return out
}
