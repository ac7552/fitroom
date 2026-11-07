// Like export.js, for a browser whose downloads can't be reached (a remote session driving the page): each
// finished run's contact sheet and record are posted to the dev server, which writes them into
// log/development.log as a request's parameters; collect_log.py takes them out into tmp/kith/<out>/raw. The
// post is answered 422 (it's no garment), which is expected. In the page, after runner.js:
//
//   const exportLog = (await import("/validation/export_log.js")).default
//   await exportLog(VAL, "step1")         // then: python3 script/validation/collect_log.py step1
const load = s => new Promise(res => { if (!s) return res(null); const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = s })
export default async function exportLog(VAL, tag) {
  window.__logged ??= new Set()
  const H = 480
  let sent = 0
  for (const r of Object.values(VAL.results)) {
    if (window.__logged.has(r.key)) continue
    const it = r.items?.[0] ?? {}
    const imgs = (await Promise.all([it.photoThumb, r.pics?.front, r.pics?.side, r.pics?.back].map(load))).filter(Boolean)
    let jpeg = null
    if (imgs.length) {
      const W = imgs.reduce((a, i) => a + i.width * H / i.height, 0), c = document.createElement("canvas")
      c.width = Math.round(W); c.height = H + 28
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height)
      let x = 0; for (const i of imgs) { const w = i.width * H / i.height; g.drawImage(i, x, 28, w, H); x += w }
      g.fillStyle = "#000"; g.font = "16px sans-serif"
      g.fillText(`${r.key} | ${it.name ?? ""} | ${it.kind ?? ""}/${it.style ?? ""} ${it.fabric ?? ""} photo ${it.photoIndex ?? "-"} ${it.photoRole ?? ""} back ${it.backIndex ?? "-"} ${it.error ?? ""} ${(r.errors || []).join(";")}`.slice(0, 220), 6, 19)
      jpeg = c.toDataURL("image/jpeg", 0.82)
    }
    const record = { ...r, pics: undefined, items: (r.items || []).map(i => ({ ...i, photoThumb: undefined })) }
    // (The record as base64, so the log's quoting of its words and their accents can't garble it.)
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(record))))
    const body = JSON.stringify({ probe_marker: `FITROOM_RUN ${tag}`, key: r.key, record: b64, sheet: jpeg })
    await fetch("/api/v1/garment_imports", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body }).catch(() => null)
    window.__logged.add(r.key); sent++
  }
  return [tag, sent, Object.keys(VAL.results).length, VAL.runs.length]
}
