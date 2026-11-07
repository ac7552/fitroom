// The Kith sample's listing photos read once for the photo-role work (photo_roles.js), development only. In the
// page at http://localhost:3000, served from public/validation/ with the sample beside it
// (kith_20261107/sample.json as sample_20261107.json):
//
//   const C = await import("/validation/photo_roles_crawl.js")
//   await C.crawl()            // each product's first 8 photos: traits, DINOv2 summary, a small thumbnail
//   await C.save()             // kept in IndexedDB ("fitroom-roles"), so a reload doesn't lose it
//   await C.restore()          // window.CRAWL again after a reload
//   await C.show(0, 12, labelsOf)   // a contact sheet of products 0-11 with their labels, to check by eye
//
// About half an hour for the 359 products on WebGPU (Kith turns a browser away for a while after a few
// hundred quick requests: crawl() goes on where it stopped). photo_roles_eval.js reads window.CRAWL.
const P = await import("lib/garments/print")
const L = await import("lib/garments/likeness")
window.CRAWL = window.CRAWL ?? { products: {}, done: 0, errors: [] }

async function dataUrl(src, width) {
  const url = new URL(src.startsWith("//") ? `https:${src}` : src)
  url.searchParams.set("width", String(width))
  const response = await fetch(url, { credentials: "omit" })
  if (!response.ok) throw new Error(`photo ${response.status}`)
  const blob = await response.blob()
  return await new Promise(resolve => { const f = new FileReader(); f.onload = () => resolve(f.result); f.readAsDataURL(blob) })
}
async function pixelsOf(src, most) {
  const image = await P.loadImage(src)
  const k = Math.min(1, most / Math.max(image.naturalWidth, image.naturalHeight))
  const w = Math.round(image.naturalWidth * k), h = Math.round(image.naturalHeight * k)
  const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h
  const g = canvas.getContext("2d", { willReadFrequently: true }); g.drawImage(image, 0, 0, w, h)
  return g.getImageData(0, 0, w, h)
}
export async function crawlOne(group, handle) {
  if (CRAWL.products[handle]) return CRAWL.products[handle]
  const product = (await fetch(`https://kith.com/products/${handle}.json`, { credentials: "omit" }).then(r => r.json())).product
  const images = []
  for (const [i, im] of (product.images ?? []).slice(0, 8).entries()) {
    try {
      const small = await dataUrl(im.src, 400)
      const traits = await P.readPhotoTraits(small).catch(() => null)
      const emb = await L.photoSummary(await pixelsOf(small, 224), { timeout: 60000 })
      const t = await pixelsOf(small, 96), canvas = document.createElement("canvas")
      canvas.width = t.width; canvas.height = t.height; canvas.getContext("2d").putImageData(t, 0, 0)
      images.push({ i, src: im.src, alt: im.alt ?? "", w: im.width, h: im.height, traits, emb: emb && Float32Array.from(emb), thumb: canvas.toDataURL("image/jpeg", 0.7) })
    } catch (error) { images.push({ i, src: im.src, alt: im.alt ?? "", error: error.message }) }
  }
  return (CRAWL.products[handle] = { group, handle, title: product.title, type: product.product_type, tags: product.tags, images })
}
export async function list() {
  const sample = await fetch("/validation/sample_20261107.json").then(r => r.json())
  return Object.entries(sample.groups).flatMap(([group, g]) => g.items.map(item => [group, item.handle]))
}
export async function crawl() {
  for (const [group, handle] of await list()) {
    try { await crawlOne(group, handle) } catch (error) { CRAWL.errors.push([handle, error.message]) }
    CRAWL.done++
  }
  return CRAWL.done
}

function db() {
  return new Promise((resolve, reject) => { const r = indexedDB.open("fitroom-roles", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
}
export async function save() {
  const d = await db()
  await new Promise((resolve, reject) => { const t = d.transaction("kv", "readwrite"); t.objectStore("kv").put({ products: CRAWL.products, done: CRAWL.done }, "crawl"); t.oncomplete = resolve; t.onerror = () => reject(t.error) })
}
export async function restore() {
  const d = await db()
  window.CRAWL = (await new Promise((resolve, reject) => { const t = d.transaction("kv").objectStore("kv").get("crawl"); t.onsuccess = () => resolve(t.result); t.onerror = () => reject(t.error) })) ?? window.CRAWL
  return Object.keys(CRAWL.products).length
}

// A contact sheet of products from..from+count (in the sample's order) with each photo's label under it (the
// letters of photo_roles.json), over the page, to check the labels by eye. labelsOf(product) → [letter].
export async function show(from, count, labelsOf, { cell = 92 } = {}) {
  const products = (await list()).slice(from, from + count).map(([, h]) => CRAWL.products[h]).filter(Boolean)
  const canvas = document.createElement("canvas"), rowH = cell + 12
  canvas.width = 170 + 8 * cell; canvas.height = products.length * rowH
  const g = canvas.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, canvas.width, canvas.height)
  for (const [r, p] of products.entries()) {
    const y = r * rowH, labels = labelsOf(p)
    g.fillStyle = "#000"; g.font = "bold 11px sans-serif"; g.fillText(`${from + r} ${p.handle.slice(0, 22)}`, 2, y + 14)
    g.font = "10px sans-serif"; g.fillText(p.group, 2, y + 28); g.font = "bold 11px sans-serif"
    for (const im of p.images) {
      if (!im.thumb) continue
      const img = new Image(); img.src = im.thumb; await img.decode()
      const k = Math.min(cell / img.naturalWidth, cell / img.naturalHeight), x = 170 + im.i * cell
      g.drawImage(img, x, y, img.naturalWidth * k, img.naturalHeight * k)
      g.fillStyle = "#d00"; g.fillText(`${im.i}${labels[im.i] ?? "?"}`, x + 2, y + cell + 10)
    }
    g.fillStyle = "#ccc"; g.fillRect(0, y + rowH - 1, canvas.width, 1)
  }
  document.getElementById("roles-sheet")?.remove()
  const overlay = document.createElement("div"); overlay.id = "roles-sheet"
  overlay.style.cssText = "position:fixed;inset:0;z-index:99999;background:#fff;overflow:auto"
  overlay.appendChild(canvas); document.body.appendChild(overlay)
  return [canvas.width, canvas.height]
}
export default { crawl, crawlOne, list, save, restore, show }
