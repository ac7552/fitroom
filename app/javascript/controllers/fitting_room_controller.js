import { Controller } from "@hotwired/stimulus"
import { toCm } from "lib/format"
import { FittingStage } from "lib/stage"
import { findPrint, garmentMask, measureDressMask, readPhoto, readBottomPhoto, readDressPhoto, readDressShape, readGarment, readPhotoTraits, readShoe, readShoeView, readTopShape, readBottomShape, loaded, loadImage } from "lib/garments/print"
import { compareLooks, compareShapes, croppedLengths, nextReading, PLAIN, reshaped } from "lib/garments/look_check"
import { likeness, warmLikeness } from "lib/garments/likeness"
import { describeOutfit, keepDetails, localStudioReady, studioLook } from "lib/local_studio"
import { cleanPhoto } from "lib/garments/segment"
import { knockoutPhoto } from "lib/garments/knockout"
import { measureFromPhotos } from "lib/measure_photo"
import { partRow, uncheckedLine, verdictWords } from "lib/fit_bar"
import { sizeSlider } from "lib/size_slider"
import { ROLES, guessRoles, photosByRole } from "lib/garments/photo_roles"
import { chartFromSizes, diagram, filled, nextSizeName, partsFor, sizesFromChart, sliderRange, startingSizes } from "lib/size_editor"

// The fitting room: an outfit (up to a top, a jacket, a coat and trousers, each from a link, a pasted chart
// or a photo with typed measurements), your measurements, and the outfit on a mannequin your shape in
// whichever sizes you pick, in one of a few poses.
//
// Fit results come from the same API the mobile app uses. The measurements go out with each request
// and are kept nowhere: not on the server, not in cookies or browser storage. Inputs have no names, so
// the browser never submits or remembers them, and a refresh clears them. Photos never leave the device.
// Example numbers for each mannequin: an average man's and woman's.
const EXAMPLES_CM = {
  men: { chest: 101.6, waist: 86.4, shoulders: 45.5, arm: 65.5, height: 178, hips: 101, inseam: 81 },
  women: { chest: 91.5, waist: 74, shoulders: 39.5, arm: 58, height: 165, hips: 99, inseam: 76 }
}
const REQUIRED = ["chest", "waist", "shoulders", "arm", "height"]

// What the page calls each kind of item (the API's names are top, jacket, coat and trousers).
const KINDS = { top: "Top", jacket: "Jacket", coat: "Coat", trousers: "Pants", shoes: "Shoes", socks: "Socks", belt: "Belt" }
// Worn but not fitted (the API's fits are for clothes): drawn as they look, in the size picked.
const ACCESSORIES = ["shoes", "socks", "belt"]
const DEFAULT_STYLE = { top: "tee", jacket: "tailored" }
const KIND_WORDS = { top: "top", jacket: "jacket", coat: "coat", trousers: "pants", shoes: "shoes", socks: "socks", belt: "belt" }
const ORDER = ["coat", "jacket", "top", "trousers", "belt", "socks", "shoes"]
// What the AI picture can paint a store's photo of (the server paints the outermost top, then the pants).
const TRY_ON_KINDS = ["coat", "jacket", "top", "trousers"]
// The AI picture's photo: FASHN's 576 x 864, doubled (see aiPicture).
const AI_WIDTH = 1152, AI_HEIGHT = 1728
// What the 3D view says while it drapes a top.
const DRAPE_TEXT = { sewing: "Sewing your size…", settling: "Almost ready…", posing: "Almost ready…" }
// The page's words for each measurement, for messages about them (see PagesHelper).
const BODY_WORDS = {
  height: ["height", "Stand up straight, with no shoes on."],
  chest: ["chest", "Wrap the tape around your chest, under your arms."],
  waist: ["waist", "Wrap the tape around your middle, at your belly button."],
  shoulders: ["shoulders", "Measure across your back, from one shoulder bone to the other."],
  arm: ["arm", "Measure from your shoulder bone down to your wrist."],
  hips: ["hips", "Wrap the tape around the widest part of your bottom."],
  inseam: ["leg", "Measure from your crotch down to the floor, on the inside of your leg."]
}
const FIT_NAMES = { slim: "Snug", regular: "Regular", classic: "Loose" }

// Plain words for the API's results.
const PART_NAMES = { inseam: "Leg length", leg_opening: "Leg opening", sleeve: "Sleeves" }

export default class extends Controller {
  static targets = [
    "input", "unit", "unitLabel", "cut", "results", "canvas", "stageNote", "legend", "warnings",
    "link", "importButton", "chartText", "importError", "outfitList", "ownKind", "tray", "trayAdd", "trayNote", "bodyType", "switches",
    "ownSizes", "measuredFlat", "stagePhotos", "sizeTabs", "ownDiagram", "pasteNote", "editorError",
    "studio", "studioFrame", "studioStatus", "studioDownload", "studioSwitch", "studioLookOption", "studioCompareOption", "exact", "lookAi",
    "loading", "loadingLabel", "loadingBar", "loadingActions", "scene", "stage", "aiButton", "stageToast", "seeIn3d",
    "heightFeet", "heightInches", "heightImperial", "heightMetric", "pantsOnly", "slider", "tuck",
    "bodyPhotoFront", "bodyPhotoSide", "bodyPhotoFrontLabel", "bodyPhotoSideLabel", "bodyPhotoButton", "bodyPhotoStatus", "bodyPhotoResult"
  ]
  static values = { fitsUrl: String, importUrl: String, studioUrl: String, lookUrl: String, tryOnUrl: String, warmUrl: String, garment: Object, dress: Object }

  connect() {
    this.unit = this.unitTargets.find(radio => radio.checked)?.value ?? "in"
    this.showUnit()
    this.stage = new FittingStage(this.canvasTarget)
    this.shownBodyType = this.bodyType
    this.stage.setBodyType(this.bodyType)
    this.showScene(this.sceneTargets.find(radio => radio.checked)?.value ?? "studio")
    // On the page, a garment just put on gets its slow turn round (not in a still picture).
    this.stage.revealTurns = true
    this.watchInsets()
    // One garment done isn't the outfit done: the loader goes when the stage says everything is on.
    this.stage.onDrape = phase => {
      if (phase === "done") this.queueLookCheck()
      this.showLoading(phase === "done" ? null : DRAPE_TEXT[phase] ?? this.loadingLabelTarget.textContent)
    }
    // The mannequin starts with nothing on: the sample T-shirt and dress are among the examples to try.
    this.outfit = {}
    this.tiles = new Map()
    this.renderOutfit()
    this.own = { kind: "top", sizes: startingSizes("top"), at: 2, focus: "chest" }
    this.renderEditor()
    this.trayPhotos = []
    this.renderTray()
    this.update()
  }

  disconnect() {
    this.insetWatch?.disconnect()
    clearTimeout(this.timer)
    this.requests?.forEach(r => r.abort())
    this.stage?.dispose()
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

  // A pasted chart (or just a size, like M) is read by the server and fills the size tabs, to be checked
  // before the garment goes on.
  async importText() {
    const text = this.chartTextTarget.value.trim()
    if (!text) return
    const kind = this.own.kind
    this.pasteNoteTarget.hidden = true
    this.editorErrorTarget.hidden = true
    try {
      const response = await fetch(this.importUrlValue, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ text, garment: kind }),
        signal: AbortSignal.timeout(20000)
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message ?? "Couldn't read that as a size chart.")
      const { sizes, note } = sizesFromChart(data.garment.chart, kind)
      if (!sizes.length) throw new Error("Couldn't find any sizes in that.")
      this.own = { ...this.own, sizes, at: 0, focus: partsFor(kind)[0].part }
      // A chart's numbers are all the way round, as the server reads them.
      this.measuredFlatTargets.forEach(input => { input.checked = input.value === "round" })
      this.pasteNoteTarget.textContent = note
      this.pasteNoteTarget.hidden = false
      this.renderEditor()
    } catch (error) {
      this.editorErrorTarget.textContent = error.name === "TimeoutError" ? "That took too long. Try again." : error.message
      this.editorErrorTarget.hidden = false
    }
  }

  // Pasting straight into the chart box reads it at once.
  pasteChart() {
    setTimeout(() => this.importText(), 0)
  }

  async importGarment(payload) {
    this.importErrorTarget.hidden = true
    this.showLoading("Getting the clothes…")
    this.importButtonTarget.disabled = true
    this.importButtonTarget.textContent = "Reading the page…"
    let shoeViews = null, shoePhoto = null
    try {
      if (payload.url) {
        const shopData = await readShop(payload.url)
        // A shoe's other photos stay here: only the 3D view uses them.
        if (shopData) { shoeViews = shopData.shoeViews; shoePhoto = shopData.photo; delete shopData.shoeViews }
        if (shopData) payload = { ...payload, shop_data: shopData }
      }
      const response = await fetch(this.importUrlValue, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(40000)
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message ?? "Couldn't read that.")
      if (shoeViews?.length && data.garment.garment === "shoes" && data.garment.photo === shoePhoto) data.garment.shoeViews = shoeViews
      this.addItem(data.garment)
      // A women's piece goes on the woman mannequin while the numbers are still the example ones (a person
      // who entered their own keeps their mannequin).
      const ownNumbers = Object.values(this.readMeasurements()).some(v => v > 0) && !this.showsExample(EXAMPLES_CM.men)
      if (data.garment.women && this.bodyType === "men" && !ownNumbers) {
        this.changeBodyType({ target: { value: "women" } })
        return
      }
      this.update()
    } catch (error) {
      this.showLoading(null)
      this.showImportError(error.name === "TimeoutError" ? "That store's page took too long. Try again, or paste its size chart instead."
        : error.message.startsWith("Failed to fetch") ? "Can't reach Fitroom. Is the server running?" : error.message)
    } finally {
      this.importButtonTarget.disabled = false
      this.importButtonTarget.textContent = "Add"
    }
  }

  // One item of each kind: a new jacket replaces the jacket, and so on. A shop photo, when the import
  // brought one, gives the truest colour.
  addItem(garment) {
    // A romper or jumpsuit is worn as its two halves (a top tucked into shorts or pants), each fitted, in
    // one colour, read once from its photo.
    if (garment.garment === "onepiece") {
      const halves = Object.entries(garment.parts).map(([kind, part]) => {
        const item = { garment: { ...part, women: garment.women }, selected: null, fit: null }
        this.outfit[kind] = item
        return item
      })
      this.renderOutfit()
      if (garment.photo) {
        clothColor(garment.photo).then(color => {
          if (!color || halves.some(item => !Object.values(this.outfit).includes(item))) return
          for (const item of halves) item.garment.color = item.garment.photoColor = asNamed(color, garment.color_name, item.garment.color)
          if (halves.every(item => item.fit)) this.render()
        }).catch(() => {})
      }
      return
    }
    const kind = KINDS[garment.garment] ? garment.garment : "jacket"
    const item = { garment, selected: null, fit: null }
    this.outfit[kind] = item
    this.renderOutfit()
    if (garment.photo && TRY_ON_KINDS.includes(kind)) this.warmTryOn()
    if (ACCESSORIES.includes(kind)) {
      // Shoes take their upper's and their sole's colours from the photo; socks and a belt, their colour.
      if (garment.photo && !garment.photoColor) {
        const reading = kind === "shoes" ? readShoe(garment.photo) : clothColor(garment.photo).then(color => color && { color })
        reading.then(read => {
          if (!read?.color || this.outfit[kind] !== item) return
          garment.color = garment.photoColor = asNamed(read.color, garment.color_name, garment.color)
          if (read.sole) garment.sole = read.sole
          if (read.collar) garment.collar = read.collar
          if (read.side) garment.shoeSide = read.side
          if (item.fit) this.render()
        }).catch(() => {})
      }
      return
    }
    if (garment.photo && !garment.photoColor) {
      // The photo's garment colour, and any print on its front, which the 3D view lays on the cloth. Pants
      // and skirts take the whole photo: their wash and fading, pockets and seams, as photographed.
      const bottoms = kind === "trousers"
      // A top's 3D view is checked against its photo before it's shown (checkLook): it waits for the reading.
      if (kind === "top") {
        garment.lookPending = true
        garment.listingColor ??= garment.color
        warmLikeness()
      }
      // First with anything that isn't the garment (a hand, a bag, a hanger) painted out (see segment.js).
      const part = bottoms ? "trousers" : "top"
      let frontPhoto = garment.photo
      const readFront = src => bottoms ? readBottomPhoto(src) : readPhoto(src, { shape: frontShape(garment.chart) })
      const reading = cleanPhoto(garment.photo, part).then(async front => {
        const read = await readFront(front)
        // Painting out took too much (the garment no longer reads as itself): the photo as the shop gave it.
        if (read || front === garment.photo) { garment.cleaned = front !== garment.photo; frontPhoto = front; return read }
        garment.cleaned = false
        return readFront(garment.photo)
      })
      reading.then(async read => {
        // A close-up of plain cloth gives its truest colour (no shadows, no folds).
        const close = garment.closeup && !read?.print ? await clothColor(garment.closeup).catch(() => null) : null
        const color = close ?? read?.color ?? await clothColor(garment.photo)
        if (!color || this.outfit[kind] !== item) { garment.lookPending = false; this.queueLookCheck(); return }
        garment.color = garment.photoColor = asNamed(color, garment.color_name, garment.color)
        // The shop's photo of the back, read the same way, goes on the back.
        const backPhoto = garment.back_photo && read ? await cleanPhoto(garment.back_photo, part) : null
        if (backPhoto) garment.backCleaned = backPhoto !== garment.back_photo
        if (kind === "top") garment.lookPhotos = { front: frontPhoto, back: backPhoto }
        const readBack = src => (bottoms ? readBottomPhoto(src) : readPhoto(src)).catch(() => null)
        let back = backPhoto ? await readBack(backPhoto) : null
        if (!back && backPhoto && backPhoto !== garment.back_photo) back = await readBack(garment.back_photo)
        // Not the same garment's back after all (a close-up, or a photo on a model): a different colour, or a
        // top that's plain in front showing a print all over its back.
        if (back && (colorGap(back.color, read.color) > 40 || (!bottoms && !read.print && back.print?.coverage > 0.35))) back = null
        if (this.outfit[kind] !== item) return
        if (bottoms) garment.photoMap = read ? { image: read.image, soft: read.soft, layout: read.layout, back: back ? { image: back.image, layout: back.layout } : null } : null
        else {
          this.applyTopReading(garment, read, back)
          // A dress, a jacket, a coat or a button-up shirt has its photo laid on the cloth, as pants have: a
          // dress's sequins, lace, print and texture, a jacket's or shirt's wash, pattern, placket, pockets
          // and seams, which a colour and a placed graphic can't give. The colour stays for what the photo
          // doesn't reach (the sleeves, the straps). Nothing goes over a dress's photo; a jacket or shirt
          // keeps the graphics read off its back and sleeves.
          const dress = garment.style === "dress"
          if (dress || kind === "jacket" || kind === "coat" || ["shirt", "shortshirt"].includes(garment.style)) {
            const options = { flatten: dress, draped: dress && Boolean(garment.cut?.details?.includes("draping")) }
            const map = (await readDressPhoto(frontPhoto, options).catch(() => null)) ?? (frontPhoto !== garment.photo ? await readDressPhoto(garment.photo, options).catch(() => null) : null)
            if (this.outfit[kind] !== item) return
            garment.photoMap = map ? { image: map.image, soft: map.soft, layout: map.layout, color: map.color } : null
            if (map) garment.print = null
            if (map && dress) garment.backPrint = garment.sleevePrint = null
          }
        }
        // A cropped top on a guessed chart: its lengths from the photo, and the fit and drape done again.
        const cropped = kind === "top" ? croppedLengths(garment.chart, read?.look) : null
        if (cropped) {
          garment.chart = { ...garment.chart, sizes: cropped }
          this.update()
        }
        garment.lookPending = false
        this.renderOutfit()
        if (item.fit) this.render()
        this.queueLookCheck()
      }).catch(() => { garment.lookPending = false; this.queueLookCheck() })
    }
  }

  // A top's reading of its shop photos (print.js's readPhoto, front and back) laid on it: the front's print,
  // the back's, and the sleeves' graphics.
  applyTopReading(garment, read, back) {
    // A dress's photo shows ties, pleats and drapes that aren't a print: only a listing that says it's
    // printed gets the photo's print, and none goes over a dress with its photo laid on.
    const printed = !(garment.style === "dress" && (garment.photoMap?.layout?.dress || (garment.cut && !garment.cut.printed)))
    garment.print = printed ? read?.print ?? null : null
    garment.backPrint = printed && back?.print ? { image: back.print.image } : null
    // The sleeves' graphics, by the wearer's side: the front photo shows the right sleeve on its left,
    // the back photo the left one; the front photo shows each sleeve's front half, the back its back.
    const front = read?.sleeves, behind = back?.sleeves
    // Sleeves another colour all round (a varsity jacket's, a layered tee's long grey ones under its short
    // sleeves), with no photo of the back: the front's strips go on the back halves too, and the cuffs take
    // their colour.
    const wrap = Boolean(front?.wrap) && !behind
    garment.sleevePrint = printed && (front || behind) ? {
      right: { front: front?.left ?? null, back: behind?.right ?? (wrap ? front?.left ?? null : null) },
      left: { front: front?.right ?? null, back: behind?.left ?? (wrap ? front?.right ?? null : null) }
    } : null
    garment.cuffTone = printed && wrap ? read?.cuffTone ?? null : null
  }

  // The 3D view's check against the shop's photo (look_check.js), for the top: it runs once the clothes are
  // on (and the photo is read), behind the veil, which stays until it passes. A reading that doesn't match is
  // tried again another way (nextReading), up to three tries; then the person is told, and offered the fit in
  // plain colour or the AI picture. Once per garment: a new size or body doesn't need it again.
  queueLookCheck() {
    const item = this.outfit.top, garment = item?.garment
    // A top that couldn't be matched and has since been taken off (or swapped) no longer holds the veil.
    if (this.lookStuckOn && this.lookStuckOn !== garment) this.lookStuckOn = null
    if (!garment?.photo || garment.lookDone || !item.fit) {
      if (!this.lookStuckOn && (!this.lookRunning || this.lookRunning !== garment)) this.setLookWords(null)
      return
    }
    if (this.lookStuckOn === garment) return
    this.setLookWords(this.lookWords ?? "Checking it against the store photo…")
    if (garment.lookPending || !this.stage.settled || this.lookRunning === garment) return
    this.lookRunning = garment
    this.runLookCheck(garment).catch(error => {
      // A check that can't run (no WebGL readback, say) mustn't keep the clothes hidden.
      console.warn("[look] check didn't run:", error)
      garment.lookDone = true
      this.setLookWords(null)
    }).finally(() => { if (this.lookRunning === garment) this.lookRunning = null })
  }

  async runLookCheck(garment) {
    const current = () => this.outfit.top?.garment === garment
    for (let attempt = 1; ; ) {
      await this.lookReady()
      if (!current()) return
      const result = await this.lookResult(garment)
      if (!current()) return
      garment.lookChecks = result
      if (!result || result.ok) break
      rememberLookFailure(garment, attempt, result)
      // A dress whose outline didn't match its photo's: cut again once, its hem as much wider (or narrower)
      // as the render fell short (or went past), and checked again. Its print and colour stay as read. A
      // second miss isn't held against it: the drawing is as near the photo as the cloth will hang.
      if (result.failed.includes("shape")) {
        const shape = !garment.reshaped && reshaped(garment.cut?.shape, result.checks.shape)
        if (shape) {
          garment.reshaped = true
          garment.cut = { ...garment.cut, shape }
          this.renderOutfit()
          this.render()
          if (result.failed.length === 1) continue
        } else {
          result.failed = result.failed.filter(name => name !== "shape")
          result.ok = result.failed.length === 0
          if (result.ok) break
        }
      }
      // Only the back's print didn't match (the front, its sleeves and its print did): the back goes plain and
      // the front stays as read, then the front alone is checked. Reading everything again the plainest way
      // would take off sleeve stripes and the front's print that matched.
      if (result.frontOk && garment.backPrint) {
        garment.backPrint = null
        this.renderOutfit()
        this.render()
        continue
      }
      const reading = nextReading(++attempt, result.failed)
      if (!reading) { this.lookStuck(garment); return }
      this.setLookWords(`Adjusting the print (try ${attempt} of 3)…`)
      await this.rereadTop(garment, reading)
      if (!current()) return
    }
    garment.lookDone = true
    this.setLookWords(null)
    // Its row says when its outline still isn't its photo's.
    if (garment.lookChecks?.checks?.shape?.pass === false) this.renderOutfit()
  }

  // Until the clothes are on and drawn (a texture laid on is uploaded on the next frame).
  async lookReady() {
    for (let i = 0; i < 1200 && !this.stage.settled; i++) await new Promise(resolve => setTimeout(resolve, 100))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  }

  // The checks, front (and back, when a back print is laid on): both the shop's photo and the 3D view's
  // picture of the garment alone read the plain way (look_check.js's PLAIN). Null when it can't be checked.
  async lookResult(garment) {
    const photos = garment.lookPhotos
    if (!photos?.front) return null
    const shape = frontShape(garment.chart)
    garment.lookPlain ??= {}
    garment.lookPlain.front ??= (await readPhoto(photos.front, { shape, ...PLAIN }))?.look ?? null
    const shot = await this.stage.lookShot("top")
    if (!shot || !garment.lookPlain.front) return null
    const named = namedColour(garment)
    // The AI's likeness of the two, when its model is there in time (it's loaded while the clothes drape).
    garment.lookPixels ??= await pixelsOf(photos.front, 480).catch(() => null)
    const alike = garment.lookPixels ? await likeness(garment.lookPixels, shot) : null
    const renderLook = findPrint(shot.data, shot.width, shot.height, null, PLAIN)?.look
    // A dress drawn without its photo's print (see applyTopReading) has only its colour and likeness to match.
    const unprinted = garment.style === "dress" && Boolean(garment.cut) && !garment.cut.printed
    const front = compareLooks(garment.lookPlain.front, renderLook, { named, likeness: alike, unprinted })
    // A dress cut to its photo's outline: the render's outline is held to the photo's (how much it widens
    // from the waist to the hem).
    if (garment.style === "dress" && garment.cut?.shape) {
      garment.lookPlain.dress ??= await readDressShape(photos.front).catch(() => null)
      const cut = garmentMask(shot.data, shot.width, shot.height)
      const outline = compareShapes(garment.lookPlain.dress, cut && measureDressMask(cut.mask, cut.w, cut.h))
      if (outline) {
        front.checks.shape = outline
        if (!outline.pass) { front.failed.push("shape"); front.ok = false }
      }
    }
    // Both readings go with the result, for the failure log and the look audit (script/spike/look_audit.mjs).
    front.looks = { photo: garment.lookPlain.front, render: renderLook }
    if (!garment.backPrint || !photos.back) return front
    garment.lookPlain.back ??= (await readPhoto(photos.back, PLAIN))?.look ?? null
    const backShot = await this.stage.lookShot("top", { back: true })
    if (!backShot || !garment.lookPlain.back) return front
    const back = compareLooks(garment.lookPlain.back, findPrint(backShot.data, backShot.width, backShot.height, null, PLAIN)?.look, { unprinted })
    return { ok: front.ok && back.ok, frontOk: front.ok, failed: [...new Set([...front.failed, ...back.failed])], checks: front.checks, back: back.checks, looks: front.looks }
  }

  // The top's photos read again another way (nextReading) and laid on.
  async rereadTop(garment, reading) {
    const photos = garment.lookPhotos, shape = frontShape(garment.chart)
    const options = { shape, hood: reading.hood, patterns: reading.patterns, sleeves: reading.sleeves }
    const read = await readPhoto(photos.front, options).catch(() => null)
    let back = reading.back && photos.back ? await readPhoto(photos.back, options).catch(() => null) : null
    if (back && read && colorGap(back.color, read.color) > 40) back = null
    const colour = reading.listingColour && namedColour(garment) ? garment.listingColor : read?.color ? asNamed(read.color, garment.color_name, garment.listingColor ?? garment.color) : garment.color
    garment.color = garment.photoColor = colour
    this.applyTopReading(garment, read, back)
    this.renderOutfit()
    this.render()
  }

  // Three tries and none matched: the veil stays, saying so, with the two ways on.
  lookStuck(garment) {
    this.lookStuckOn = garment
    this.setLookWords("We can't show this item's look accurately.")
    if (this.hasLoadingActionsTarget) this.loadingActionsTarget.hidden = false
    this.loadingTarget.classList.add("is-stuck")
  }

  // The fit, in the cloth's plain colour (the listing's, when it names one): the sizes are still right; only
  // the print was in doubt.
  plainLook() {
    const garment = this.lookStuckOn ?? this.outfit.top?.garment
    if (garment) {
      garment.print = garment.backPrint = garment.sleevePrint = garment.cuffTone = null
      if (namedColour(garment)) garment.color = garment.photoColor = garment.listingColor
      garment.lookDone = true
    }
    this.lookStuckOn = null
    this.setLookWords(null)
    this.renderOutfit()
    this.render()
    this.toast("Shown in plain colour: we couldn't match the store's print.")
  }

  // The AI picture instead: it paints the shop's own clothes on, so the plain fit goes under it.
  aiFromStuck() {
    this.plainLook()
    this.aiPicture()
  }

  // The check's words on the veil (null: the check is done, the veil can go when the drape is).
  setLookWords(words) {
    this.lookWords = words
    if (!words && this.hasLoadingActionsTarget) this.loadingActionsTarget.hidden = true
    if (!words) this.loadingTarget?.classList.remove("is-stuck")
    if (this.stage?.settled || words) this.showLoading(this.stage?.settled ? null : this.loadingLabelTarget.textContent)
  }

  // Just a photo: the page works out what it is (it stays here), and Fitroom gives that kind of thing its
  // usual sizes. The photo's colour and print go on the 3D view as a shop photo's do.
  // The photo tray: up to six photos of one garment, each with its role (lib/garments/photo_roles). The
  // front says what it is and gives its colour and print; the back goes on its back; a close-up of plain
  // cloth gives its colour; a size tag and a photo of it worn are kept with it. The photos stay here.
  renderTray() {
    const photos = this.trayPhotos
    const tiles = photos.map((p, i) => `
      <div class="tray-shot">
        <img src="${escape(p.url)}" alt="">
        <button type="button" class="tray-remove" aria-label="Remove this photo" data-index="${i}" data-action="fitting-room#removeTrayPhoto">×</button>
        <label class="tray-role"><span class="visually-hidden">What this photo shows</span>
          <select autocomplete="off" data-index="${i}" data-action="fitting-room#changeTrayRole">${Object.entries(ROLES).map(([key, name]) => `<option value="${key}"${key === p.role ? " selected" : ""}>${name}</option>`).join("")}</select>
        </label>
      </div>`).join("")
    const add = photos.length < 6 ? `
      <label class="tray-add">
        <input type="file" accept="image/*" multiple autocomplete="off" data-action="change->fitting-room#pickTrayPhotos">
        <span>${photos.length ? "+ More" : "+ Add photos"}</span><small>${photos.length ? "Back, close-up, tag" : "Front, back, close-up, tag"}</small>
      </label>` : ""
    this.trayTargets.forEach(tray => { tray.innerHTML = tiles + add })
    this.trayAddTargets.forEach(button => { button.hidden = !photos.length })
    this.trayNoteTargets.forEach(note => { note.hidden = !photos.length })
  }

  async pickTrayPhotos(event) {
    const files = [...event.target.files]
    event.target.value = ""
    await this.addTrayFiles(files)
  }

  dragTray(event) {
    if (![...(event.dataTransfer?.items ?? [])].some(item => item.kind === "file")) return
    event.preventDefault()
    event.currentTarget.classList.add("is-over")
  }

  leaveTray(event) {
    event.currentTarget.classList.remove("is-over")
  }

  async dropTray(event) {
    event.preventDefault()
    event.currentTarget.classList.remove("is-over")
    await this.addTrayFiles([...(event.dataTransfer?.files ?? [])].filter(file => file.type.startsWith("image/")))
  }

  async addTrayFiles(files) {
    this.importErrorTarget.hidden = true
    for (const file of files.slice(0, 6 - this.trayPhotos.length)) {
      try {
        const url = await smallPhoto(file)
        this.trayPhotos.push({ url, traits: await readPhotoTraits(url).catch(() => null), role: null, picked: false })
      } catch (error) {
        this.showImportError(error.message)
      }
    }
    this.guessTrayRoles()
  }

  guessTrayRoles() {
    guessRoles(this.trayPhotos).forEach((role, i) => { this.trayPhotos[i].role = role })
    this.renderTray()
  }

  changeTrayRole(event) {
    const photo = this.trayPhotos[Number(event.target.dataset.index)]
    if (!photo) return
    photo.role = event.target.value
    photo.picked = true
    this.guessTrayRoles()
  }

  removeTrayPhoto(event) {
    this.trayPhotos.splice(Number(event.currentTarget.dataset.index), 1)
    this.guessTrayRoles()
  }

  // The photos the garment keeps, by role, for addItem.
  trayGarmentPhotos() {
    const roles = photosByRole(this.trayPhotos)
    return Object.fromEntries(Object.entries({ photo: roles.front, back_photo: roles.back, closeup: roles.closeup, tag_photo: roles.tag, worn_photo: roles.worn }).filter(([, v]) => v))
  }

  // From the photos alone: the front says what it is, and it goes on in the usual sizes.
  async importPhoto() {
    const photos = this.trayGarmentPhotos()
    if (!photos.photo) return
    const button = this.trayAddTargets[0]
    if (button) button.textContent = "Looking at the photos…"
    this.importErrorTarget.hidden = true
    try {
      const read = await readGarment(photos.photo)
      if (!read) throw new Error("Couldn't see the clothes in the front photo. Try one with the clothes on a plain background.")
      const response = await fetch(this.importUrlValue, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ photo_kind: read.kind, photo_style: read.style })
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message ?? "Couldn't add that.")
      this.addItem({ ...data.garment, ...photos })
      this.trayPhotos = []
      this.renderTray()
      this.update()
    } catch (error) {
      this.showImportError(error.message)
    } finally {
      if (button) button.textContent = "Add it in the usual sizes"
    }
  }

  removeItem(event) {
    const kind = event.currentTarget.dataset.kind
    // Both halves of a romper or jumpsuit go together.
    if (this.outfit[kind]?.garment.one_piece) for (const half of ["top", "trousers"]) { if (this.outfit[half]?.garment.one_piece) delete this.outfit[half] }
    delete this.outfit[kind]
    this.renderOutfit()
    this.update()
  }

  // The size editor (see lib/size_editor): what it is, a tab per size, the size's numbers, and where to
  // measure them.
  changeItemType(event) {
    const kind = event?.target?.value ?? this.ownKindTargets.find(input => input.checked)?.value ?? "top"
    if (kind === this.own.kind) return
    // Tops, jackets and coats share their measurements; pants start again.
    const same = (kind === "trousers") === (this.own.kind === "trousers")
    this.own = same ? { ...this.own, kind } : { kind, sizes: startingSizes(kind), at: 2, focus: partsFor(kind)[0].part }
    this.renderEditor()
  }

  renderEditor() {
    const { kind, sizes, at, focus } = this.own
    this.ownKindTargets.forEach(input => { input.checked = input.value === kind })
    const flat = this.measuredFlatTargets.find(input => input.checked)?.value === "flat"
    this.sizeTabsTarget.innerHTML = `
      <button type="button" class="size-tab-arrow" aria-label="Size before" data-step="-1" data-action="fitting-room#stepSizeTab">‹</button>
      ${sizes.map((size, i) => `
        <button type="button" role="tab" aria-selected="${i === at}" tabindex="${i === at ? 0 : -1}" class="size-tab${i === at ? " is-on" : ""}"
                data-index="${i}" data-action="fitting-room#pickSizeTab keydown->fitting-room#keySizeTab">${escape(size.name || "?")}<i class="${filled(size) ? "is-full" : ""}"></i></button>`).join("")}
      <button type="button" class="size-tab size-tab--add" aria-label="Add a size" data-action="fitting-room#addOwnSize">+</button>
      <button type="button" class="size-tab-arrow" aria-label="Size after" data-step="1" data-action="fitting-room#stepSizeTab">›</button>`
    const size = sizes[at]
    const unit = this.unit
    this.ownSizesTarget.innerHTML = `
      <label class="field field--editor">
        <span class="field-label">Size name</span>
        <span class="field-input"><input type="text" autocomplete="off" spellcheck="false" value="${escape(size.name)}" data-own="name" data-action="input->fitting-room#editOwnName"></span>
      </label>
      ${partsFor(kind).map(p => {
        const cm = size.cm[p.part]
        const shown = cm > 0 ? round((unit === "in" ? cm / 2.54 : cm) / (flat && p.flat ? 2 : 1), 4) : ""
        const [lo, hi] = sliderRange(sizes, at, p.part, p.usual).map(v => (unit === "in" ? v / 2.54 : v) / (flat && p.flat ? 2 : 1))
        return `
        <div class="field field--editor${p.part === focus ? " is-focus" : ""}">
          <label class="field-label" for="own-${p.part}">${p.label}${flat && p.flat ? " <small>across</small>" : ""}</label>
          <span class="field-input">
            <input id="own-${p.part}" type="number" inputmode="decimal" min="0" step="0.25" autocomplete="off" value="${shown}"
                   data-own="${p.part}" data-action="input->fitting-room#editOwnSize focus->fitting-room#focusOwnPart">
            <span class="field-unit">${unit}</span>
          </span>
          <input type="range" class="slider${shown === "" ? " is-unset" : ""}" min="${round(lo, 2)}" max="${round(hi, 2)}" step="${unit === "in" ? 0.25 : 0.5}" value="${shown === "" ? round((lo + hi) / 2, 2) : shown}"
                 aria-label="${p.label} slider" data-own-slider="${p.part}" data-action="input->fitting-room#slideOwnSize focus->fitting-room#focusOwnPart">
          <span class="field-help">${p.help}.</span>
        </div>`
      }).join("")}`
    this.ownDiagramTarget.innerHTML = `${diagram(kind, focus)}<p>${escape(partsFor(kind).find(p => p.part === focus)?.help ?? "")}</p>`
  }

  pickSizeTab(event) {
    this.own.at = Number(event.currentTarget.dataset.index)
    this.renderEditor()
  }

  stepSizeTab(event) {
    const at = this.own.at + Number(event.currentTarget.dataset.step)
    if (at < 0 || at >= this.own.sizes.length) return
    this.own.at = at
    this.renderEditor()
  }

  keySizeTab(event) {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key]
    if (!step) return
    event.preventDefault()
    const at = this.own.at + step
    if (at < 0 || at >= this.own.sizes.length) return
    this.own.at = at
    this.renderEditor()
    this.sizeTabsTarget.querySelector(`.size-tab[data-index="${at}"]`)?.focus()
  }

  addOwnSize() {
    this.own.sizes.push({ name: nextSizeName(this.own.sizes), cm: {} })
    this.own.at = this.own.sizes.length - 1
    this.renderEditor()
    this.ownSizesTarget.querySelector('[data-own="name"]')?.select()
  }

  editOwnName(event) {
    this.own.sizes[this.own.at].name = event.target.value
    const tab = this.sizeTabsTarget.querySelector(`.size-tab[data-index="${this.own.at}"]`)
    if (tab) tab.firstChild.textContent = event.target.value || "?"
  }

  // A number typed in: kept in cm, the slider and the tab's dot follow.
  editOwnSize(event) {
    const part = event.target.dataset.own
    const value = parseFloat(event.target.value)
    this.setOwnPart(part, Number.isFinite(value) && value > 0 ? value : null)
    const slider = this.ownSizesTarget.querySelector(`[data-own-slider="${part}"]`)
    if (slider && Number.isFinite(value)) slider.value = value
    slider?.classList.toggle("is-unset", !(value > 0))
  }

  slideOwnSize(event) {
    const part = event.target.dataset.ownSlider
    const value = parseFloat(event.target.value)
    this.setOwnPart(part, value)
    const input = this.ownSizesTarget.querySelector(`[data-own="${part}"]`)
    if (input) input.value = value
    event.target.classList.remove("is-unset")
  }

  setOwnPart(part, value) {
    const flat = this.measuredFlatTargets.find(input => input.checked)?.value === "flat"
    const spec = partsFor(this.own.kind).find(p => p.part === part)
    const size = this.own.sizes[this.own.at]
    if (value == null) delete size.cm[part]
    else size.cm[part] = round(toCm(value, this.unit) * (flat && spec?.flat ? 2 : 1), 10)
    this.sizeTabsTarget.querySelector(`.size-tab[data-index="${this.own.at}"] i`)?.classList.toggle("is-full", filled(size))
    this.editorErrorTarget.hidden = true
  }

  focusOwnPart(event) {
    const part = event.target.dataset.own ?? event.target.dataset.ownSlider
    if (!part || part === this.own.focus) return
    this.own.focus = part
    this.ownSizesTarget.querySelectorAll(".field--editor").forEach(field => field.classList.toggle("is-focus", field.querySelector(`[data-own="${part}"]`) !== null))
    this.ownDiagramTarget.innerHTML = `${diagram(this.own.kind, part)}<p>${escape(partsFor(this.own.kind).find(p => p.part === part)?.help ?? "")}</p>`
  }

  // Across, flat, or all the way round: the numbers stay the garment's, the boxes show them as measured.
  changeMeasuredFlat() {
    this.renderEditor()
  }

  // Every size with its main number in goes on. A garment read from its link's words (see linkNote) keeps
  // its name, look and photo, now with its own sizes.
  useOwnItem() {
    const kind = this.own.kind
    const chart = chartFromSizes(this.own.sizes, kind, false)
    if (chart.sizes.length === 0) {
      this.editorErrorTarget.textContent = `Type in at least the ${partsFor(kind)[0].label.toLowerCase()} for one size.`
      this.editorErrorTarget.hidden = false
      return
    }
    this.editorErrorTarget.hidden = true
    const linked = this.outfit[kind]?.garment.link_note ? this.outfit[kind].garment : null
    const garment = linked
      ? (({ link_note, photoColor, photoMap, print, backPrint, cuffTone, lookDone, lookChecks, ...rest }) => ({ ...rest, color: rest.listingColor ?? rest.color }))(linked)
      : {
          name: `Your ${KINDS[kind].toLowerCase()}`, brand: null, color_name: null, color: "#2a3552",
          source_url: null, garment: kind, photo: null, fabric: kind === "top" ? "cotton" : "wool",
          ...(DEFAULT_STYLE[kind] ? { style: DEFAULT_STYLE[kind] } : {})
        }
    this.addItem({ ...garment, ...this.trayGarmentPhotos(), chart })
    this.trayPhotos = []
    this.renderTray()
    this.update()
  }

  // A garment read from its link's words (the store wouldn't give its page): its sizes, typed or pasted, or a
  // photo of it make it truer. "Add its sizes" opens the ways to add them, set to its kind.
  openSizes(event) {
    const more = this.element.querySelector(".more-ways")
    if (more) more.open = true
    const kind = event.currentTarget.dataset.kind
    if (["top", "jacket", "coat", "trousers"].includes(kind)) this.changeItemType({ target: { value: kind } })
    this.sizeTabsTarget.scrollIntoView({ behavior: "smooth", block: "center" })
    this.ownSizesTarget.querySelector('input[type="number"]')?.focus({ preventScroll: true })
  }

  // A photo of a garment already on (one read from its link's words): read here for its colour and print,
  // as a store's photo is, and kept on the device.
  async addRowPhoto(event) {
    const input = event.currentTarget, kind = input.dataset.kind
    const file = input.files[0], item = this.outfit[kind]
    if (!file || !item) return
    try {
      const photo = await smallPhoto(file)
      if (this.outfit[kind] !== item) return
      const { photoColor, photoMap, print, backPrint, cuffTone, lookDone, lookChecks, ...garment } = item.garment
      this.addItem({ ...garment, photo, color: garment.listingColor ?? garment.color })
      this.update()
    } catch (error) {
      this.showImportError(error.message)
    }
  }

  showImportError(message) {
    this.importErrorTarget.textContent = message
    this.importErrorTarget.hidden = false
  }

  renderOutfit() {
    const items = this.items()
    // Hips and leg length only matter for pants.
    // Hips matter for pants and dresses; leg length only for pants.
    const dress = this.outfit.top?.garment.style === "dress"
    this.pantsOnlyTargets.forEach(field => { field.hidden = !(this.outfit.trousers || (dress && field.dataset.alsoDress)) })
    this.outfitListTarget.innerHTML = items.length ? items.map(({ kind, garment }) => {
      const chart = garment.chart
      const notes = ACCESSORIES.includes(kind) ? [chart.sizes.length === 1 ? "1 size" : `${chart.sizes.length} sizes`, "shown for the look, not fitted"] : [
        chart.sizes.length === 1 ? "1 size" : `${chart.sizes.length} sizes`,
        chart.kind === "body" ? "sizes guessed from the store's body chart" : null,
        chart.kind === "sizes" ? "sizes guessed from the size names" : null,
        chart.missing.length ? `the chart doesn't show the ${listed(chart.missing.map(m => (PART_NAMES[m] ?? m.replace("_", " ")).toLowerCase()))}` : null,
        // The store measured its sleeves from the back of the neck (it said so, or they were too long to be
        // from the shoulder); the import took off half the shoulders.
        chart.sleeve_from === "centre_back" ? "sleeves measured from the centre back, read from the shoulder" : null,
        chart.sleeve_from === "centre_back_guessed" ? "sleeves look measured from the centre back, so they're read from the shoulder" : null,
        garment.cut?.details?.length ? `the 3D view doesn't show its ${listed(garment.cut.details)}` : null,
        // Its outline, redrawn once, still not its photo's (see runLookCheck).
        garment.lookChecks?.checks?.shape?.pass === false ? `the 3D view draws it ${garment.lookChecks.checks.shape.score < 1 ? "straighter" : "fuller"} at the hem than its photo` : null
      ].filter(Boolean)
      // The shop's photo on a tile in the stage's own tone, its white backdrop knocked out (see showTiles);
      // until that's done, blended onto the tile. No photo: a swatch of the colour.
      const thumb = garment.photo
        ? `<img class="rail-photo" src="${escape(garment.photo)}" alt="">`
        : `<span class="rail-swatch" style="background:${escape(garment.color)}"></span>`
      const source = garment.source_url ? ` <a href="${escape(garment.source_url)}" target="_blank" rel="noopener noreferrer">See it in the store</a>` : ""
      return `
        <div class="rail-item" data-kind="${kind}">
          <div class="rail-tile" data-kind="${kind}">${thumb}</div>
          <div class="rail-text">
            <p class="rail-kind mono">${garment.one_piece ? `One piece · ${kind === "top" ? "top half" : "bottom half"}` : kindLabel(kind, garment)}</p>
            <p class="rail-name">${escape(garment.name)}</p>
            <p class="rail-meta">${escape([garment.brand, garment.color_name, garment.fabric && garment.fabric !== "wool" ? garment.fabric : null].filter(Boolean).join(" · "))}</p>
            <p class="rail-size" data-rail-size="${kind}" hidden></p>
            <p class="rail-notes">${escape(capitalize(notes.join(", ")))}.${source}</p>
            ${garment.link_note ? linkNote(kind, garment) : ""}
          </div>
          <button type="button" class="text-button rail-remove" data-kind="${kind}" data-action="fitting-room#removeItem" aria-label="Remove ${KINDS[kind].toLowerCase()}">Remove</button>
        </div>`
    }).join("") : `<p class="hint">Nothing yet. Paste a link below, or try one of ours.</p>`
    this.showTiles(items)
    this.showRailSizes(items)

    this.stagePhotosTarget.innerHTML = items.filter(i => i.garment.photo)
      .map(i => `<img class="stage-photo" src="${escape(i.garment.photo)}" alt="Your photo of the ${KINDS[i.kind].toLowerCase()}">`).join("")
  }

  // Each rail tile's photo with its white backdrop taken out, worked out once per photo (in the browser;
  // the photo stays on the device) and swapped in when ready, if the item's still there.
  showTiles(items) {
    for (const { kind, garment } of items) {
      if (!garment.photo) continue
      let tile = this.tiles.get(garment.photo)
      if (!tile) {
        tile = knockoutPhoto(garment.photo)
        this.tiles.set(garment.photo, tile)
        if (this.tiles.size > 24) this.tiles.delete(this.tiles.keys().next().value)
      }
      tile.then(canvas => {
        const box = this.outfitListTarget.querySelector(`.rail-tile[data-kind="${kind}"]`)
        if (!canvas || !box || this.outfit[kind]?.garment.photo !== garment.photo) return
        canvas.className = "rail-cut"
        canvas.setAttribute("aria-hidden", "true")
        box.replaceChildren(canvas)
      })
    }
  }

  // On each rail item, the size shown and whether it's the best one (once the fit is known).
  showRailSizes(items = this.items()) {
    for (const { kind, fit, selected } of items) {
      const line = this.outfitListTarget.querySelector(`[data-rail-size="${kind}"]`)
      if (!line) continue
      if (!fit || !selected) { line.hidden = true; continue }
      const best = fit.sizes.length > 1 && selected === fit.best
      const only = fit.sizes.length === 1
      line.hidden = false
      line.innerHTML = `<span class="rail-chip">${escape(selected)}</span>${ACCESSORIES.includes(kind) ? "" : best || only ? `<span class="rail-best">${only ? "Only size" : "★ Best size"}</span>` : `<span class="rail-other">Best: ${escape(fit.best)}</span>`}`
    }
  }

  // A different look for an item ("Looks like" or "Fabric" on its card): only the drawing changes.
  items() {
    return ORDER.filter(kind => this.outfit[kind]).map(kind => ({ kind, ...this.outfit[kind] }))
  }

  // Measurements

  changeUnit(event) {
    const next = event.target.value
    if (next === this.unit) return

    const height = this.readHeight()
    for (const input of this.inputTargets) {
      if (input.dataset.part === "height") continue
      const value = parseFloat(input.value)
      if (!Number.isFinite(value)) continue
      const cm = toCm(value, this.unit)
      input.value = next === "in" ? round(cm / 2.54, 4) : round(cm, 2)
    }
    this.unit = next
    this.writeHeight(height == null ? null : toCm(height, this.unit === "in" ? "cm" : "in"))
    this.showUnit()
    this.renderEditor()
    this.update()
  }

  // A slider sets its measurement (and the box shows the number); typing moves the slider.
  slide(event) {
    const slider = event.currentTarget
    const value = parseFloat(slider.value)
    if (slider.dataset.sliderFor === "height") this.writeHeight(toCm(value, this.unit))
    else this.inputTargets.find(input => input.dataset.part === slider.dataset.sliderFor).value = value
    this.clearFromPhotos(slider.dataset.sliderFor)
    this.update()
  }

  syncSliders() {
    const values = this.readMeasurements()
    for (const slider of this.sliderTargets) {
      const toUnit = cm => (this.unit === "in" ? cm / 2.54 : cm)
      slider.min = Math.floor(toUnit(+slider.dataset.minCm) * 2) / 2
      slider.max = Math.ceil(toUnit(+slider.dataset.maxCm) * 2) / 2
      slider.step = 0.5
      const value = values[slider.dataset.sliderFor]
      slider.classList.toggle("is-unset", value == null)
      slider.value = value ?? (+slider.min + +slider.max) / 2
    }
  }

  // Inches show height as feet and inches; centimetres as one number.
  showUnit() {
    this.unitLabelTargets.forEach(label => { label.textContent = this.unit })
    this.heightImperialTarget.hidden = this.unit !== "in"
    this.heightMetricTarget.hidden = this.unit === "in"
  }

  // Height in the current unit, or null.
  readHeight() {
    if (this.unit === "in") {
      const feet = parseFloat(this.heightFeetTarget.value), inches = parseFloat(this.heightInchesTarget.value)
      const total = (Number.isFinite(feet) ? feet * 12 : 0) + (Number.isFinite(inches) ? inches : 0)
      return total > 0 ? total : null
    }
    const cm = parseFloat(this.heightMetricTarget.querySelector("input").value)
    return Number.isFinite(cm) && cm > 0 ? cm : null
  }

  // Shows a height (cm, or null to clear it) in the current unit.
  writeHeight(cm) {
    const metric = this.heightMetricTarget.querySelector("input")
    if (cm == null) {
      this.heightFeetTarget.value = this.heightInchesTarget.value = metric.value = ""
      return
    }
    const inches = Math.round((cm / 2.54) * 2) / 2
    this.heightFeetTarget.value = Math.floor(inches / 12)
    this.heightInchesTarget.value = inches - Math.floor(inches / 12) * 12
    metric.value = round(cm, 2)
  }

  fillExample() {
    this.clearFromPhotos()
    this.fillNumbers(this.example)
  }

  // Shows measurements (cm, by part) in the current unit; a height is set when given.
  fillNumbers(cm) {
    for (const input of this.inputTargets) {
      if (input.dataset.part === "height" || !(cm[input.dataset.part] > 0)) continue
      input.value = this.unit === "in" ? round(cm[input.dataset.part] / 2.54, 4) : round(cm[input.dataset.part], 2)
    }
    if (cm.height > 0) this.writeHeight(cm.height)
    this.update()
  }

  clear() {
    this.inputTargets.forEach(input => { input.value = "" })
    this.writeHeight(null)
    this.clearFromPhotos()
    this.update()
  }

  // Measuring from two photos (see lib/measure_photo.js): the photos are read here in the tab and dropped.

  pickBodyPhoto(event) {
    const input = event.currentTarget
    const which = input === this.bodyPhotoFrontTarget ? "Front" : "Side"
    const label = which === "Front" ? this.bodyPhotoFrontLabelTarget : this.bodyPhotoSideLabelTarget
    label.textContent = input.files?.[0] ? `${which} photo added. Tap to change it.` : `+ ${which} photo`
    this.bodyPhotoStatusTarget.textContent = ""
  }

  async measurePhotos() {
    const front = this.bodyPhotoFrontTarget.files?.[0], side = this.bodyPhotoSideTarget.files?.[0]
    const status = this.bodyPhotoStatusTarget
    this.bodyPhotoResultTarget.hidden = true
    if (!front || !side) { status.textContent = "Add both photos first: one from the front, one from the side."; return }
    const height = this.readHeight()
    if (height == null) { status.textContent = "Type your height first. We need it to work out how big you are in the photos."; return }

    const button = this.bodyPhotoButtonTarget
    button.disabled = true
    try {
      const found = await measureFromPhotos(front, side, toCm(height, this.unit), { onProgress: text => { status.textContent = text } })
      const parts = ["chest", "waist", "hips", "shoulders", "arm", "inseam"]
      this.fillNumbers(Object.fromEntries(parts.map(part => [part, found[part]])))
      this.markFromPhotos(parts)
      status.textContent = ""
      const notes = found.notes.join(" ")
      const rough = found.confidence < 0.6 ? " These are a rough guess." : ""
      this.bodyPhotoResultTarget.textContent = `We filled in ${parts.length} numbers. Check them, and fix any that look off.${rough}${notes ? ` ${notes}` : ""}`
      this.bodyPhotoResultTarget.hidden = false
    } catch (error) {
      status.textContent = error.plain ? error.message : "Couldn't load the photo tool. You can still type your numbers."
    } finally {
      button.disabled = false
      // The photos are no longer needed: let the browser drop them.
      this.bodyPhotoFrontTarget.value = this.bodyPhotoSideTarget.value = ""
      this.bodyPhotoFrontLabelTarget.textContent = "+ Front photo"
      this.bodyPhotoSideLabelTarget.textContent = "+ Side photo"
    }
  }

  // "From your photos." under each number the photos filled in, until the person edits that number.
  markFromPhotos(parts) {
    for (const part of parts) {
      const help = this.helpFor(part)
      if (!help || help.querySelector(".field-help-from")) continue
      const mark = document.createElement("span")
      mark.className = "field-help-from"
      mark.textContent = " From your photos."
      help.append(mark)
    }
  }

  clearFromPhotos(part = null) {
    const helps = part ? [this.helpFor(part)] : this.inputTargets.map(input => this.helpFor(input.dataset.part))
    for (const help of helps) help?.querySelector(".field-help-from")?.remove()
  }

  helpFor(part) {
    return this.inputTargets.find(input => input.dataset.part === part)?.closest(".field")?.querySelector(".field-help") ?? null
  }

  // How snug the person likes clothes ("slim", "regular" or "classic", as the API calls them).
  get cut() {
    return this.cutTargets.find(radio => radio.checked)?.value ?? "regular"
  }

  // The stage

  // The studio: an off-white sweep like a shop's lookbook (the usual), a pale daylight one, or the dark stage.
  changeScene(event) {
    this.showScene(event.target.value)
  }

  showScene(name) {
    this.stage.setScene(name)
    const box = this.canvasTarget.closest(".stage")
    for (const scene of ["studio", "daylight", "dark"]) box?.classList.toggle(`stage--${scene}`, scene === name)
  }

  // The figure is framed between the controls over the top of the picture and the size rows over its
  // bottom, however they wrap or the window is sized.
  watchInsets() {
    const box = this.canvasTarget.closest(".stage")
    const top = box?.querySelector(".stage-top")
    if (!box || !top || !("ResizeObserver" in window)) return
    const measure = () => {
      const canvas = this.canvasTarget.getBoundingClientRect()
      if (!canvas.height) return
      const over = (element, side) => {
        if (!element || element.hidden) return 0
        const r = element.getBoundingClientRect()
        if (!r.height) return 0
        return side === "top" ? Math.max(0, Math.min(canvas.height, r.bottom - canvas.top)) : Math.max(0, Math.min(canvas.height, canvas.bottom - r.top))
      }
      this.stage.setInsets({ top: Math.round(over(top, "top") + 8), bottom: 8 })
    }
    this.insetWatch = new ResizeObserver(measure)
    this.insetWatch.observe(top)
    this.insetWatch.observe(this.canvasTarget)
    this.stage.ready.then(measure)
  }

  changeView(event) {
    this.legendTarget.hidden = event.target.value !== "fit"
    this.stage.setView(event.target.value)
  }

  // Man or woman: the mannequin's body, picked at the top of step 2 or over the 3D view (they stay alike).
  // Example numbers become the other body's example numbers, and the sample T-shirt becomes the sample dress
  // (and back); numbers and clothes the person added stay as they are.
  changeBodyType(event) {
    const type = event.target.value
    const hadExample = this.showsExample(EXAMPLES_CM[this.shownBodyType ?? "men"])
    this.shownBodyType = type
    this.bodyTypeTargets.forEach(input => { input.checked = input.value === type })
    this.stage.setBodyType(type)
    const top = this.outfit.top?.garment
    const [from, to] = type === "women" ? [this.garmentValue, this.dressValue] : [this.dressValue, this.garmentValue]
    if (top && to?.name && top.name === from?.name) {
      this.addItem(structuredClone(to))
      this.renderOutfit()
    }
    if (hadExample) this.fillExample()
    else this.update()
  }

  // Whether the numbers filled in are these example numbers.
  showsExample(example) {
    const measurements = this.readMeasurements()
    return REQUIRED.every(key => measurements[key] > 0 && Math.abs(toCm(measurements[key], this.unit) - example[key]) < 1)
  }

  useDress() {
    this.addItem(structuredClone(this.dressValue))
    this.update()
  }

  get bodyType() {
    return this.bodyTypeTargets.find(input => input.checked)?.value ?? "men"
  }

  get example() {
    return EXAMPLES_CM[this.bodyType] ?? EXAMPLES_CM.men
  }

  changeTone(event) {
    this.stage.setTone(event.target.value)
  }

  // A top worn tucked into the pants or skirt, or not (only tops that tuck in offer it).
  changeTuck(event) {
    this.stage.setTucked(event.target.value === "in")
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
  update(event) {
    // A number typed over one the photos filled in is the person's own now.
    if (event?.type === "input" && event.target?.dataset?.part) this.clearFromPhotos(event.target.dataset.part)
    this.syncSliders()
    clearTimeout(this.timer)
    this.requests?.forEach(r => r.abort())

    const measurements = this.readMeasurements()
    // The clothes are always on: numbers not filled in yet are guessed from the ones that are (or are the
    // example body's), and the page says which.
    let given = Object.fromEntries(Object.entries(measurements).filter(([, v]) => v > 0))
    this.guessed = REQUIRED.filter(key => !(given[key] > 0))
    if (this.guessed.length) given = this.withGuesses(given)
    // The mannequin takes the example body's hips and leg length, in proportion, until they're given (the
    // fit itself still asks for them where they matter): without them its hips are the base model's, and a
    // long dress cut for real hips slides off it.
    const shape = Object.fromEntries(Object.entries(given).map(([k, v]) => [k, toCm(v, this.unit)]))
    const example = this.example
    shape.hips ??= example.hips * (shape.waist ?? example.waist) / example.waist
    shape.inseam ??= example.inseam * (shape.height ?? example.height) / example.height
    this.limited = this.stage.setBody(shape)
    this.timer = setTimeout(() => this.fetchFits(given), 150)
  }

  // The numbers given (in the units shown), with the rest guessed: from height for arm and shoulders, from
  // chest for waist and shoulders (and the other way round), else the example body's.
  withGuesses(given) {
    const cm = Object.fromEntries(Object.entries(given).map(([k, v]) => [k, toCm(v, this.unit)]))
    const example = this.example
    const tall = (cm.height ?? example.height) / example.height
    const chest = cm.chest ?? (cm.waist ? cm.waist * (this.example.chest / this.example.waist) : null)
    const guess = {
      height: example.height,
      chest: chest ?? example.chest,
      waist: chest ? chest * (example.waist / example.chest) : example.waist,
      shoulders: example.shoulders * (chest ? Math.sqrt(chest / example.chest) : 1) * Math.sqrt(tall),
      arm: example.arm * tall
    }
    const filled = { ...cm }
    for (const key of this.guessed) filled[key] = Math.round(guess[key] * 2) / 2
    const back = value => (this.unit === "in" ? value / 2.54 : value)
    return Object.fromEntries(Object.entries(filled).map(([k, v]) => [k, back(v)]))
  }

  async fetchFits(measurements) {
    const items = this.items()
    if (items.length === 0) {
      this.stage.setOutfit([])
      this.showEmpty("Nothing to try on yet", "Pick clothes in step 1 to see how they fit.")
      return
    }
    this.requests = items.map(() => new AbortController())
    try {
      const responses = await Promise.all(items.map(({ kind, garment }, i) => ACCESSORIES.includes(kind) ? Promise.resolve({ ok: true, data: accessoryFit(garment, this.outfit[kind]?.selected) }) : fetch(this.fitsUrlValue, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ cut: this.cut, unit: this.unit, garment: kind, style: garment.style, details: fitDetails(garment),
          sizes: garment.chart.sizes, measurements }),
        signal: this.requests[i].signal,
        cache: "no-store"
      }).then(async r => ({ ok: r.ok, data: await r.json() }))))

      const failed = responses.find(r => !r.ok)
      if (failed) {
        // A size's own number (sizes.2.sleeve) is the store's, not the person's: say so plainly.
        const problems = Object.entries(failed.data.errors ?? {}).map(([part, message]) => {
          const [, index, name] = part.match(/^sizes\.(\d+)\.(\w+)$/) ?? []
          if (name) return `The clothes' size chart has a ${PART_NAMES[name]?.toLowerCase() ?? name} number that doesn't look right (in its size ${Number(index) + 1}).`
          return `${capitalize(BODY_WORDS[part]?.[0] ?? part)} ${message}.`
        })
        this.stage.setOutfit([])
        this.showEmpty("Check your numbers", problems.join(" ") || "One of the numbers doesn't look right.")
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
      if (error.name !== "AbortError") this.showEmpty("Can't reach Fitroom", "Check that the server is running, then try again.")
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
    // Tops, casual jackets and pants are draped here on the page, so their photo is taken here too.
    if (this.stage.hasDraped || snapshot.items.some(item => item.kind === "top" || item.kind === "trousers" || ["zip", "bomber", "shirt", "cardigan"].includes(item.style))) {
      this.closeStudio()
      this.showStudio("Taking the photo…")
      if (!this.stage.settled) {
        this.showStudio("Wait for the cloth to finish settling, then take the photo.")
        return
      }
      const box = this.canvasTarget.parentElement
      const scale = 2000 / Math.max(box.clientWidth, box.clientHeight)
      const cloud = this.hasLookAiTarget && this.lookAiTarget.checked && this.hasLookUrlValue
      const passes = await this.stage.photoPasses({ width: Math.round(box.clientWidth * scale), height: Math.round(box.clientHeight * scale), guides: cloud })
      this.studioImages = { draped: URL.createObjectURL(passes.image) }
      this.showStudioImage("draped")
      this.studioStatusTarget.textContent = "Your photo. It was made on this device and isn't saved anywhere."
      if (cloud) this.cloudStudioLook(passes)
      else this.finishStudioLook(passes.image)
      return
    }
    this.closeStudio()
    this.showStudio("Sending the outfit to the studio…")
    const token = this.studioToken = Symbol("studio")
    try {
      // With "Exact item" ticked, each item's photo (the shop's, or yours) goes along, shrunk to a sensible size.
      const exact = this.hasExactTarget && this.exactTarget.checked
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
      if (exact && !job.exact_available) this.studioNote = "Store-photo versions need the try-on service set up on the server."
      else if (exact && !job.exact) this.studioNote = "No item has a photo, so there's no store-photo version."
      else this.studioNote = null

      const began = Date.now()
      this.studioImages = {}
      this.studioChecks = null
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 1500))
        if (token !== this.studioToken) return
        const status = await fetch(job.status_url, { cache: "no-store" }).then(r => r.json())
        if (status.status === "failed" || status.error) throw new Error("The render didn't work. Try again.")
        if (!this.studioImages.draped && (status.status === "styling" || status.status === "done")) {
          this.studioImages.draped = await this.fetchStudioImage(job.image_url)
          this.showStudioImage("draped")
        }
        // The try-on service's checks on each garment (shape, colour, print), to show beside the pictures.
        if (status.exact_checks) this.studioChecks = status.exact_checks
        if (status.exact === "done" && !this.studioImages.exact) {
          this.studioImages.exact = await this.fetchStudioImage(job.exact_image_url)
          this.studioSwitchTarget.hidden = false
          this.studioSwitchTarget.querySelector('input[value="exact"]').checked = true
          this.offerCompare()
          this.showStudioImage("exact")
        }
        if (status.status === "done") {
          if (status.exact === "failed") this.studioNote = "The store-photo version didn't work; here's the measured drape."
          if (status.exact === "refused") {
            // The service painted it but a check said no: the page keeps its own picture and can show why.
            this.studioNote = "The AI's picture didn't pass our checks, so here's our own. Nothing was kept."
            if (this.studioChecks) {
              this.studioSwitchTarget.hidden = false
              this.studioSwitchTarget.querySelector('input[value="exact"]').parentElement.hidden = true
              this.offerCompare()
            }
          }
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

  // The AI picture (TryOn.dress on the server): the page's photo, from the front, with the stores' own
  // photos of the clothes painted on, the outermost top and then the pants. Only that picture, its outline
  // and the stores' photos go; the answer is the new picture and our checks on it. Nothing is kept.
  //
  // It's a job on the server (POST answers at once with its id), asked after every 1.5 s until it's done:
  // the GPU may have to wake up first, which no single request could wait for. Stop (closeStudio aborts the
  // request) or leaving the page DELETEs the job, which cancels the GPU's work too.
  //
  // While it's being made, the 3D view stays where it is under a veil (see showVeil) and the stage's controls
  // are inert; the picture then opens in the studio panel over the same box, where the person is looking. If
  // the AI says no or something goes wrong, the veil goes and the person is back on the 3D view with a short
  // word saying so.
  async aiPicture() {
    if (!this.hasTryOnUrlValue) return
    // Pressed again while one is being made: the veil is already up; keep it.
    if (this.aiBusy) { this.showVeil(this.veilWords); return }
    const items = TRY_ON_KINDS.map(kind => [kind, this.outfit[kind]])
      .filter(([, item]) => item?.garment.photo && item.garment.style !== "dress")
    this.closeStudio()
    if (!items.length) {
      this.toast("Add clothes from a store link first. The AI paints the store's own photo on.")
      return
    }
    if (!this.stage.settled) {
      this.toast("Wait for the cloth to finish settling, then try again.")
      return
    }
    this.aiBusy = true
    if (this.hasAiButtonTarget) this.aiButtonTarget.disabled = true
    this.coverStage(true)
    this.showVeil("Taking the photo…")
    const token = this.studioToken = Symbol("ai")
    const controller = this.studioAbort = new AbortController()
    const began = Date.now()
    // What the server last said (TryOnJob.status): "starting" (a GPU waking up) or "painting", and which
    // garment of how many; "sent" until it first answers.
    let progress = null
    const tick = setInterval(() => {
      if (token !== this.studioToken || !progress) return
      const seconds = Math.round((Date.now() - began) / 1000)
      const garment = progress.layer === "trousers" ? "pants" : progress.layer
      const of = progress.layers?.length > 1 ? ` (${progress.layers.indexOf(progress.layer) + 1} of ${progress.layers.length})` : ""
      this.showVeil(progress.status === "painting"
        ? `Painting the store's ${garment ?? "clothes"} on with AI${of}… ${seconds}s`
        : progress.status === "starting"
          ? `Waking the AI up${of}… ${seconds}s (it sleeps when nobody's using it; usually under a minute)`
          : `Sending the photo to the AI… ${seconds}s`)
    }, 1000)
    let cancel = null
    try {
      // A portrait close-up of the figure, in the AI's own shape (576 by 864) at twice its size: the clothes
      // fill the frame it paints in, instead of a narrow strip of the wide stage, and its picture, doubled
      // (see the service's upscaler), comes back at this size.
      const passes = await this.stage.photoPasses({ width: AI_WIDTH, height: AI_HEIGHT, guides: true, front: true, close: true })
      if (token !== this.studioToken) return
      this.studioImages = { draped: URL.createObjectURL(passes.image) }
      this.studioChecks = null
      const [photo, outline, shops] = await Promise.all([
        pngDataUrl(passes.image, AI_HEIGHT),
        pngDataUrl(passes.mask, AI_HEIGHT),
        Promise.all(items.map(([, item]) => shrunkPhoto(item.garment.photo)))
      ])
      const answer = await fetch(this.tryOnUrlValue, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ photo, outline, items: items.map(([kind], i) => ({ kind, photo: shops[i] })) }),
        signal: controller.signal
      })
      const started = await answer.json()
      if (!answer.ok) throw new Error(started.message ?? "The AI picture didn't work this time.")
      const jobUrl = `${this.tryOnUrlValue}/${encodeURIComponent(started.job)}`
      let finished = false
      cancel = () => {
        if (finished) return
        finished = true
        fetch(jobUrl, { method: "DELETE", headers: { Accept: "application/json" }, keepalive: true }).catch(() => {})
      }
      controller.signal.addEventListener("abort", cancel, { once: true })
      window.addEventListener("pagehide", cancel)
      if (token !== this.studioToken) { cancel(); return }
      progress = { status: "sent" }
      let reply
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 1500))
        if (token !== this.studioToken) return
        const asked = await fetch(jobUrl, { headers: { Accept: "application/json" }, signal: controller.signal })
        reply = await asked.json()
        if (token !== this.studioToken) return
        if (!asked.ok || reply.status === "failed" || reply.status === "cancelled") {
          throw new Error(reply.message ?? "The AI picture didn't work this time.")
        }
        if (reply.status === "done") break
        progress = reply
      }
      finished = true
      this.studioChecks = reply.checks && Object.keys(reply.checks).length ? reply.checks : null
      if (reply.image) {
        const painted = await (await fetch(reply.image)).blob()
        if (token !== this.studioToken) return
        this.studioImages.exact = URL.createObjectURL(painted)
        this.studioSwitchTarget.hidden = false
        this.studioSwitchTarget.querySelector('input[value="exact"]').checked = true
        this.offerCompare()
        this.showStudioImage("exact")
        // The AI's picture goes onto the 3D clothes too, from the camera that took the photo, so the figure can
        // be turned with it on (see seeIn3D and FittingStage#wearPhoto). The stage takes it off when the outfit,
        // a size, the body or the pose changes.
        this.stage.wearPhoto?.(painted)
        if (this.hasSeeIn3dTarget) this.seeIn3dTarget.hidden = false
        // The picture opens over the 3D view, where the person is looking: the veil fades as the panel fades in.
        this.openStudio()
        this.hideVeil()
      } else {
        // The service painted it but a check said no: nothing is shown, and the person is told.
        this.closeStudio()
        this.toast("The AI's picture didn't pass our checks, so here's our own. Nothing was kept.")
      }
    } catch (error) {
      if (token === this.studioToken && error.name !== "AbortError") {
        this.closeStudio()
        this.toast(error.message)
      }
    } finally {
      clearInterval(tick)
      if (cancel) window.removeEventListener("pagehide", cancel)
      this.aiBusy = false
      if (this.hasAiButtonTarget) this.aiButtonTarget.disabled = false
      if (this.studioTarget.hidden) this.uncoverStage()
    }
  }

  // "See it in 3D": the panel closes and the AI's picture stays on the turning figure (on the front, from the
  // camera that took it; the page's own cloth round the back), with a note saying so until it comes off.
  seeIn3D() {
    this.keepWorn = true
    try { this.closeStudio() } finally { this.keepWorn = false }
    if (!this.stage.worn || !this.hasStageNoteTarget) return
    this.stage.onWearPhoto = on => { if (!on) this.renderStageNote() }
    this.stageNoteTarget.textContent = "AI picture on the front. Turn it round to see our fit."
  }

  // The veil over the 3D view while the AI paints: the stage's loader, as a blurred, tinted cover with the
  // words in the middle. It owns the loader until hideVeil; the drape's own words wait their turn.
  showVeil(words) {
    if (!this.hasLoadingTarget) return
    this.veilWords = words
    const box = this.loadingTarget
    clearTimeout(this.loadingTimer)
    box.classList.add("stage-loading--ai")
    box.classList.remove("is-done", "stage-loading--veil", "is-checking")
    box.hidden = false
    // The bar slides on its own here (there's no progress to show), so the drape's width is let go of.
    this.loadingBarTarget.style.transform = ""
    if (this.loadingLabelTarget.textContent !== words) this.loadingLabelTarget.textContent = words
  }

  hideVeil() {
    if (!this.hasLoadingTarget || !this.veilWords) return
    this.veilWords = null
    const box = this.loadingTarget
    box.classList.add("is-done")
    clearTimeout(this.loadingTimer)
    this.loadingTimer = setTimeout(() => {
      if (!box.classList.contains("is-done")) return
      box.hidden = true
      box.classList.remove("stage-loading--ai")
    }, 400)
  }

  // While the veil or the studio panel is up, the controls and size rows under it can't be reached (or
  // tabbed to), and are dimmed; the panel's own bar is always the top layer.
  coverStage(on) {
    const stage = this.hasStageTarget ? this.stageTarget : this.canvasTarget.closest(".stage")
    if (!stage) return
    stage.classList.toggle("stage--covered", on)
    const under = [stage.querySelector(".stage-top"), this.hasLegendTarget ? this.legendTarget : null, this.hasStagePhotosTarget ? this.stagePhotosTarget : null]
    for (const element of under) {
      if (!element) continue
      if (on) element.setAttribute("inert", "")
      else element.removeAttribute("inert")
    }
  }

  // Back to the 3D view: the veil goes and everything is clickable again.
  uncoverStage() {
    this.hideVeil()
    this.coverStage(false)
  }

  // A short word over the 3D view, gone again after a few seconds (or when the next one comes).
  toast(words) {
    if (!this.hasStageToastTarget) return
    const box = this.stageToastTarget
    box.textContent = words
    box.hidden = false
    clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(() => { box.hidden = true }, 8000)
  }

  // The studio panel, over the same box as the 3D view, fading in. If the stage is partly off screen it is
  // brought into view first (no jump: the nearest edge, smoothly).
  openStudio() {
    const stage = this.hasStageTarget ? this.stageTarget : this.canvasTarget.closest(".stage")
    if (stage) {
      const r = stage.getBoundingClientRect()
      if (r.top < 0 || r.bottom > window.innerHeight) stage.scrollIntoView({ block: "nearest", behavior: "smooth" })
    }
    if (this.hasStageToastTarget) this.stageToastTarget.hidden = true
    this.coverStage(true)
    const panel = this.studioTarget
    if (!panel.hidden) return
    panel.hidden = false
    // Two frames in, so the fade starts from hidden rather than snapping.
    requestAnimationFrame(() => requestAnimationFrame(() => { if (!panel.hidden) panel.classList.add("is-shown") }))
  }

  // Clothes with a store photo just went on: wake the AI's GPU now (it takes about a minute to start), so
  // the AI picture is quick when asked for. The server sends at most one wake-up every 45 seconds.
  warmTryOn() {
    if (!this.hasWarmUrlValue) return
    fetch(this.warmUrlValue, { method: "POST", headers: { Accept: "application/json" } }).catch(() => {})
  }

  // When the studio program runs on this computer (see lib/local_studio.js), the photo is also finished
  // there, to look like a studio shot. It never leaves the device.
  async finishStudioLook(blob) {
    if (!(await localStudioReady())) return
    const token = this.studioToken = Symbol("look")
    const controller = this.studioAbort = new AbortController()
    try {
      const outfit = describeOutfit(this.items().filter(i => i.fit))
      const look = await studioLook(blob, outfit, {
        signal: controller.signal,
        onProgress: (_, words) => { if (token === this.studioToken && this.studioView !== "look") this.studioStatusTarget.textContent = words }
      })
      if (token !== this.studioToken) return
      this.studioImages.look = URL.createObjectURL(look)
      this.studioSwitchTarget.hidden = false
      this.studioSwitchTarget.querySelector('input[value="exact"]').parentElement.hidden = true
      this.studioLookOptionTarget.hidden = false
      this.studioLookOptionTarget.querySelector("input").checked = true
      this.offerCompare()
      this.showStudioImage("look")
    } catch (error) {
      if (token === this.studioToken && error.name !== "AbortError") this.studioStatusTarget.textContent = error.message
    }
  }

  // The studio look on Fitroom's photo service (see StudioLook), when the box is ticked: only the mannequin's
  // picture goes, with its depth and outline so the fit can't change, and nothing is kept. Its light and
  // cloth texture are then laid over this photo's own colours and prints.
  async cloudStudioLook({ image, depth, mask }) {
    const token = this.studioToken = Symbol("look")
    const controller = this.studioAbort = new AbortController()
    const began = Date.now()
    const tick = setInterval(() => {
      if (token !== this.studioToken || this.studioView === "look") return
      const seconds = Math.round((Date.now() - began) / 1000)
      this.studioStatusTarget.textContent = `Making the studio look… ${seconds}s (the first one can take a minute)`
    }, 1000)
    try {
      const [photo, depthUrl, maskUrl] = await Promise.all([image, depth, mask].map(blob => pngDataUrl(blob, 1280)))
      const outfit = describeOutfit(this.items().filter(i => i.fit))
      const answer = await fetch(this.lookUrlValue, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ photo, depth: depthUrl, mask: maskUrl, outfit }),
        signal: controller.signal
      })
      const reply = await answer.json()
      if (token !== this.studioToken) return
      if (!answer.ok) throw new Error(reply.message ?? "The studio look didn't work this time.")
      const painted = await (await fetch(reply.image)).blob()
      const look = await keepDetails(await createImageBitmap(image), await createImageBitmap(painted))
      if (token !== this.studioToken) return
      this.studioImages.look = URL.createObjectURL(look)
      this.studioSwitchTarget.hidden = false
      this.studioSwitchTarget.querySelector('input[value="exact"]').parentElement.hidden = true
      this.studioLookOptionTarget.hidden = false
      this.studioLookOptionTarget.querySelector("input").checked = true
      this.offerCompare()
      this.showStudioImage("look")
    } catch (error) {
      if (token === this.studioToken && error.name !== "AbortError") this.studioStatusTarget.textContent = error.message
    } finally {
      clearInterval(tick)
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
    if (variant === "compare") return this.showCompare()
    const url = this.studioImages?.[variant]
    if (!url) return
    this.studioView = variant
    this.studioFrameTarget.innerHTML = `<img src="${url}" alt="Studio photo of the outfit on the mannequin">`
    this.studioDownloadTarget.href = url
    this.studioDownloadTarget.hidden = false
    this.studioStatusTarget.textContent = variant === "exact"
      ? "The stores' own clothes painted on by AI. The fit is still the one we measured."
      : variant === "look"
        ? this.hasLookAiTarget && this.lookAiTarget.checked
          ? "Studio look by AI, from the mannequin's picture only. The fit is the one we measured; nothing was kept."
          : "Finished by the studio program on this computer. The fit is the one we measured; nothing left your device."
        : "Your photo, in the size you picked. Nothing was kept on the server."
  }

  // Compare: the store's photo, our fit and the AI's finish side by side, with what our checks said under
  // the AI's, and one tap to keep it or send it away. Nothing about that tap goes anywhere.

  offerCompare() {
    if (!this.hasStudioCompareOptionTarget) return
    this.studioCompareOptionTarget.hidden = false
  }

  // The AI picture being compared: the store photos painted on (exact) or the studio look.
  aiVariant() {
    return this.studioImages?.exact ? "exact" : this.studioImages?.look ? "look" : null
  }

  showCompare() {
    const ai = this.aiVariant()
    const items = this.items().filter(i => i.fit)
    const rows = items.length ? items : [{ kind: null, garment: {} }]
    this.studioView = "compare"
    this.studioDownloadTarget.hidden = true
    this.studioFrameTarget.innerHTML = `
      <div class="studio-compare" role="group" aria-label="Compare the pictures">
        ${rows.map(item => this.compareRow(item, ai)).join("")}
        <div class="studio-gate">
          <span class="mono">Does the AI picture look right?</span>
          <button type="button" class="button button--dark" data-action="fitting-room#acceptAi" ${ai ? "" : "disabled"}>Looks right</button>
          <button type="button" class="button button--dark" data-action="fitting-room#rejectAi" ${ai ? "" : "disabled"}>Not quite</button>
          <span class="mono studio-gate-note">Your answer stays on this device. Nothing is sent or saved.</span>
        </div>
      </div>`
    this.studioStatusTarget.textContent = ai
      ? "Store photo, our fit, and the AI's finish. The lines under the AI picture are our checks."
      : "The AI's picture didn't pass our checks, so only our fit is kept. The lines say which check failed."
  }

  compareRow(item, ai) {
    const photo = item.garment?.photo
    const checks = this.studioChecks?.[item.kind] ?? (ai === "look" ? { shape: { pass: true } } : null)
    const frame = (label, src, alt, extra = "") => `
      <figure class="studio-compare-frame">
        ${src ? `<img src="${src}" alt="${alt}">` : `<div class="studio-compare-empty mono">No picture</div>`}
        <figcaption class="mono">${label}</figcaption>${extra}
      </figure>`
    return `
      <div class="studio-compare-row">
        ${frame("Store photo", photo, "The store's photo of the item")}
        ${frame("Our fit", this.studioImages?.draped, "Our picture, in the size you picked")}
        ${frame("AI finish", ai ? this.studioImages[ai] : null, "The AI's picture", this.checkLines(checks))}
      </div>`
  }

  // The checks in plain words. Each line is one gate; a gate the service skipped says so.
  checkLines(checks) {
    if (!checks) return `<ul class="studio-checks"><li class="studio-check--none">Not checked</li></ul>`
    const line = (gate, yes, no, skipped) => {
      const c = checks[gate]
      if (!c || c.skipped) return `<li class="studio-check--none">${skipped}</li>`
      return `<li class="${c.pass ? "studio-check--ok" : "studio-check--off"}">${c.pass ? yes : no}</li>`
    }
    return `<ul class="studio-checks">
      ${line("shape", "Shape matches", "Shape is off", "Shape not checked")}
      ${line("identity", "Colour matches", "Colour is off", "Colour not checked")}
      ${line("print", "Print matches", "Print is off", "No print to check")}
    </ul>`
  }

  // "Looks right": the AI picture stays the saved one.
  acceptAi() {
    const ai = this.aiVariant()
    if (!ai) return
    const radio = this.studioSwitchTarget.querySelector(`input[value="${ai}"]`)
    if (radio) radio.checked = true
    this.showStudioImage(ai)
  }

  // "Not quite": the AI picture is dropped, here only, and the saved photo is our fit again.
  rejectAi() {
    for (const variant of ["exact", "look"]) {
      if (this.studioImages?.[variant]) URL.revokeObjectURL(this.studioImages[variant])
      delete this.studioImages[variant]
    }
    this.studioSwitchTarget.querySelector('input[value="exact"]').parentElement.hidden = true
    this.studioLookOptionTarget.hidden = true
    this.studioCompareOptionTarget.hidden = true
    this.studioSwitchTarget.querySelector('input[value="draped"]').checked = true
    this.showStudioImage("draped")
    this.studioStatusTarget.textContent = "Kept our fit. The AI picture is gone from this page; nothing was sent or saved."
  }

  showStudio(message) {
    this.openStudio()
    this.studioStatusTarget.textContent = message
  }

  // Close: the panel and the veil go, whatever was in flight is stopped, and the 3D view is back with
  // everything clickable.
  closeStudio() {
    this.studioToken = null
    this.studioAbort?.abort()
    this.studioAbort = null
    this.studioView = null
    for (const url of Object.values(this.studioImages ?? {})) URL.revokeObjectURL(url)
    this.studioImages = {}
    this.studioChecks = null
    this.uncoverStage()
    // The AI's picture on the 3D clothes stays only when the person asked to see it there (seeIn3D).
    if (!this.keepWorn) this.stage?.wearPhoto?.(null)
    if (this.hasSeeIn3dTarget) this.seeIn3dTarget.hidden = true
    if (!this.hasStudioTarget) return
    this.studioTarget.hidden = true
    this.studioTarget.classList.remove("is-shown")
    this.studioFrameTarget.innerHTML = ""
    this.studioDownloadTarget.hidden = true
    this.studioSwitchTarget.hidden = true
    this.studioSwitchTarget.querySelector('input[value="exact"]').parentElement.hidden = false
    this.studioSwitchTarget.querySelector('input[value="draped"]').checked = true
    this.studioLookOptionTarget.hidden = true
    if (this.hasStudioCompareOptionTarget) this.studioCompareOptionTarget.hidden = true
  }

  // Rendering

  render() {
    const items = this.items().filter(i => i.fit)
    this.stage.setOutfit(items.map(({ kind, garment, fit, selected }) => ({
      kind,
      size: garment.chart.sizes.find(s => s.name === selected),
      checks: fit.sizes.find(s => s.size === selected).checks,
      color: garment.color,
      print: garment.print ?? null,
      backPrint: garment.backPrint ?? null,
      sleevePrint: garment.sleevePrint ?? null,
      cuffTone: garment.cuffTone ?? null,
      photoSize: photoSize(garment.chart),
      photoMap: garment.photoMap ?? null,
      fabric: garment.fabric,
      style: garment.style,
      cut: garment.cut ?? null,
      zip: Boolean(garment.zip),
      sole: garment.sole ?? null,
      collar: garment.collar ?? null,
      // Shoes are shaped to their side photo's outline and wear the photo itself (see accessories.js).
      shoeSide: kind === "shoes" ? garment.shoeSide ?? null : null,
      shoePhoto: kind === "shoes" && garment.shoeSide ? garment.photo : null,
      shoeViews: kind === "shoes" && garment.shoeSide ? garment.shoeViews ?? null : null,
      onePiece: Boolean(garment.one_piece),
      bodysuit: Boolean(garment.bodysuit),
      puffer: Boolean(garment.puffer),
      buckle: garment.buckle ?? null
    })))
    // Nothing to sew (shoes alone, or the same outfit again): no loader, once any check of the top is done.
    this.queueLookCheck()
    if (this.stage.settled) this.showLoading(null)
    // A bodysuit is always tucked in: there's no choice to offer.
    this.tuckTarget.hidden = !this.stage.canTuck() || this.stage.onePiece || Boolean(this.outfit.top?.garment.bodysuit)

    this.renderStageNote()

    // What's guessed, and any number that looks unusual: a line each, in the tips' grey, the guess with a
    // link back to step 2.
    const shown = (this.warnings ?? []).filter(w => !this.guessed?.includes(w.part)).map(text => `<p class="tip">${escape(warningText(text))}</p>`)
    const guessed = this.guessed ?? []
    const step2 = words => `<button type="button" class="text-button" data-action="fitting-room#goToBody">${words}</button>`
    if (guessed.length === REQUIRED.length) shown.unshift(`<p class="tip">This is an example body. ${step2("Add your numbers in step 2")} to see the clothes on you.</p>`)
    else if (guessed.length) shown.unshift(`<p class="tip">We guessed your ${escape(listed(guessed.map(key => BODY_WORDS[key][0])))}. ${step2(`Add ${guessed.length === 1 ? "it" : "them"} in step 2`)} for a truer fit.</p>`)
    this.warningsTarget.hidden = !shown.length
    this.warningsTarget.innerHTML = shown.join("")
    this.showRailSizes(items)

    this.resultsTarget.innerHTML = items.map(({ kind, garment, fit, selected }) => {
      const result = fit.sizes.find(s => s.size === selected)
      const order = garment.chart.sizes.map(s => s.name)
      const sizes = [...fit.sizes].sort((a, b) => order.indexOf(a.size) - order.indexOf(b.size))
      const label = kindLabel(kind, garment)
      if (ACCESSORIES.includes(kind)) {
        return `
        <section class="result">
          <p class="result-kicker">${escape(label)} · ${escape(garment.name)}</p>
          ${sizeSlider({ kind, label, sizes, shown: selected, best: null })}
          <p class="verdict"><b>${escape(result.size)}.</b> Shown for the look. Fitroom doesn't check ${KIND_WORDS[kind]} sizes yet, so pick your usual size.</p>
        </section>`
      }
      const words = verdictWords(result, fit.best, this.unit)
      const better = result.size !== fit.best && result.verdict !== "fits"
        ? ` <button type="button" class="text-button" data-kind="${kind}" data-size="${escape(fit.best)}" data-action="fitting-room#pickSize">Try ${escape(fit.best)}</button>` : ""
      const checked = result.checks.filter(c => c.status !== "unknown")
      const unchecked = uncheckedLine(result.checks)
      return `
        <section class="result">
          <p class="result-kicker">${escape(label)} · ${escape(garment.name)} · ${FIT_NAMES[this.cut]} fit</p>
          ${sizeSlider({ kind, label, sizes, shown: selected, best: fit.sizes.length > 1 ? fit.best : null })}
          <p class="verdict"><b>${escape(words.lead)}</b> ${escape(words.rest)}${better}</p>
          <ul class="parts">${checked.map(check => partRow(check, this.unit)).join("")}</ul>
          ${unchecked ? `<p class="unchecked">${escape(unchecked)}</p>` : ""}
        </section>`
    }).join("")
    // A bar of more sizes than fit scrolls: the size shown is brought into view.
    for (const bar of this.resultsTarget.querySelectorAll(".sizer-bar")) {
      const on = bar.querySelector(".sizer-stop.is-on")
      if (on && bar.scrollWidth > bar.clientWidth) bar.scrollLeft = on.offsetLeft - (bar.clientWidth - on.offsetWidth) / 2
    }
  }

  // Dragging along a size bar picks the size under the pointer, as tapping it does.
  slideSize(event) {
    const bar = event.currentTarget
    const stops = [...bar.querySelectorAll(".sizer-stop")]
    if (!stops.length || event.button > 0 || event.pointerType === "touch") return
    // The segment under the pointer, or the nearest one past either end.
    const pick = clientX => {
      const rects = stops.map(stop => stop.getBoundingClientRect())
      const at = rects.findIndex(r => clientX >= r.left && clientX < r.right)
      const stop = stops[at >= 0 ? at : clientX < rects[0].left ? 0 : stops.length - 1]
      if (stop.getAttribute("aria-checked") !== "true") stop.click()
    }
    const move = e => pick(e.clientX)
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end) }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", end)
  }

  // The arrow keys step a size slider along, as a radio group does.
  keySize(event) {
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key]
    if (!step) return
    event.preventDefault()
    const stops = [...event.currentTarget.querySelectorAll(".sizer-stop")]
    const at = stops.findIndex(s => s.getAttribute("aria-checked") === "true")
    const next = stops[Math.max(0, Math.min(stops.length - 1, at + step))]
    if (!next || next === stops[at]) return
    const { kind, size } = next.dataset
    this.outfit[kind].selected = size
    this.render()
    this.resultsTarget.querySelector(`.sizer-bar[data-kind="${kind}"] .sizer-stop[data-size="${CSS.escape(size)}"]`)?.focus()
  }

  // Back to step 2, at the first number still to fill in.
  goToBody() {
    const empty = this.inputTargets.find(input => !input.closest("[hidden]") && !(parseFloat(input.value) > 0))
    const target = empty ?? this.element.querySelector("#step-body")
    target?.scrollIntoView({ behavior: "smooth", block: "center" })
    empty?.focus({ preventScroll: true })
  }

  // While the clothes are sewn, settle and move into a pose: a small pill over the figure saying which, with
  // how far along it is. It fades once they're on.
  showLoading(words) {
    if (!this.hasLoadingTarget) return
    // The AI's veil has the loader until the picture is in (or given up on); the drape's words wait.
    if (this.veilWords) return
    const box = this.loadingTarget
    // Once the clothes are on, the check against the shop's photo holds the veil until it passes.
    const checking = !words && Boolean(this.lookWords)
    if (checking) words = this.lookWords
    if (!words) {
      if (!box.hidden) box.classList.add("is-done")
      clearTimeout(this.loadingTimer)
      this.loadingTimer = setTimeout(() => { if (box.classList.contains("is-done")) box.hidden = true }, 400)
      return
    }
    clearTimeout(this.loadingTimer)
    box.classList.remove("is-done", "stage-loading--ai")
    // Nothing half-made shows: the figure is under the blurred veil while it's sewn and checked.
    box.classList.add("stage-loading--veil")
    box.classList.toggle("is-checking", checking)
    box.hidden = false
    if (this.loadingLabelTarget.textContent !== words) this.loadingLabelTarget.textContent = words
    if (!checking) this.loadingBarTarget.style.transform = `scaleX(${Math.max(0.04, this.stage.progress()).toFixed(3)})`
  }

  renderStageNote() {
    if (!this.hasStageNoteTarget || !this.items().some(i => i.fit)) return
    const notes = []
    if (this.guessed?.length) notes.push(this.guessed.length === REQUIRED.length ? "An example body." : "Some of your numbers are guesses.")
    if (this.stage.modelCoat && this.outfit.jacket) notes.push("The coat over a jacket is drawn from a jacket, so it looks shorter here.")
    // A chart of usual sizes, not the clothes' own measurements: the fit shown is an estimate.
    const estimated = this.items().filter(({ garment }) => ["body", "sizes"].includes(garment.chart.kind)).map(({ kind, garment }) => kindLabel(kind, garment).toLowerCase())
    if (estimated.length) notes.push(`Estimated fit: the store doesn't list measurements for the ${listed(estimated)}, so usual sizes are shown.`)
    if (this.stage.hiddenTop) notes.push("The top is under the jacket.")
    if (this.limited?.length) notes.push(`The mannequin can't go as far as your ${this.limited.join(" and ")}; it's drawn as near as it can.`)
    this.stageNoteTarget.textContent = notes.join(" ") || "Your shape. Drag to turn it."
  }

  showEmpty(kicker, text) {
    this.resultsTarget.innerHTML = `
      <div class="results-empty">
        <p class="result-kicker">${escape(kicker)}</p>
        <p class="verdict">${escape(text)}</p>
      </div>`
  }

  readMeasurements() {
    const values = Object.fromEntries(this.inputTargets.map(input => {
      const value = parseFloat(input.value)
      return [input.dataset.part, Number.isFinite(value) && value > 0 ? value : null]
    }))
    values.height = this.readHeight()
    return values
  }
}

// What to call an item: its kind, or a dress or a skirt for those (a dress is fitted as a top, a skirt as pants).
function kindLabel(kind, garment) {
  if (garment?.style === "dress") return "Dress"
  if (garment?.style === "skirt") return "Skirt"
  return KINDS[kind]
}

// A warning about a measurement that looks unusual, in plain words.
function warningText(warning) {
  const [name, how] = BODY_WORDS[warning.part] ?? [warning.part, ""]
  const way = /larger/.test(warning.message) ? "big" : "small"
  return `Your ${name} number looks very ${way}. Please measure it again. ${how}`
}

// "a", "a and b", "a, b and c".
function listed(words) {
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`
}

// How long a garment's front is for its width (length over half the chest), from the middle size of its chart.
function frontShape(chart) {
  const sizes = (chart?.sizes ?? []).filter(s => s.chest && s.length)
  if (!sizes.length) return null
  const size = sizes[Math.floor(sizes.length / 2)]
  return size.length / (size.chest / 2)
}

// The item's colour from a photo: the average of the middle of the picture, leaving out the near-white
// and near-grey background most product photos sit on.
async function clothColor(url) {
  const image = await loadImage(url)
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
// A picture as a PNG data: URL, at most `most` pixels across.
async function pngDataUrl(blob, most) {
  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(1, most / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement("canvas")
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL("image/png")
}

async function shrunkPhoto(src) {
  const image = new Image()
  image.src = src
  await loaded(image)
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

// The note on a garment read from its link's words, with what makes it truer: its sizes, or a photo until it
// has one.
function linkNote(kind, garment) {
  const photo = garment.photo ? "" : ` or <label class="text-button link-photo">a photo<input type="file" accept="image/*" data-kind="${kind}" data-action="change->fitting-room#addRowPhoto"></label>`
  return `<p class="rail-link-note">${escape(garment.link_note)} <button type="button" class="text-button" data-kind="${kind}" data-action="fitting-room#openSizes">Add its sizes</button>${photo} for a truer fit.</p>`
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function escape(text) {
  return String(text ?? "").replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)
}

// A photo's colour, kept true to a neutral the listing names: a white tee shot under cool light reads
// lavender, so a white, off-white, grey or black one keeps the photo's lightness and the named colour's tint.
// ("Heather" alone isn't one: a "Homestead Heather" tee is a heathered tan, as its photo shows.)
const NEUTRALS = /\b(white|off[- ]white|ivory|cream|ecru|black|grey|gray|charcoal|silver)\b/i
function asNamed(color, name, named) {
  if (!color || !NEUTRALS.test(name ?? "") || !/^#[0-9a-f]{6}$/i.test(named ?? "")) return color
  // Only a plain neutral ("Black", "Off White"), not one of two colours ("White / Brown": the brown's hue
  // laid on a cream photo is pink), and only toward a neutral.
  if (/\/|&|\band\b|multi/i.test(name)) return color
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  const [r, g, b] = rgb(color), [nr, ng, nb] = rgb(named)
  if (Math.max(nr, ng, nb) - Math.min(nr, ng, nb) > 30) return color
  const light = (r + g + b) / 3, namedLight = (nr + ng + nb) / 3
  return "#" + [nr, ng, nb].map(v => Math.round(Math.min(255, Math.max(0, v - namedLight + light))).toString(16).padStart(2, "0")).join("")
}

// What the page shows for shoes, socks or a belt: each of the shop's sizes, none checked against the body.
function accessoryFit(garment, selected) {
  const names = garment.chart.sizes.map(s => s.name)
  const best = names.includes(selected) ? selected : names[Math.floor((names.length - 1) / 2)]
  return { best, warnings: [], sizes: names.map(size => ({ size, verdict: "fits", penalty: 0, checks: [] })) }
}

// How far apart two "#rrggbb" colours are (0 to about 440).
// A photo's pixels, at most `most` across, as ImageData.
async function pixelsOf(src, most) {
  const image = await loadImage(src)
  const scale = Math.min(1, most / Math.max(image.naturalWidth, image.naturalHeight))
  const canvas = document.createElement("canvas")
  canvas.width = Math.round(image.naturalWidth * scale)
  canvas.height = Math.round(image.naturalHeight * scale)
  const context = canvas.getContext("2d", { willReadFrequently: true })
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return context.getImageData(0, 0, canvas.width, canvas.height)
}

// The colour the listing names, as a colour (the server's guess from its words), when it's a plain one the
// photo can be held to: black, white, grey, cream, navy. Null otherwise.
function namedColour(garment) {
  const name = garment.color_name ?? ""
  // One colour only: "Black / White", a two-tone, names a pattern's colours, not the cloth's.
  if (/\/|&|\band\b|\bmulti/i.test(name)) return null
  return garment.listingColor && /\b(black|white|off[- ]white|ivory|cream|ecru|grey|gray|charcoal|navy)\b/i.test(name) ? garment.listingColor : null
}


// A top whose 3D view didn't match its photo: kept on this device only (nothing about the person; the item's
// link, the try and what failed), so a pattern of misreadings can be found later. Best effort.
function rememberLookFailure(garment, attempt, result) {
  const entry = { at: new Date().toISOString(), item: garment.source_url ?? garment.name, attempt, failed: result.failed, checks: result.checks, back: result.back ?? null, looks: result.looks ?? null }
  console.info("[look]", entry)
  try {
    const log = JSON.parse(localStorage.getItem("fitroom.lookFailures") ?? "[]")
    log.push(entry)
    localStorage.setItem("fitroom.lookFailures", JSON.stringify(log.slice(-50)))
  } catch {}
}

function colorGap(a, b) {
  const rgb = hex => [1, 3, 5].map(i => parseInt(String(hex).slice(i, i + 2), 16) || 0)
  const [p, q] = [rgb(a), rgb(b)]
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
}

// What the fit engine needs to know about a garment besides its sizes: a dress's or a skirt's cut, a top's
// ({ fit, stretch }), and how a top is made (a women's, cropped, a baby tee, dropped shoulders). Undefined
// when there's nothing to say.
function fitDetails(garment) {
  const flags = Object.fromEntries(["women", "cropped", "snug", "dropped"].filter(key => garment[key]).map(key => [key, true]))
  if (!garment.cut && !Object.keys(flags).length) return undefined
  return { ...(garment.cut ?? {}), ...flags }
}

// The size a shop photographs (its sample): the middle of its chart. Its chest and length (cm) say how big
// the photo's print is on the cloth, so a print isn't stretched or shrunk with the size picked.
function photoSize(chart) {
  const sizes = (chart?.sizes ?? []).filter(s => s.chest > 0 && s.length > 0)
  if (!sizes.length) return null
  const middle = sizes[Math.floor((sizes.length - 1) / 2)]
  return { chest: middle.chest, length: middle.length }
}

// Many shops run on Shopify, which answers a product's details as small public JSON. Some big ones (Kith)
// answer a browser at once but make an app wait, so this browser reads them and hands them to Fitroom: the
// product, its shop's Shopify name, and its Kiwi Sizing chart when it has one. Null for other links, or when
// the shop doesn't answer quickly; Fitroom then reads the link itself.
async function readShop(link) {
  let url
  try { url = new URL(link) } catch { return null }
  const handle = url.pathname.match(/\/products\/([a-z0-9][a-z0-9_-]*)/i)?.[1]
  if (!handle || url.protocol !== "https:") return null
  const json = async (address, ms = 6000) => {
    try {
      const response = await fetch(address, { signal: AbortSignal.timeout(ms), credentials: "omit", headers: { Accept: "application/json" } })
      return response.ok ? await response.json() : null
    } catch { return null }
  }
  const [answer, meta] = await Promise.all([json(`${url.origin}/products/${handle}.json`), json(`${url.origin}/meta.json`)])
  const product = answer?.product, shop = meta?.myshopify_domain
  if (!product?.title || !/\.myshopify\.com$/.test(shop ?? "")) return null
  const query = new URLSearchParams({ shop, product: String(product.id), title: product.title, tags: [product.tags].flat().join(","),
    type: product.product_type ?? "", vendor: product.vendor ?? "" })
  const sizing = await json(`https://app.kiwisizing.com/api/getSizingChart?${query}`)
  const { id, handle: name, title, vendor, product_type, tags, body_html, images, options } = product
  const variants = (product.variants ?? []).slice(0, 40).map(v => ({ title: v.title }))
  let photo = await readShopPhoto(images?.[0]?.src)
  // A shoe's photos: one from the side (the first, or else the first that is), and any square on from
  // above, behind or in front, for the 3D shoe (see print.js's shoeView).
  let shoeViews = null
  if (photo && SHOE_WORDS.test(`${product_type} ${title}`)) ({ photo, views: shoeViews } = await readShoePhotos(images, photo))
  // The photo's shape (how high its arms are sewn in, how far its sleeves reach), which says how a top is
  // cut when the shop gives no chart.
  const shape = photo ? await readTopShape(photo).catch(() => null) : null
  const bottomShape = photo ? await readBottomShape(photo).catch(() => null) : null
  // A dress's shape (its waist, where it widens, its hem, neckline and straps), which the import cuts it to.
  const words = `${product_type} ${title} ${tags}`
  const dressShape = photo && DRESS_WORDS.test(words) && !/\bskirts?\b|\bskort/i.test(`${product_type} ${title}`) ? await readDressShape(photo).catch(() => null) : null
  const backPhoto = photo ? await readBackPhoto(images, { shape, bottomShape }) : null
  return { product: { id, handle: name, title, vendor, product_type, tags, body_html, images: (images ?? []).slice(0, 1), options, variants }, shop, sizing,
    photo, back_photo: backPhoto, shape, bottom_shape: bottomShape, dress_shape: dressShape, shoeViews }
}

const SHOE_WORDS = /sneakers?|\bshoes?\b|\bboots?\b|footwear|loafers?|sandals?|slides?\b|mules?\b|clogs?|trainers?|derby|oxfords?\b|runners?|low top|high top/i
// A listing that's a dress (a gown, a slip, a mini): its photo's shape is read for it.
const DRESS_WORDS = /\bdress(?:es)?\b(?!\s*(?:shirt|pants|trousers|shoe))|\bgowns?\b|\bsundress|shirtdress|slip dress|\bmaxi\b|\bmidi\b/i

async function readShoePhotos(images, first) {
  const rest = (images ?? []).slice(1, 8)
  let photo = first, side = (await readShoe(first).catch(() => null))?.side
  const others = []
  for (const image of rest) {
    const other = await readShopPhoto(image.src, 1000)
    if (!other) continue
    if (!side) {
      const read = (await readShoe(other).catch(() => null))?.side
      if (read) { photo = other; side = read; continue }
    }
    others.push(other)
  }
  if (!side) return { photo: first, views: null }
  const views = []
  for (const other of others) {
    const view = await readShoeView(other, side).catch(() => null)
    if (view && !views.some(v => v.kind === view.kind)) views.push(view)
  }
  return { photo, views }
}

// The shop's photo of the back, when it has one: the photo named for the back, or else the second photo
// when it shows a garment the same shape as the first (shops often show the back next; a close-up of a
// pocket or a photo on a model isn't that shape).
async function readBackPhoto(images, { shape, bottomShape }) {
  const rest = (images ?? []).slice(1, 6)
  const named = rest.find(image => /back/i.test(String(image.src).split("/").pop().split("?")[0]))
  if (named) return readShopPhoto(named.src)
  const near = (a, b) => a && b && Math.abs(a / b - 1) < 0.15
  // The first of the other photos that's the garment laid out or hung as the front is (standing clear of the
  // frame's edges: not on a model, cut off by the frame, nor a close-up of its cloth or a pocket), and its
  // shape. Kith's jeans: a model shot, then the back on the hanger, then close-ups.
  for (const image of rest) {
    const small = await readShopPhoto(image.src, 400)
    const traits = small ? await readPhotoTraits(small).catch(() => null) : null
    if (!traits?.garment || traits.touches > 0) continue
    const photo = await readShopPhoto(image.src)
    if (!photo) continue
    // Either reading matching is enough: a top is read as trousers too (a hoodie's body and hood as legs and
    // a waist), and that reading moves a lot with a hood up or down.
    if (shape) {
      const other = await readTopShape(photo).catch(() => null)
      if (other && near(other.length, shape.length) && near(other.waist, shape.waist)) return photo
    }
    if (bottomShape) {
      const other = await readBottomShape(photo).catch(() => null)
      if (other && near(other.length, bottomShape.length) && near(other.hips, bottomShape.hips)) return photo
    }
  }
  return null
}

// The product's photo, small, as a data: URL (Shopify's image host lets pages read its photos).
async function readShopPhoto(src, width = 1600) {
  if (!src) return null
  try {
    const url = new URL(src.startsWith("//") ? `https:${src}` : src)
    url.searchParams.set("width", String(width))
    const response = await fetch(url, { signal: AbortSignal.timeout(6000), credentials: "omit" })
    const blob = await response.blob()
    if (!response.ok || !/^image\/(jpeg|png|webp)$/.test(blob.type) || blob.size > 2_500_000) return null
    return await new Promise(resolve => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch { return null }
}

// A photo the person picked, made small enough to keep and read quickly, as a data: URL.
async function smallPhoto(file) {
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await loaded(image)
    const scale = Math.min(1, 900 / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement("canvas")
    canvas.width = Math.round(image.naturalWidth * scale)
    canvas.height = Math.round(image.naturalHeight * scale)
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL("image/jpeg", 0.88)
  } finally {
    URL.revokeObjectURL(url)
  }
}
