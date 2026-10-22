import { Controller } from "@hotwired/stimulus"
import { formatLength, toCm } from "lib/format"
import { FittingStage } from "lib/stage"

// The fitting room: an outfit (up to a jacket, a coat and trousers, each from a link, a pasted chart or a
// photo with typed measurements), your measurements, and the outfit on a mannequin your shape in
// whichever sizes you pick, in one of a few poses.
//
// Fit results come from the same API the mobile app uses. The measurements go out with each request
// and are kept nowhere: not on the server, not in cookies or browser storage. Inputs have no names, so
// the browser never submits or remembers them, and a refresh clears them. Photos never leave the device.
const EXAMPLE_CM = { chest: 101.6, waist: 86.4, shoulders: 45.5, arm: 65.5, height: 178, hips: 101, inseam: 81 }
const REQUIRED = ["chest", "waist", "shoulders", "arm", "height"]

const KINDS = { jacket: "Jacket", coat: "Coat", trousers: "Trousers" }
// How the 3D view draws a jacket (see STYLES in lib/stage.js), and the cloth it's made of.
const STYLE_NAMES = { tailored: "Blazer or suit jacket", zip: "Zip-up jacket", bomber: "Bomber", shirt: "Denim or button-up jacket" }
const FABRIC_NAMES = { wool: "Wool", cotton: "Cotton", denim: "Denim", leather: "Leather", nylon: "Nylon" }
const ORDER = ["coat", "jacket", "trousers"]
const OWN_PARTS = {
  jacket: [["chest", "Chest"], ["waist", "Waist"], ["shoulders", "Shoulders"], ["sleeve", "Sleeve"], ["length", "Length"]],
  trousers: [["waist", "Waist"], ["seat", "Seat"], ["thigh", "Thigh"], ["inseam", "Inseam"], ["leg_opening", "Opening"]]
}
const FLAT_PARTS = ["chest", "waist", "seat", "thigh", "leg_opening"]

const STATUS_TEXT = { good: "Fits", tight: "Tight", loose: "Loose", short: "Short", long: "Long", unknown: "Not listed" }
const VERDICT_TEXT = { fits: "Fits as it comes", alter: "Fits with tailoring", compromise: "Won't fit right" }

export default class extends Controller {
  static targets = [
    "input", "unit", "unitLabel", "cut", "results", "canvas", "sizes", "stageNote", "legend", "warnings",
    "link", "importButton", "chartText", "importError", "outfitList", "itemType",
    "photoInput", "photoPreview", "photoLabel", "ownSizes", "measuredFlat", "stagePhotos",
    "studio", "studioFrame", "studioStatus", "studioDownload", "studioSwitch", "exact"
  ]
  static values = { fitsUrl: String, importUrl: String, studioUrl: String, garment: Object }

  connect() {
    this.unit = this.unitTargets.find(radio => radio.checked)?.value ?? "in"
    this.unitLabelTargets.forEach(label => { label.textContent = this.unit })
    this.stage = new FittingStage(this.canvasTarget)
    this.outfit = {}
    this.addItem(this.garmentValue)
    this.renderOwnSizes()
    this.update()
  }

  disconnect() {
    clearTimeout(this.timer)
    this.requests?.forEach(r => r.abort())
    this.stage?.dispose()
    if (this.photoUrl) URL.revokeObjectURL(this.photoUrl)
    this.closeStudio()
  }

  // Bringing in items

  useSample(event) {
    this.linkTarget.value = new URL(event.target.dataset.path, location.origin).toString()
    this.importLink()
  }

  importLink(event) {
    event?.preventDefault()
    const url = this.linkTarget.value.trim()
    if (url) this.importGarment({ url })
  }

  importText() {
    const text = this.chartTextTarget.value.trim()
    if (text) this.importGarment({ text, garment: this.itemTypeTarget.value })
  }

  async importGarment(payload) {
    this.importErrorTarget.hidden = true
    this.importButtonTarget.disabled = true
    this.importButtonTarget.textContent = "Reading…"
    try {
      const response = await fetch(this.importUrlValue, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload)
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message ?? "Couldn't read that.")
      this.addItem(data.garment)
      this.update()
    } catch (error) {
      this.showImportError(error.message.startsWith("Failed to fetch") ? "Couldn't reach Fitroom. Is the server running?" : error.message)
    } finally {
      this.importButtonTarget.disabled = false
      this.importButtonTarget.textContent = "Add it"
    }
  }

  // One item of each kind: a new jacket replaces the jacket, and so on. A shop photo, when the import
  // brought one, gives the truest colour.
  addItem(garment) {
    const kind = KINDS[garment.garment] ? garment.garment : "jacket"
    const item = { garment, selected: null, fit: null }
    this.outfit[kind] = item
    this.renderOutfit()
    if (garment.photo && !garment.photoColor) {
      clothColor(garment.photo).then(color => {
        if (!color || this.outfit[kind] !== item) return
        garment.color = garment.photoColor = color
        this.renderOutfit()
        if (item.fit) this.render()
      })
    }
  }

  removeItem(event) {
    delete this.outfit[event.currentTarget.dataset.kind]
    this.renderOutfit()
    this.update()
  }

  changeItemType() {
    this.renderOwnSizes()
  }

  // A photo is read locally, for a preview and its colour, and never sent anywhere.
  async pickPhoto() {
    const file = this.photoInputTarget.files[0]
    if (!file) return
    this.photoUrl = URL.createObjectURL(file)
    this.photoPreviewTarget.src = this.photoUrl
    this.photoPreviewTarget.hidden = false
    this.photoLabelTarget.textContent = "Change photo"
    this.photoColor = await clothColor(this.photoUrl)
  }

  renderOwnSizes() {
    this.ownSizesTarget.innerHTML = ""
    this.addOwnSize()
  }

  addOwnSize() {
    const trousers = this.itemTypeTarget.value === "trousers"
    const parts = OWN_PARTS[trousers ? "trousers" : "jacket"]
    const row = document.createElement("div")
    row.className = "own-size"
    row.innerHTML = `
      <label><span>Size</span><input type="text" autocomplete="off" spellcheck="false" placeholder="${trousers ? "32" : "40R"}" data-own="name"></label>
      ${parts.map(([part, label]) => `
        <label><span>${label}</span><input type="number" inputmode="decimal" min="0" step="0.25" autocomplete="off" data-own="${part}"></label>`).join("")}`
    this.ownSizesTarget.append(row)
  }

  useOwnItem() {
    const kind = this.itemTypeTarget.value
    const parts = OWN_PARTS[kind === "trousers" ? "trousers" : "jacket"]
    const main = parts[0][0]
    const flat = this.measuredFlatTarget.checked
    const sizes = [...this.ownSizesTarget.querySelectorAll(".own-size")].map((row, i) => {
      const size = { name: row.querySelector('[data-own="name"]').value.trim() || `Size ${i + 1}` }
      for (const [part] of parts) {
        const value = parseFloat(row.querySelector(`[data-own="${part}"]`).value)
        size[part] = Number.isFinite(value) && value > 0
          ? round(toCm(value, this.unit) * (flat && FLAT_PARTS.includes(part) ? 2 : 1), 10)
          : null
      }
      return size
    }).filter(size => size[main])

    if (sizes.length === 0) {
      this.showImportError(`Add at least the ${main} for one size.`)
      return
    }
    this.importErrorTarget.hidden = true
    const missing = parts.map(([part]) => part).filter(part => sizes.every(size => size[part] == null))
    this.addItem({
      name: `Your ${KINDS[kind].toLowerCase()}`, brand: null, color_name: null, color: this.photoColor ?? "#2a3552",
      source_url: null, garment: kind, photo: this.photoUrl ?? null, fabric: "wool", ...(kind === "jacket" ? { style: "tailored" } : {}),
      chart: { sizes, unit: this.unit, kind: "garment", missing }
    })
    this.photoUrl = null
    this.photoColor = null
    this.photoPreviewTarget.hidden = true
    this.photoLabelTarget.textContent = "+ Choose a photo (optional)"
    this.update()
  }

  showImportError(message) {
    this.importErrorTarget.textContent = message
    this.importErrorTarget.hidden = false
  }

  renderOutfit() {
    const items = this.items()
    this.outfitListTarget.innerHTML = items.length ? items.map(({ kind, garment }) => {
      const chart = garment.chart
      const notes = [
        chart.sizes.length === 1 ? "1 size" : `${chart.sizes.length} sizes`,
        chart.kind === "body" ? "estimated from the shop's body sizes" : null,
        chart.kind === "sizes" ? "estimated from the shop's size numbers (a US 40 fits a 40 inch chest)" : null,
        chart.missing.length ? `no ${chart.missing.map(m => m.replace("_", " ")).join(" or ")} on the chart` : null
      ].filter(Boolean)
      const thumb = garment.photo
        ? `<img class="swatch swatch--photo" src="${escape(garment.photo)}" alt="">`
        : `<span class="swatch" style="background:${escape(garment.color)}"></span>`
      const source = garment.source_url ? ` <a href="${escape(garment.source_url)}" target="_blank" rel="noopener noreferrer">View page</a>` : ""
      return `
        <div class="garment-card">
          ${thumb}
          <div class="garment-text">
            <p class="garment-kind mono">${KINDS[kind]}</p>
            <p class="garment-name">${escape(garment.name)}</p>
            <p class="garment-meta">${escape([garment.brand, garment.color_name, garment.fabric && garment.fabric !== "wool" ? garment.fabric : null].filter(Boolean).join(" · "))}</p>
            <p class="garment-meta">${escape(capitalize(notes.join(", ")))}.${source}</p>
            <div class="garment-looks">
              ${kind === "jacket" ? picker(kind, "style", "Looks like", STYLE_NAMES, garment.style ?? "tailored") : ""}
              ${picker(kind, "fabric", "Fabric", FABRIC_NAMES, garment.fabric ?? "wool")}
            </div>
          </div>
          <button type="button" class="text-button garment-remove" data-kind="${kind}" data-action="fitting-room#removeItem" aria-label="Remove ${KINDS[kind].toLowerCase()}">Remove</button>
        </div>`
    }).join("") : `<p class="hint">Nothing yet. Add a jacket, coat or trousers below.</p>`

    this.stagePhotosTarget.innerHTML = items.filter(i => i.garment.photo)
      .map(i => `<img class="stage-photo" src="${escape(i.garment.photo)}" alt="Your photo of the ${KINDS[i.kind].toLowerCase()}">`).join("")
  }

  // A different look for an item ("Looks like" or "Fabric" on its card): only the drawing changes.
  restyle(event) {
    const { kind, field } = event.currentTarget.dataset
    const item = this.outfit[kind]
    if (!item) return
    item.garment[field] = event.currentTarget.value
    this.renderOutfit()
    this.render()
  }

  items() {
    return ORDER.filter(kind => this.outfit[kind]).map(kind => ({ kind, ...this.outfit[kind] }))
  }

  // Measurements

  changeUnit(event) {
    const next = event.target.value
    if (next === this.unit) return

    const ownInputs = this.ownSizesTarget.querySelectorAll('input[type="number"]')
    for (const input of [...this.inputTargets, ...ownInputs]) {
      const value = parseFloat(input.value)
      if (!Number.isFinite(value)) continue
      const cm = toCm(value, this.unit)
      input.value = next === "in" ? round(cm / 2.54, 4) : round(cm, 2)
    }
    this.unit = next
    this.unitLabelTargets.forEach(label => { label.textContent = next })
    this.update()
  }

  fillExample() {
    for (const input of this.inputTargets) {
      const cm = EXAMPLE_CM[input.dataset.part]
      input.value = this.unit === "in" ? round(cm / 2.54, 4) : round(cm, 2)
    }
    this.update()
  }

  clear() {
    this.inputTargets.forEach(input => { input.value = "" })
    this.update()
  }

  // The stage

  changeView(event) {
    this.legendTarget.hidden = event.target.value !== "fit"
    this.stage.setView(event.target.value)
  }

  changePose(event) {
    this.stage.setPose(event.target.value)
  }

  pickSize(event) {
    const { kind, size } = event.currentTarget.dataset
    this.outfit[kind].selected = size
    this.render()
  }

  // Wait for a pause in typing, then ask the API about each item.
  update() {
    clearTimeout(this.timer)
    this.requests?.forEach(r => r.abort())

    const measurements = this.readMeasurements()
    const filled = REQUIRED.filter(key => measurements[key] > 0).length
    if (filled < REQUIRED.length) {
      for (const item of Object.values(this.outfit)) item.fit = null
      this.stage.setBody(EXAMPLE_CM)
      this.stage.setOutfit([])
      this.stageNoteTarget.textContent = "Example shape. Add your measurements to see the outfit on you."
      this.sizesTarget.innerHTML = ""
      this.warningsTarget.hidden = true
      this.showEmpty(`${filled} of ${REQUIRED.length} measurements`, "Fill in the first five and the outfit appears in your size.")
      return
    }

    const given = Object.fromEntries(Object.entries(measurements).filter(([, v]) => v > 0))
    this.limited = this.stage.setBody(Object.fromEntries(Object.entries(given).map(([k, v]) => [k, toCm(v, this.unit)])))
    this.timer = setTimeout(() => this.fetchFits(given), 150)
  }

  async fetchFits(measurements) {
    const items = this.items()
    if (items.length === 0) {
      this.stage.setOutfit([])
      this.sizesTarget.innerHTML = ""
      this.showEmpty("No items", "Add a jacket, coat or trousers to see how they fit.")
      return
    }
    this.requests = items.map(() => new AbortController())
    try {
      const responses = await Promise.all(items.map(({ kind, garment }, i) => fetch(this.fitsUrlValue, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ cut: this.cutTarget.value, unit: this.unit, garment: kind, sizes: garment.chart.sizes, measurements }),
        signal: this.requests[i].signal,
        cache: "no-store"
      }).then(async r => ({ ok: r.ok, data: await r.json() }))))

      const failed = responses.find(r => !r.ok)
      if (failed) {
        const problems = Object.entries(failed.data.errors ?? {}).map(([part, message]) => `${capitalize(part)} ${message}.`)
        this.stage.setOutfit([])
        this.sizesTarget.innerHTML = ""
        this.showEmpty("Check your numbers", problems.join(" ") || "Something didn't add up.")
        return
      }
      items.forEach(({ kind }, i) => {
        const item = this.outfit[kind]
        item.fit = responses[i].data
        if (!item.fit.sizes.some(s => s.size === item.selected)) item.selected = item.fit.best
      })
      this.warnings = responses[0].data.warnings ?? []
      this.render()
    } catch (error) {
      if (error.name !== "AbortError") this.showEmpty("Couldn't reach Fitroom", "Check that the server is running, then try again.")
    }
  }

  // Studio photo: the server drapes what's on screen with cloth simulation and path-traces it. The
  // image comes back once and is deleted on the server; here it lives only as a blob in this tab.

  async studioPhoto() {
    const snapshot = this.stage.snapshot()
    if (!snapshot || snapshot.items.length === 0) {
      this.showStudio("Add your measurements and at least one item first.")
      return
    }
    this.closeStudio()
    this.showStudio("Sending the outfit to the studio…")
    const token = this.studioToken = Symbol("studio")
    try {
      // With "Exact item" ticked, each item's photo (the shop's, or yours) goes along, shrunk to a sensible size.
      const exact = this.exactTarget.checked
      if (exact) {
        await Promise.all(snapshot.items.map(async item => {
          const photo = this.outfit[item.kind]?.garment.photo
          if (photo) item.photo = await shrunkPhoto(photo)
        }))
      }
      const start = await fetch(this.studioUrlValue, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ ...snapshot, exact })
      })
      const job = await start.json()
      if (!start.ok) throw new Error(job.message ?? "The studio couldn't take that outfit.")
      if (exact && !job.exact_available) this.studioNote = "Exact-item photos need a FASHN API key on the server."
      else if (exact && !job.exact) this.studioNote = "No item has a photo, so there's no exact-item version."
      else this.studioNote = null

      const began = Date.now()
      this.studioImages = {}
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 1500))
        if (token !== this.studioToken) return
        const status = await fetch(job.status_url, { cache: "no-store" }).then(r => r.json())
        if (status.status === "failed" || status.error) throw new Error("The render didn't work. Try again.")
        if (!this.studioImages.draped && (status.status === "styling" || status.status === "done")) {
          this.studioImages.draped = await this.fetchStudioImage(job.image_url)
          this.showStudioImage("draped")
        }
        if (status.exact === "done" && !this.studioImages.exact) {
          this.studioImages.exact = await this.fetchStudioImage(job.exact_image_url)
          this.studioSwitchTarget.hidden = false
          this.studioSwitchTarget.querySelector('input[value="exact"]').checked = true
          this.showStudioImage("exact")
        }
        if (status.status === "done") {
          if (status.exact === "failed") this.studioNote = "The exact-item version didn't work; here's the measured drape."
          this.studioStatusTarget.textContent = this.studioNote ?? this.studioStatusTarget.textContent
          return
        }
        const seconds = Math.round((Date.now() - began) / 1000)
        this.studioStatusTarget.textContent = status.status === "queued"
          ? `Waiting for the studio${status.ahead ? ` (${status.ahead} ahead)` : ""}… ${seconds}s`
          : status.status === "styling"
            ? `Painting the exact items on with AI… ${seconds}s`
            : `Draping the cloth and lighting the shot… ${seconds}s (usually about 30)`
      }
    } catch (error) {
      if (token === this.studioToken) this.studioStatusTarget.textContent = error.message
    }
  }

  async fetchStudioImage(url) {
    const blob = await fetch(url, { cache: "no-store" }).then(r => r.blob())
    return URL.createObjectURL(blob)
  }

  switchStudio(event) {
    this.showStudioImage(event.target.value)
  }

  showStudioImage(variant) {
    const url = this.studioImages?.[variant]
    if (!url) return
    this.studioFrameTarget.innerHTML = `<img src="${url}" alt="Studio photo of the outfit on the mannequin">`
    this.studioDownloadTarget.href = url
    this.studioDownloadTarget.hidden = false
    this.studioStatusTarget.textContent = variant === "exact"
      ? "The shops' own garments painted onto the measured drape by AI. The fit verdict is still the measured one."
      : "Draped by cloth simulation to the measured sizes, and path-traced. Nothing was kept on the server."
  }

  showStudio(message) {
    this.studioTarget.hidden = false
    this.studioStatusTarget.textContent = message
  }

  closeStudio() {
    this.studioToken = null
    for (const url of Object.values(this.studioImages ?? {})) URL.revokeObjectURL(url)
    this.studioImages = {}
    if (!this.hasStudioTarget) return
    this.studioTarget.hidden = true
    this.studioFrameTarget.innerHTML = ""
    this.studioDownloadTarget.hidden = true
    this.studioSwitchTarget.hidden = true
  }

  // Rendering

  render() {
    const items = this.items().filter(i => i.fit)
    this.stage.setOutfit(items.map(({ kind, garment, fit, selected }) => ({
      kind,
      size: garment.chart.sizes.find(s => s.name === selected),
      checks: fit.sizes.find(s => s.size === selected).checks,
      color: garment.color,
      fabric: garment.fabric,
      style: garment.style
    })))

    const notes = []
    if (this.outfit.coat) notes.push("The coat is drawn from a jacket, so long coats look shorter here.")
    if (this.limited?.length) notes.push(`The mannequin can't go as far as your ${this.limited.join(" and ")}; it's drawn as near as it can.`)
    this.stageNoteTarget.textContent = notes.join(" ") || "Your shape. Drag to turn it."

    this.warningsTarget.hidden = !this.warnings?.length
    this.warningsTarget.innerHTML = (this.warnings ?? []).map(w => `<p>${escape(w.message)}</p>`).join("")

    this.sizesTarget.innerHTML = items.map(({ kind, garment, fit, selected }) => {
      const order = garment.chart.sizes.map(s => s.name)
      const sizes = [...fit.sizes].sort((a, b) => order.indexOf(a.size) - order.indexOf(b.size))
      return `
        <div class="size-row" role="radiogroup" aria-label="${KINDS[kind]} size">
          <span class="size-row-label mono">${KINDS[kind]}</span>
          ${sizes.map(r => `
            <button type="button" role="radio" aria-checked="${r.size === selected}"
                    class="size-chip size-chip--${r.verdict}${r.size === fit.best ? " size-chip--best" : ""}"
                    data-kind="${kind}" data-size="${escape(r.size)}" data-action="fitting-room#pickSize"
                    title="${escape(VERDICT_TEXT[r.verdict])}">${escape(r.size)}</button>`).join("")}
        </div>`
    }).join("")

    this.resultsTarget.innerHTML = items.map(({ kind, garment, fit, selected }) => {
      const result = fit.sizes.find(s => s.size === selected)
      const badge = fit.sizes.length === 1 ? '<span class="best-badge">Only size</span>'
        : result.size === fit.best ? '<span class="best-badge">Best fit</span>'
        : `<button type="button" class="text-button" data-kind="${kind}" data-size="${escape(fit.best)}" data-action="fitting-room#pickSize">Best fit is ${escape(fit.best)}</button>`
      return `
        <section class="result">
          <p class="results-kicker">${KINDS[kind]} · ${escape(this.cutTarget.selectedOptions[0].textContent)} cut · ${escape(garment.name)}</p>
          <div class="results-headline">
            <p class="results-size${items.length > 1 ? " results-size--compact" : ""}">${escape(result.size)}</p>
            ${badge}
          </div>
          <p class="results-lede">${escape(summary(result))}</p>
          <ul class="checks">${result.checks.map(check => checkRow(check, this.unit)).join("")}</ul>
        </section>`
    }).join("")
  }

  showEmpty(kicker, text) {
    this.resultsTarget.innerHTML = `
      <div class="results-empty">
        <p class="results-kicker">${escape(kicker)}</p>
        <p class="results-lede">${escape(text)}</p>
      </div>`
  }

  readMeasurements() {
    return Object.fromEntries(this.inputTargets.map(input => {
      const value = parseFloat(input.value)
      return [input.dataset.part, Number.isFinite(value) && value > 0 ? value : null]
    }))
  }
}

function summary(result) {
  const fixes = result.checks.filter(c => c.fix)
  switch (result.verdict) {
    case "fits": return "Fits as it comes. No tailoring needed."
    case "alter": return fixes.length === 1 ? "Fits with one small change from a tailor." : `Fits with ${fixes.length} small changes from a tailor.`
    default: {
      const parts = result.checks.filter(c => !c.fixable).map(c => c.label.toLowerCase())
      return `The ${parts.join(" and ")} won't be right, and a tailor can't fix that.`
    }
  }
}

function checkRow(check, unit) {
  return `
    <li class="check">
      <span class="check-label">${escape(check.label)}</span>
      <span class="chip chip--${check.status}">${STATUS_TEXT[check.status]}</span>
      <span class="check-detail">${escape(detail(check, unit))}</span>
    </li>`
}

function detail(check, unit) {
  if (check.note) return check.note
  if (check.status === "unknown") return "Not on this size chart"
  if (check.fix) return `${check.fix.text} ${formatLength(check.fix.amount_cm, unit)}`

  const amount = formatLength(check.ease_cm, unit)
  switch (check.part) {
    case "sleeve":
    case "length":
    case "inseam":
      return check.status === "good" ? "Right length" : `${amount} too ${check.status}, can't be fixed`
    case "shoulders":
      if (check.status === "good") return "Seam sits on your shoulder bone"
      return check.status === "tight" ? `${amount} narrower than you, can't be fixed` : `${amount} past your shoulder, can't be fixed`
    default:
      if (check.ease_cm < 0) return `${amount} smaller than you`
      if (check.status === "good") return `${amount} of room`
      return check.status === "tight" ? `Only ${amount} of room` : `${amount} of room, too much`
  }
}

// The item's colour from a photo: the average of the middle of the picture, leaving out the near-white
// and near-grey background most product photos sit on.
async function clothColor(url) {
  const image = new Image()
  image.src = url
  await image.decode()
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 48
  const context = canvas.getContext("2d", { willReadFrequently: true })
  context.drawImage(image, 0, 0, 48, 48)
  const { data } = context.getImageData(12, 10, 24, 28)
  let r = 0, g = 0, b = 0, n = 0
  for (let i = 0; i < data.length; i += 4) {
    const [pr, pg, pb] = [data[i], data[i + 1], data[i + 2]]
    const light = (pr + pg + pb) / 3
    const spread = Math.max(pr, pg, pb) - Math.min(pr, pg, pb)
    if (light > 225 && spread < 20) continue
    r += pr; g += pg; b += pb; n++
  }
  if (n === 0) return null
  const hex = v => Math.round(v / n).toString(16).padStart(2, "0")
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

// A photo as a JPEG data: URL no larger than 1024 px, for sending along with a studio photo.
async function shrunkPhoto(src) {
  const image = new Image()
  image.src = src
  await image.decode()
  const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight))
  const canvas = document.createElement("canvas")
  canvas.width = Math.round(image.naturalWidth * scale)
  canvas.height = Math.round(image.naturalHeight * scale)
  const context = canvas.getContext("2d")
  context.fillStyle = "#ffffff"
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL("image/jpeg", 0.9)
}

function round(value, steps) {
  return Math.round(value * steps) / steps
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function picker(kind, field, label, names, value) {
  return `
    <label class="garment-pick">
      <span>${label}</span>
      <select data-kind="${kind}" data-field="${field}" data-action="fitting-room#restyle">
        ${Object.entries(names).map(([key, name]) => `<option value="${key}"${key === value ? " selected" : ""}>${name}</option>`).join("")}
      </select>
    </label>`
}

function escape(text) {
  return String(text ?? "").replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)
}
