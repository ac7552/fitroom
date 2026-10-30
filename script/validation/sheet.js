// Contact sheets of finished runs, to grade them (development only): each run a row of its garments' shop
// photos, then the outfit from the front, the wearer's left and behind. In the page, after runner.js:
//   const sheet = (await import("/validation/sheet.js")).default
//   await sheet(["m-tb-001", ...])   // a JPEG data URL
// big: one run a row at the pictures' own size (5 runs make a sheet about 1170 x 1650), for reading graphics.
export default async function sheet(keys, { big = false, cols = big ? 1 : 2, rowH = big ? 336 : 232 } = {}) {
  const pw = big ? 180 : 110, ph = big ? 300 : 190, vw = big ? 200 : 132, vh = big ? 300 : 198
  const V = window.__val, runs = keys.map(k => V.results[k]).filter(Boolean)
  const load = src => new Promise(res => { if (!src) return res(null); const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src })
  const cellW = big ? 1180 : 760, W = cellW * cols, H = Math.max(1, Math.ceil(runs.length / cols)) * rowH
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H
  const g = cv.getContext("2d")
  g.fillStyle = "#fff"; g.fillRect(0, 0, W, H); g.font = "13px sans-serif"
  for (let n = 0; n < runs.length; n++) {
    const r = runs[n], ox = (n % cols) * cellW, oy = Math.floor(n / cols) * rowH
    g.fillStyle = "#000"; g.fillText(r.key + (r.settled === false ? "  (not settled)" : ""), ox + 4, oy + 14)
    let x = ox + 4
    for (const it of r.items) {
      const im = await load(it.photoThumb)
      g.fillStyle = "#eee"; g.fillRect(x, oy + 20, pw, ph)
      if (im) { const k = Math.min(pw / im.width, ph / im.height); g.drawImage(im, x + (pw - im.width * k) / 2, oy + 20 + (ph - im.height * k) / 2, im.width * k, im.height * k) }
      g.fillStyle = it.error ? "#c00" : "#333"
      g.fillText(`${it.error ? "ERR " : ""}${it.cat}: ${it.style ?? it.kind ?? "?"}`, x, oy + ph + 35)
      x += pw + 4
    }
    for (const view of ["front", "side", "back"]) {
      const im = await load(r.pics?.[view])
      if (im) g.drawImage(im, x, oy + 18, vw, vh)
      x += vw + 2
    }
  }
  return cv.toDataURL("image/jpeg", 0.82)
}
