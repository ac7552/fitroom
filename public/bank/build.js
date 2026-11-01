// Builds the drape bank (app/javascript/lib/garments/drape_bank.js) from a list of store links: each garment
// is draped on the page from scratch, in its best size and its smallest and largest, and each drape is saved
// as an entry under public/drapes/ (through the development-only POST /api/v1/drape_bank). Commit the files.
//
// Run it in the browser's console on the fitting room page, opened with ?bank=off (so nothing starts from the
// bank while it's being built):
//
//   const script = document.createElement("script"); script.src = "/bank/build.js"; document.head.append(script)
//   buildBank(SOURCES)            // SOURCES: [{ url, women }] (script/bank/sources.json has the current list)
//   bankLog                       // progress: one line per garment
//
// It takes about half a minute a garment. Leave the tab in front: a browser slows a page it can't see.
window.bankLog = []
window.buildBank = async function buildBank(sources) {
  const fr = Stimulus.getControllerForElementAndIdentifier(document.querySelector('[data-controller~="fitting-room"]'), "fitting-room")
  const s = fr.stage
  const channel = new MessageChannel(), waiters = []
  channel.port1.onmessage = () => waiters.shift()?.()
  const tick = () => new Promise(resolve => { waiters.push(resolve); channel.port2.postMessage(0) })
  const wait = ms => new Promise(resolve => { const t0 = performance.now(); const spin = () => (performance.now() - t0 >= ms ? resolve() : tick().then(spin)); spin() })
  const slots = () => Object.values(s.slots).filter(Boolean)
  const started = async () => { const t0 = performance.now(); while (performance.now() - t0 < 20000) { s.advanceDrape(); await tick(); if (slots().length || Object.keys(s.waiting).length) return true } return false }
  const settled = async () => { const t0 = performance.now(); while (performance.now() - t0 < 240000) { s.advanceDrape(); await tick(); if (s.settled && !s.busy && slots().length && slots().every(d => d.top.done && !d.posing) && performance.now() - t0 > 500) return true } return false }
  const slotOf = kind => (kind === "trousers" ? "bottom" : kind === "top" ? "top" : "outer")
  const save = async (slot, label) => {
    const entry = s.exportBankEntry(slot)
    if (!entry) return "nothing to save"
    const m = entry.measures
    const name = `${entry.bodyType}-${entry.style}-${Math.round(m.chest ?? m.waist ?? 0)}-${label}`
    const response = await fetch("/api/v1/drape_bank", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entry, name }) })
    return response.ok ? name : `HTTP ${response.status}`
  }
  for (const source of sources) {
    const t0 = performance.now(), log = { url: source.url, saves: [] }
    window.bankLog.push(log)
    try {
      for (const kind of Object.keys(fr.outfit)) fr.removeItem({ currentTarget: { dataset: { kind } } })
      await wait(300)
      const want = source.women ? "women" : "men"
      if (fr.bodyType !== want) { fr.changeBodyType({ target: { value: want } }); await wait(500) }
      ;[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Use example numbers")?.click()
      await fr.importGarment({ url: source.url })
      const kind = Object.keys(fr.outfit).find(k => k !== "shoes")
      if (!kind) { log.error = "not imported"; continue }
      if (!(await started())) { log.error = "not draped on the page"; continue }
      if (!(await settled())) { log.error = "didn't settle"; continue }
      log.saves.push(await save(slotOf(kind), "best"))
      const sizes = (fr.outfit[kind].fit?.sizes ?? []).map(r => r.size).filter(Boolean)
      for (const size of sizes.length > 2 ? [sizes[0], sizes[sizes.length - 1]] : []) {
        if (fr.outfit[kind].selected === size) continue
        fr.pickSize({ currentTarget: { dataset: { kind, size } } })
        await wait(300)
        if (!(await started()) || !(await settled())) { log.saves.push(`${size}: didn't settle`); continue }
        log.saves.push(await save(slotOf(kind), `size-${String(size).replace(/[^a-z0-9]/gi, "")}`))
      }
    } catch (error) {
      log.error = String(error).slice(0, 200)
    } finally {
      log.seconds = Math.round((performance.now() - t0) / 1000)
    }
  }
  window.bankDone = true
}
