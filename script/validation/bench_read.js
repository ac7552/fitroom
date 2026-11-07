// The photo's reading timed on its own (cleanPhoto, then readPhoto), for Kith listings by handle, in a quiet
// tab at http://localhost:3000 (copied to public/validation/). The runner's times.read are taken while the
// cloth drapes beside it and other tabs run, so they overstate it; this is the number the budget holds
// (docs/plan-2026-11-accuracy.md, section 6).
//
//   const bench = (await import("/validation/bench_read.js")).default
//   await bench(["rhufw26ho03012-8611", "khm034263-413"])   // [{ handle, runs: [[cleanup ms, reading ms], ...] }]
import { readShop } from "controllers/fitting_room_controller"
import { readPhoto, readBottomPhoto } from "lib/garments/print"
import { cleanPhoto } from "lib/garments/segment"

export default async function bench(handles, { rounds = 2 } = {}) {
  const el = document.querySelector('[data-controller~="fitting-room"]')
  const importUrl = el.dataset.fittingRoomImportUrlValue
  const out = []
  for (const handle of handles) {
    const url = `https://kith.com/products/${handle}`
    const shop = await readShop(url)
    const res = await fetch(importUrl, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ url, shop_data: shop }) })
    const g = (await res.json()).garment
    const bottoms = g.garment === "trousers"
    // The front's shape from the middle size, as the page reads it (fitting_room_controller.js's frontShape).
    const sizes = (g.chart?.sizes ?? []).filter(s => s.chest && s.length)
    const size = sizes[Math.floor(sizes.length / 2)]
    const shape = size ? size.length / (size.chest / 2) : null
    const row = { handle, runs: [] }
    // The first round is a first visit's; later ones read what the first left cached.
    for (let r = 0; r < rounds; r++) {
      const t0 = performance.now()
      const front = await cleanPhoto(g.photo, bottoms ? "trousers" : "top")
      const t1 = performance.now()
      await (bottoms ? readBottomPhoto(front) : readPhoto(front, { shape }))
      const t2 = performance.now()
      row.runs.push([Math.round(t1 - t0), Math.round(t2 - t1)])
    }
    out.push(row)
  }
  return out
}
