// Picks the validation set from kith.com's own collections (development only). Run in a kith.com tab, where
// the collections' product JSON can be read:
//
//   (paste this file's functions into the tab's console, then)
//   const picked = await sample({ men_top: ["mens-apparel-tops"], ... }, 100, 20261030)
// script/validation/sample.json holds the set picked on 2026-10-30 (its sets and collections are listed there).
//
// For each set: every product in its collections (gift cards, bundles, swimwear, underwear and products with
// no photo left out),
// grouped by product type; each type gets a share of the `count` as big as its share of the products (at
// least one), and within a type the picks go round the brands, so one brand's twenty colourways of a tee
// don't fill the set. The same seed picks the same set while the collections hold the same products.
async function sample(sets, count = 100, seed = 1) {
  const random = mulberry32(seed)
  const out = {}
  for (const [name, collections] of Object.entries(sets)) {
    const seen = new Map()
    for (const collection of collections) {
      for (let page = 1; page <= 12; page++) {
        const response = await fetch(`/collections/${collection}/products.json?limit=250&page=${page}`)
        if (!response.ok) break
        const { products } = await response.json()
        if (!products?.length) break
        for (const p of products) {
          // Swimwear and underwear aren't what Fitroom fits; collections mix them in with tops and bottoms.
          if (!p.images?.length || /gift card|bundle|sample sale|bikini|swim|\bbras?\b|bralette|underwear|briefs?\b|boxers?\b|thong/i.test(`${p.title} ${p.product_type}`)) continue
          seen.set(p.handle, { handle: p.handle, type: p.product_type || "Other", vendor: p.vendor, title: p.title })
        }
        if (products.length < 250) break
      }
    }
    const all = [...seen.values()]
    const byType = groupBy(all, p => p.type)
    // Each type's share of the count, at least one, largest remainders first.
    const types = [...byType.keys()]
    const exact = types.map(t => (byType.get(t).length / all.length) * count)
    const share = new Map(types.map((t, i) => [t, Math.max(1, Math.floor(exact[i]))]))
    let total = [...share.values()].reduce((a, b) => a + b, 0)
    const order = types.map((t, i) => [t, exact[i] - Math.floor(exact[i])]).sort((a, b) => b[1] - a[1])
    for (let i = 0, guard = 0; total < Math.min(count, all.length) && guard < 10000; i = (i + 1) % order.length, guard++) {
      const t = order[i][0]
      if (share.get(t) < byType.get(t).length) { share.set(t, share.get(t) + 1); total++ }
    }
    // More types than the count: the biggest give one back in turn (a type keeps at least one).
    const byShare = [...share.entries()].sort((a, b) => b[1] - a[1])
    for (let k = 0; total > count && k < 10000; k++) { const t = byShare[k % byShare.length][0]; if (share.get(t) > 1) { share.set(t, share.get(t) - 1); total-- } }
    const picked = []
    for (const t of types) {
      // Round the brands: each brand's products shuffled, then one from each brand in turn.
      const brands = [...groupBy(shuffle(byType.get(t), random), p => p.vendor).values()]
      const lane = []
      for (let i = 0; lane.length < byType.get(t).length; i++) for (const b of brands) if (b[i]) lane.push(b[i])
      picked.push(...lane.slice(0, share.get(t)))
    }
    out[name] = { available: all.length, types: Object.fromEntries(types.map(t => [t, share.get(t)])), items: shuffle(picked, random).slice(0, count) }
  }
  return out
}

function groupBy(list, key) {
  const map = new Map()
  for (const x of list) { const k = key(x); if (!map.has(k)) map.set(k, []); map.get(k).push(x) }
  return map
}

function shuffle(list, random) {
  const a = list.slice()
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
  return a
}

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
