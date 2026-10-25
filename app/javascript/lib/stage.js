import * as THREE from "three"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { RGBELoader } from "three/addons/loaders/RGBELoader.js"
import { OrbitControls } from "three/addons/controls/OrbitControls.js"
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js"
import { OutputPass } from "three/addons/postprocessing/OutputPass.js"
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js"
import { N8AOPass } from "n8ao"
import { drawnSize, fitBody, fitJacket, fitTrousers } from "lib/body_fit"
import { DrapedTop, TUCKABLE, bodySnapshot, coveredPoints, garmentWeights, prepareBody, skinPoints, vertexNormals } from "lib/garments/dress"
import { bodyFrame } from "lib/garments/body"
import { accessoryMaterial, beltGeometry, buckleGeometry, outlineOf, photoShoeGeometry, shoeGeometry, sockGeometry, strapGeometry, wrapShoePhoto } from "lib/garments/accessories"
import { shoeTexture } from "lib/garments/print"

// The 3D fitting room, styled as a product shot: a white display mannequin in your shape (built by
// script/mannequin/build.py) wearing an outfit (a top, a jacket, a coat, trousers) in the chosen sizes, in
// soft studio light on a pale seamless backdrop. Tops and casual jackets are cut from sewing patterns and
// draped with cloth simulation (lib/garments); the suit's jacket, coats and trousers are shaped from the
// model. Three views: on the mannequin, the clothes alone ("ghost"), and the fit map; and a few poses. Drag
// to turn it.
const MODELS = "/models"
const MANNEQUIN_WHITE = "#f4f2ee"
// The studio: graphite, lit from above the figure, like the page round it.
// The neck, in the body's own (rest pose) space: cut level at this height, and the egg's neck piece reaching
// a little below the cut, about as round as the neck there.
// The pose garments are sewn in: the rig's rest pose (arms out, as garment tools do it) with the legs brought
// together, so a long garment fits round them (in the rest pose they stand so far apart that a straight dress
// can't go round the knees, and rides up).
const SEWING_POSE = [["thigh_l", "z", -0.16], ["thigh_r", "z", 0.16]]
const NECK = { cut: 1.5, bottom: 1.484, centreZ: 0.032, radii: [0.066, 0.057] }
const BACKDROP = ["#2b2f36", "#1a1c21", "#0f1013"]
const WOOL_REPEAT = 46     // how many times the wool grain tiles across the suit's texture

// How each kind of cloth catches light: roughness, sheen, how much the weave shows, and (leather) a coat;
// and the colour of its stitching and hardware ("tone" means the cloth's own colour, a shade lighter).
const FABRICS = {
  wool: { roughness: 0.92, sheen: 0.35, weave: 0.35, clearcoat: 0, thread: "tone", metal: "#2b2724" },
  cotton: { roughness: 0.88, sheen: 0.2, weave: 0.5, clearcoat: 0, thread: "tone", metal: "#3a3a3a" },
  denim: { roughness: 0.95, sheen: 0.1, weave: 0.8, clearcoat: 0, thread: "#c58b45", metal: "#8c6a3c" },
  leather: { roughness: 0.55, sheen: 0, weave: 0.05, clearcoat: 0.15, thread: "tone", metal: "#8d8f93" },
  nylon: { roughness: 0.4, sheen: 0.15, weave: 0.05, clearcoat: 0.15, thread: "tone", metal: "#8d8f93" }
}
// Jacket styles: "tailored" is the suit's jacket, shaped from the model; the casual ones are cut from a
// pattern and draped like tops (lib/garments).
export const STYLES = ["tailored", "zip", "bomber", "shirt"]
// Tops, and casual jackets, cut from a sewing pattern and draped on the mannequin with cloth simulation.
// The idle turn: how fast (OrbitControls' units: 2 is a turn in 30 s at 60 fps; this is about 75 s) and how
// long after the last touch (ms) it starts.
// The graphite stage's light from behind (see addLights).
const RIM = { color: 0xdde6ff, intensity: 0.4, position: [-1.4, 2.6, -2.6] }
const IDLE_TURN = { speed: 0.8, after: 8000 }

// Contact shading's reach (metres; about a hand's width) and strength.
const AO = { radius: 0.22, falloff: 1, intensity: 3.2 }

export const DRAPED_STYLES = ["tee", "longsleeve", "sweatshirt", "hoodie", "zip", "bomber", "shirt", "shortshirt", "dress", "polo", "tank", "sweater", "shortknit", "cardigan", "coat"]

export const STATUS_COLORS = {
  good: "#3fa672", tight: "#de4f37", short: "#de4f37", loose: "#4f63f0", long: "#4f63f0", unknown: "#9a9ca3"
}
// Which ease shape key shows each part of the fit, for colouring the fit map.
const REGIONS = {
  jacket: { "ease-chest": "chest", "ease-waist": "waist", "ease-shoulders": "shoulders", "ease-sleeve": "sleeve", "ease-length": "length" },
  trousers: { "ease-trousers-waist": "waist", "ease-seat": "seat", "ease-inseam": "inseam", "ease-leg-opening": "leg_opening" }
}
const EASE_KEYS = {
  jacket: Object.keys(REGIONS.jacket),
  trousers: ["ease-trousers-waist", "ease-seat", "ease-thigh", "ease-inseam", "ease-leg-opening"]
}

// Poses live in public/models/poses.json, shared with the studio renderer so a photo matches the screen.

// The draped layers, from the skin out, and which each is sewn over: the pants, the top over them and a
// casual jacket over both. A tucked top is gathered close round the body under the pants' waistband, so the
// top and the pants are each sewn on the body alone, and the jacket over both.
const LAYERS = ["bottom", "top", "outer"]
const OVER = { bottom: [], top: ["bottom"], outer: ["bottom", "top"] }
const TUCKED_LAYERS = ["top", "bottom", "outer"]
const TUCKED_OVER = { top: [], bottom: [], outer: ["top", "bottom"] }

export class FittingStage {
  constructor(canvas) {
    this.canvas = canvas
    this.view = "mannequin"
    this.pose = "standing"
    this.outfit = []
    this.lastEase = {}
    // What's draped, in layers: the pants ("bottom"), over them the top ("top"), and over that a casual
    // jacket ("outer"); and what's on screen while a new one is sewn (see removeDraped). Each layer waits for
    // the ones under it to be sewn, then is sewn over them (this.waiting: the specs waiting, by layer).
    this.slots = { bottom: null, top: null, outer: null }
    this.leaving = { bottom: null, top: null, outer: null }
    this.waiting = {}
    this.order = LAYERS
    this.tucked = false     // whether a top is worn tucked into the pants (when it can be)
    this.drapeBudget = 20   // milliseconds of draping per frame
    // Shoes and socks (on the calves' bones, so they follow the pose) and a belt (round the pants' waistband).
    this.feet = { key: null, meshes: [], shoes: {} }
    this.belt = { stamp: null, mesh: null, buckle: null }
    this.scarf = { stamp: null, mesh: null }
    this.collars = { stamp: null, meshes: [] }

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.toneMapping = THREE.NeutralToneMapping
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap

    this.scene = new THREE.Scene()
    this.addLights()

    this.camera = new THREE.PerspectiveCamera(22, 1, 0.05, 50)
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.enablePan = false
    this.controls.enableZoom = false   // the page scrolls over it; zooming isn't needed to judge fit
    this.controls.minPolarAngle = 1.2
    this.controls.maxPolarAngle = 1.75
    this.idleTurn()
    this.effects = this.addEffects()
    this.scene.background = backdrop(this.backdropTone(1))

    this.resize()
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(canvas.parentElement)
    this.resizeObserver.observe(canvas)
    this.visible = true
    this.intersectionObserver = new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting
      if (this.visible) this.start()
    })
    this.intersectionObserver.observe(canvas)

    this.ready = this.load()
    this.start()
  }

  async load() {
    const [gltf, calibration, poses, studio, women] = await Promise.all([
      new GLTFLoader().loadAsync(`${MODELS}/mannequin.glb`),
      fetch(`${MODELS}/mannequin.json`).then(r => r.json()),
      fetch(`${MODELS}/poses.json`).then(r => r.json()),
      new RGBELoader().loadAsync(`${MODELS}/studio.hdr`),
      fetch(`${MODELS}/women.bin`).then(r => (r.ok ? r.arrayBuffer() : null)).catch(() => null)
    ])
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromEquirectangular(studio).texture
    this.scene.environmentIntensity = 0.85
    studio.dispose()
    pmrem.dispose()

    this.calibration = calibration
    this.bodyCalibration = calibration
    this.poses = poses
    this.model = gltf.scene
    this.meshes = {}
    this.model.traverse(object => {
      if (object.isMesh) {
        this.meshes[object.name] = object
        object.castShadow = true
        object.receiveShadow = true
        object.frustumCulled = false   // morphs and skinning move it beyond its stored bounds
      }
    })
    // The women's body: a shape key on the body (see mannequin.json's "women").
    this.hasWomen = Boolean(women && calibration.women) && addShapeKey(this.meshes.body, "women", new Float32Array(women))
    // The model's casual jacket isn't used: casual jackets are draped (see dressDraped).
    if (this.meshes.casual) this.meshes.casual.visible = false
    // A coat is the jacket again, on its own copy of the geometry (it gets its own fit-map colours),
    // drawn a little bigger so it always sits outside the jacket.
    const coat = this.meshes.jacket.clone()
    coat.geometry = this.meshes.jacket.geometry.clone()
    coat.name = "coat"
    this.meshes.jacket.parent.add(coat)
    this.meshes.coat = coat

    this.rest = new Map()
    this.model.traverse(object => { if (object.isBone) this.rest.set(object, object.quaternion.clone()) })

    await this.dress(calibration.textures)
    this.addEggHead(calibration.head)
    if (this.tone) this.setTone(this.tone)
    if (this.bodyType) this.setBodyType(this.bodyType)
    this.scene.add(this.model)
    this.applyPose()
    this.frame()
    this.redraw()
    if (this.pendingBody) this.setBody(this.pendingBody)
  }

  // body: measurements in cm. Shapes the mannequin and everything it wears.
  // Returns the measurements the model couldn't reach, if any.
  setBody(body) {
    if (!this.model) { this.pendingBody = body; return [] }
    this.measures = body
    this.fitted = fitBody(this.bodyCalibration, body)
    this.fitted.influences.women = this.bodyType === "women" && this.hasWomen ? 1 : 0
    this.model.scale.setScalar(this.fitted.scale)
    for (const mesh of Object.values(this.meshes)) applyInfluences(mesh, this.fitted.influences)
    this.redraw()
    return this.fitted.limited
  }

  // "men" or "women": which body the mannequin has. Its measurements then start from that body's.
  setBodyType(type) {
    this.bodyType = type
    if (!this.model) return
    const women = type === "women" && this.hasWomen
    this.bodyCalibration = women ? { ...this.calibration, body: this.calibration.women.body } : this.calibration
    // That body's neck piece, and the women's mannequin's smaller head.
    if (this.eggNeck) {
      this.eggNeck.geometry = this.necks[women ? "women" : "men"]
      this.egg.scale.copy(this.eggScale).multiplyScalar(women ? this.calibration.women.head ?? 1 : 1)
    }
    // Clothes draped on the other body don't fit this one: take them off now, rather than leave them on
    // until the new drape is ready.
    for (const slot of LAYERS) if (this.slots[slot] && this.slots[slot].bodyType !== type) this.removeDraped(slot)
    this.waiting = {}
    this.applyPose()
    if (this.measures) this.setBody(this.measures)
  }

  // items: [{ kind: "top" | "jacket" | "coat" | "trousers", size (cm), checks (the API's), color, fabric, style }]
  setOutfit(items) {
    this.outfit = items
    this.redraw()
  }

  // Whether the top is tucked into the pants or skirt. Only some tops tuck in (see canTuck).
  setTucked(on) {
    this.tucked = Boolean(on)
    this.redraw()
  }

  // Whether what's worn can be tucked in: a top (a tee, polo, tank or shirt) over pants or a skirt.
  canTuck(items = this.outfit) {
    const worn = Object.fromEntries(items.map(item => [item.kind, item]))
    const tailored = worn.jacket && !DRAPED_STYLES.includes(worn.jacket.style)
    return Boolean(worn.top && worn.trousers && TUCKABLE.includes(worn.top.style) && !tailored && !(worn.coat && worn.jacket))
  }

  // "mannequin", "ghost" (the clothes alone) or "fit" (the fit map, on the mannequin).
  setView(view) {
    this.view = view
    this.redraw()
  }

  // The mannequin's shade: white fibreglass, or a skin tone (a colour).
  setTone(color) {
    this.tone = color
    if (!this.meshes) return
    const white = color.toLowerCase() === MANNEQUIN_WHITE
    for (const material of [this.meshes.body.material, this.meshes.body.material.userData.plain]) {
      material.color.set(color)
      // The white form is matte ceramic; skin is soft, with a little sheen.
      material.clearcoat = white ? 0 : 0.05
      material.roughness = white ? 0.86 : 0.62
      material.sheen = white ? 0 : 0.25
      material.sheenColor.set(color).offsetHSL(0, 0, 0.15)
    }
  }

  setPose(name) {
    this.pose = name
    this.applyPose()
    // A draped garment follows by settling again in the new pose (see tick).
    for (const d of Object.values(this.slots)) if (d) d.posedAs = null
    this.start()
  }

  redraw() {
    if (!this.meshes || !this.fitted) return
    const worn = Object.fromEntries(this.outfit.map(item => [item.kind, item]))

    // A casual jacket is draped like a top, and so is a coat (cut long, its sleeves round the arms), over
    // the top and the pants; the suit's jacket is drawn from the model, and so is a coat worn over a jacket.
    const drapedJacket = Boolean(worn.jacket && DRAPED_STYLES.includes(worn.jacket.style))
    const tailored = Boolean(worn.jacket && !drapedJacket)
    const drapedCoat = Boolean(worn.coat && !worn.jacket)
    const modelCoat = Boolean(worn.coat && !drapedCoat)
    const body = this.meshes.body
    body.visible = this.view !== "ghost"
    body.material.userData.hideJacket.value = tailored || modelCoat ? 1 : 0
    body.material.userData.hideCasual.value = 0
    // Pants are draped, so the body under them stays (the cloth lies on it).
    body.material.userData.hideTrousers.value = 0

    let under = null
    if (tailored) {
      const ease = fitJacket(this.calibration, this.fitted, worn.jacket.size, { layer: "jacket" })
      this.dressMesh("jacket", worn.jacket, ease, "jacket")
      under = drawnSize(this.calibration, this.fitted, ease, "jacket")
    }
    if (modelCoat) {
      const ease = fitJacket(this.calibration, this.fitted, worn.coat.size, { over: under })
      // A coat drawn from a jacket can only stretch so far; the verdict gives its real length.
      ease["ease-length"] = Math.min(ease["ease-length"], 30)
      // The sleeves have no width of their own to grow, so over a jacket the whole coat stands a little
      // further out, or the jacket would show through it.
      const inflate = worn.jacket ? 0.014 : 0.003
      this.materials.coat.cloth.userData.inflate.value = inflate
      this.materials.coat.fitMap.userData.inflate.value = inflate
      this.dressMesh("coat", worn.coat, ease)
    }
    // The model's trousers are only measured now, for a studio photo (which draws them); on screen they're draped.
    if (worn.trousers) this.lastEase.trousers = fitTrousers(this.calibration, this.fitted, worn.trousers.size)
    this.meshes.jacket.visible = tailored
    this.meshes.coat.visible = modelCoat
    this.meshes.trousers.visible = false

    // The top, unless the suit's jacket or a coat is over it (those are drawn from the model, and would show
    // it through them), over the pants or tucked into them; and over the top, a casual jacket.
    const top = worn.top && !tailored && !modelCoat ? worn.top : null
    this.hiddenTop = Boolean(worn.top && !top)
    // A romper's or jumpsuit's top hangs over its shorts or pants, in the same cloth, so they read as one
    // piece (it isn't tucked: there's nothing to tuck).
    this.onePiece = Boolean(worn.top?.onePiece && worn.trousers?.onePiece)
    const tuck = this.tucked && !this.onePiece && this.canTuck()
    this.order = tuck ? TUCKED_LAYERS : LAYERS
    const items = {
      bottom: worn.trousers ?? null,
      top: top && tuck ? { ...top, tuck: { style: worn.trousers.style ?? "trousers", size: worn.trousers.size, cut: worn.trousers.cut ?? null } } : top,
      outer: drapedJacket ? worn.jacket : drapedCoat ? { ...worn.coat, style: "coat" } : null
    }
    this.dressFeet(worn.shoes ?? null, worn.socks ?? null)
    this.beltItem = worn.belt ?? null
    for (const slot of this.order) this.dressDraped(slot, items[slot])
  }

  // Shoes and socks, lofted round the mannequin's feet and legs as they stand (see accessories.js), then hung
  // on the calves' bones so they move with the legs. Rebuilt when the body or what's worn changes.
  dressFeet(shoes, socks) {
    const key = JSON.stringify([shoes && [shoes.style, shoes.color, shoes.sole, shoes.fabric, shoes.shoeSide], socks && [socks.style, socks.color],
      this.fitted.scale, this.fitted.influences, this.bodyType])
    if (key === this.feet.key) return
    this.feet.key = key
    for (const mesh of this.feet.meshes) {
      mesh.parent?.remove(mesh)
      mesh.geometry.dispose()
      for (const m of [mesh.material].flat()) m.dispose()
    }
    this.feet.meshes = []
    this.feet.shoes = {}
    if (!shoes && !socks) return
    // Built on the mannequin as it stands, whatever the pose shown.
    const pose = this.pose
    this.pose = "standing"
    this.applyPose()
    const body = bodySnapshot(this.meshes.body)
    const frame = bodyFrame(body)
    const hang = (mesh, side) => {
      mesh.castShadow = mesh.receiveShadow = true
      mesh.frustumCulled = false
      const bone = this.model.getObjectByName(`calf_${side.toLowerCase()}`) ?? this.model
      bone.attach(mesh)
      this.feet.meshes.push(mesh)
      return mesh
    }
    for (const side of ["L", "R"]) {
      if (socks) hang(new THREE.Mesh(sockGeometry(body, frame, side, socks.style), accessoryMaterial("knit", socks.color)), side)
      if (shoes) {
        const boot = shoes.style === "boot"
        // A lace-up boot's leather is nearly always matte (nubuck, oiled or suede), not a shoe's polish.
        const upper = accessoryMaterial(boot && shoes.fabric === "leather" ? "suede" : shoes.fabric === "leather" || shoes.fabric === "suede" ? shoes.fabric : "canvas", shoes.color)
        // A loafer's sole is leather; others are rubber (a boot's lug sole too).
        const sole = accessoryMaterial(shoes.style === "loafer" ? "leather" : "rubber", shoes.sole ?? (shoes.style === "sneaker" || shoes.style === "hightop" ? "#ecebe6" : "#2a2522"))
        const laces = accessoryMaterial("canvas", shoes.laces ?? (boot ? `#${new THREE.Color(shoes.color).offsetHSL(0, -0.15, -0.16).getHexString()}` : shoes.color))
        // A boot's padded collar, in a darker leather unless the photo shows its own colour.
        const collar = accessoryMaterial("leather", shoes.collar ?? `#${new THREE.Color(shoes.color).offsetHSL(0, -0.25, -0.3).getHexString()}`)
        if (boot) { sole.roughness = 0.9; sole.clearcoat = 0 }
        collar.clearcoat = 0.1
        collar.roughness = 0.6
        const eyelets = accessoryMaterial("metal", "#8c8270")
        // Built from the shop's side photo when there's one (see accessories.js), else from the style alone.
        const geometry = (shoes.shoeSide && photoShoeGeometry(body, frame, side, shoes.shoeSide, shoes.style)) || shoeGeometry(body, frame, side, shoes.style)
        this.feet.shoes[side] = hang(new THREE.Mesh(geometry, [sole, upper, laces, collar, eyelets]), side)
        if (shoes.style === "sandal") hang(new THREE.Mesh(strapGeometry(body, frame, side), upper.clone()), side)
      }
    }
    this.pose = pose
    this.applyPose()
    if (shoes?.shoePhoto && shoes.shoeSide) this.wearShoePhoto(shoes, key)
  }

  // The shop's side photo on the shoes, once it's read: the logo, stitching and sole as photographed, where
  // the shoe faces the side; elsewhere (the toe's top, the laces, the heel) the photo's own colours there,
  // blurred, as the side photo can't show them (see accessories.js#wrapShoePhoto). The laces and eyelets
  // stay 3D, in the laces' colour from the photo. The shoe keeps its finish (matte suede, glossy leather).
  async wearShoePhoto(shoes, key) {
    const read = await shoeTexture(shoes.shoePhoto).catch(() => null)
    if (!read || this.feet.key !== key) return
    const texture = new THREE.CanvasTexture(read.canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = 8
    // A blurred copy of the photo, read on the CPU for each point's plain colour.
    const size = 96, blur = document.createElement("canvas")
    blur.width = blur.height = size
    const bc = blur.getContext("2d", { willReadFrequently: true })
    bc.filter = "blur(3px)"
    bc.drawImage(read.canvas, 0, 0, size, size)
    const pixels = bc.getImageData(0, 0, size, size).data
    const colour = new THREE.Color()
    const sample = (u, v, out, at) => {
      const x = Math.min(size - 1, Math.max(0, Math.round(u * (size - 1)))), y = Math.min(size - 1, Math.max(0, Math.round((1 - v) * (size - 1))))
      const i = 4 * (y * size + x)
      colour.setRGB(pixels[i] / 255, pixels[i + 1] / 255, pixels[i + 2] / 255, THREE.SRGBColorSpace)
      out[at] = colour.r; out[at + 1] = colour.g; out[at + 2] = colour.b
    }
    for (const mesh of Object.values(this.feet.shoes)) {
      const geometry = wrapShoePhoto(mesh.geometry, shoes.shoeSide)
      const plainUV = geometry.attributes.uvPlain.array, uv = geometry.attributes.uv.array, n = geometry.attributes.position.count
      const plain = new Float32Array(3 * n)
      for (let i = 0; i < n; i++) sample(plainUV[2 * i], plainUV[2 * i + 1], plain, 3 * i)
      geometry.setAttribute("aPlain", new THREE.BufferAttribute(plain, 3))
      const [sole, upper, laces, collar] = mesh.material
      for (const m of [sole, upper, collar]) {
        m.map = texture
        m.color.set(0xffffff)
        if (m.sheen) m.sheenColor.set(0x5a5a5a)
        m.onBeforeCompile = shader => {
          shader.vertexShader = shader.vertexShader
            .replace("#include <common>", "#include <common>\nattribute vec3 aPlain;\nattribute float aPhoto;\nvarying vec3 vPlain;\nvarying float vPhoto;")
            .replace("#include <begin_vertex>", "#include <begin_vertex>\nvPlain = aPlain;\nvPhoto = aPhoto;")
          shader.fragmentShader = shader.fragmentShader
            .replace("#include <common>", "#include <common>\nvarying vec3 vPlain;\nvarying float vPhoto;")
            .replace("#include <map_fragment>", "#include <map_fragment>\ndiffuseColor.rgb = mix(vPlain, diffuseColor.rgb, vPhoto);")
        }
        m.customProgramCacheKey = () => "shoe-photo"
        m.needsUpdate = true
      }
      // The laces: the photo's colour where they are in it (the front of the shaft, side on).
      const index = geometry.index.array, group = geometry.groups.find(g => g.materialIndex === 2)
      if (group) {
        const sum = [0, 0, 0], seen = new Set(), one = [0, 0, 0]
        for (let k = group.start; k < group.start + group.count; k++) {
          const i = index[k]
          if (seen.has(i)) continue
          seen.add(i)
          sample(uv[2 * i], uv[2 * i + 1], one, 0)
          for (let c = 0; c < 3; c++) sum[c] += one[c]
        }
        if (seen.size) laces.color.setRGB(...sum.map(v => v / seen.size))
      }
    }
    this.feet.texture?.dispose()
    this.feet.texture = texture
  }

  // Each shoe's outline as it stands now, for pants' hems to stay off (in place of the bare feet's).
  shoeOutlines(floor) {
    const outlines = {}
    for (const side of ["L", "R"]) {
      const mesh = this.feet.shoes[side]
      if (!mesh) return null
      mesh.updateWorldMatrix(true, false)
      const a = mesh.geometry.attributes.position, v = new THREE.Vector3(), points = []
      for (let i = 0; i < a.count; i++) { v.fromBufferAttribute(a, i).applyMatrix4(mesh.matrixWorld); points.push([v.x, v.y, v.z]) }
      outlines[side] = outlineOf(points, floor)
    }
    return outlines
  }

  // The body as cloth sees it (see prepareBody), standing in shoes when they're worn.
  prepare(snapshot, options) {
    const prepared = prepareBody(snapshot.body, snapshot.egg, snapshot.over, options)
    const shoes = this.shoeOutlines(prepared.frame.floor)
    if (shoes && prepared.frame.feet) prepared.frame.feet = shoes
    return prepared
  }

  // A dress's attached scarf, once the dress is draped: a long tail hanging from its side at the waist, or
  // a band round the neck with its two ends hanging down the front. Laid on the dress where it hangs (found
  // by looking along each height for the dress's surface), in the dress's colour.
  wearScarf() {
    const d = this.slots.top
    const place = d?.top.item.cut?.scarf
    const ready = place && d.shown && d.final && !d.posing && this.view !== "fit"
    const stamp = ready ? `${d.top.drape.frame}:${d.posedAs}:${place}:${d.top.item.color}` : "none"
    if (stamp === this.scarf.stamp) return
    this.scarf.stamp = stamp
    if (this.scarf.mesh) {
      this.scarf.mesh.parent?.remove(this.scarf.mesh)
      this.scarf.mesh.traverse(o => { o.geometry?.dispose(); o.material?.dispose?.() })
      this.scarf.mesh = null
    }
    if (!ready) return
    const mesh = d.top.mesh
    mesh.geometry.computeBoundingSphere()
    const caster = new THREE.Raycaster()
    const hit = (from, direction) => {
      caster.set(new THREE.Vector3(...from), new THREE.Vector3(...direction).normalize())
      const found = caster.intersectObject(mesh, false)[0]
      return found ? found.point.toArray() : null
    }
    const frame = d.frame, m = d.top.pattern.measures
    const s = this.fitted.scale ?? 1
    const strips = []
    // A strip down from `top` (m), hanging `length`, `width` across: each row found on the dress's surface by
    // looking in along `inward` from outside, `across` the direction it spreads.
    const strip = (top, length, width, inward, across, sway) => {
      const rows = 24, positions = [], index = []
      for (let r = 0; r <= rows; r++) {
        const t = r / rows, y = top[1] - t * length
        const w = width * (1 - 0.25 * t)
        for (const side of [-1, 1]) {
          const base = [top[0] + across[0] * side * w / 2 + sway * Math.sin(t * Math.PI * 1.3) * across[0], y, top[2] + across[2] * side * w / 2 + sway * Math.sin(t * Math.PI * 1.3) * across[2]]
          const from = [base[0] - inward[0] * 0.6, y, base[2] - inward[2] * 0.6]
          const on = hit(from, inward)
          const p = on ? [on[0] - inward[0] * (0.009 + 0.012 * Math.sin(t * Math.PI)), y, on[2] - inward[2] * (0.009 + 0.012 * Math.sin(t * Math.PI))] : [base[0] - inward[0] * 0.02, y, base[2] - inward[2] * 0.02]
          positions.push(...p)
        }
      }
      for (let r = 0; r < rows; r++) { const a = 2 * r; index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2) }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
      geometry.setIndex(index)
      geometry.computeVertexNormals()
      strips.push(geometry)
    }
    const waistY = frame.hps[1] - (m.shaped?.waistAt ?? 40) / 100
    const cz = frame.torso?.centreAt?.(waistY) ?? 0
    if (place === "side") {
      // From the wearer's left side at the waist, down past the hip.
      const from = hit([1, waistY, cz], [-1, 0, 0]) ?? [0.18 * s, waistY, cz]
      strip([from[0], waistY + 0.02, from[2]], 0.62 * s, 0.11 * s, [-1, 0, 0], [0, 0, 1], 0.015)
    } else {
      // Round the neck, then both ends down the front.
      const neckY = frame.hps[1] - 0.02
      const ring = [], positions = [], index = []
      const around = 40
      for (let j = 0; j <= around; j++) {
        const a = (j / around) * 2 * Math.PI
        for (const dy of [0.025, -0.02]) {
          const r = (frame.measures.neck / (2 * Math.PI)) / 100 + 0.018 + (dy < 0 ? 0.012 : 0)
          positions.push(Math.sin(a) * r, neckY + dy, Math.cos(a) * r + 0.01)
        }
      }
      for (let j = 0; j < around; j++) { const a = 2 * j; index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3) }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
      geometry.setIndex(index)
      geometry.computeVertexNormals()
      strips.push(geometry)
      void ring
      for (const side of [-1, 1]) strip([side * 0.035 * s, neckY - 0.01, 0.2], 0.3 * s, 0.07 * s, [0, 0, -1], [1, 0, 0], 0.01 * side)
    }
    // Its own cloth, a shade off the dress's so its edges read.
    const material = accessoryMaterial("knit", "#" + new THREE.Color(d.top.item.color).offsetHSL(0, 0, -0.06).getHexString())
    const group = new THREE.Group()
    for (const geometry of strips) {
      const part = new THREE.Mesh(geometry, material)
      part.castShadow = part.receiveShadow = true
      group.add(part)
    }
    this.scene.add(group)
    this.scarf.mesh = group
  }

  // A shirt's or polo's collar: the stand is draped with the shirt, and the collar itself (its "leaf") is
  // laid folded down over it from its top edge, round the neck and over the yoke, its points coming down
  // toward the chest and apart at the front. Laid on the shirt where it hangs, as the scarf is.
  wearCollars() {
    const slots = ["top", "outer"].filter(slot => ["shirt", "shortshirt", "polo"].includes(this.slots[slot]?.top.item.style))
    const ready = slots.filter(slot => { const d = this.slots[slot]; return d.shown && d.final && !d.posing })
    const stamp = ready.map(slot => `${slot}:${this.slots[slot].top.drape.frame}:${this.slots[slot].posedAs}:${this.slots[slot].top.item.color}`).join("|") + this.view
    if (stamp === this.collars.stamp) return
    this.collars.stamp = stamp
    for (const mesh of this.collars.meshes) { this.scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose() }
    this.collars.meshes = []
    if (this.view === "fit") return
    for (const slot of ready) {
      const geometry = collarLeaf(this.slots[slot].top, this.fitted.scale ?? 1)
      if (!geometry) continue
      const item = this.slots[slot].top.item
      const mesh = new THREE.Mesh(geometry, accessoryMaterial(item.style === "polo" ? "knit" : "canvas", item.color))
      mesh.castShadow = mesh.receiveShadow = true
      this.scene.add(mesh)
      this.collars.meshes.push(mesh)
    }
  }

  // Where a garment's drape leaves it a hair outside one worn over it, it would show through: those points of
  // the one underneath aren't drawn. Worked out once both are settled in the pose shown.
  hideCovered() {
    const ready = d => d && d.shown && d.final && !d.posing
    const pairs = this.order === TUCKED_LAYERS ? [["top", "outer"], ["bottom", "outer"]] : [["bottom", "top"], ["top", "outer"], ["bottom", "outer"]]
    const stamp = pairs.map(([i, o]) => (ready(this.slots[i]) && ready(this.slots[o]) ? `${this.slots[i].top.drape.frame}/${this.slots[o].top.drape.frame}/${this.slots[o].posedAs}` : "-")).join(":") + this.order.join()
    if (stamp === this.coverStamp) return
    this.coverStamp = stamp
    for (const slot of LAYERS) {
      const inner = this.slots[slot]
      if (!ready(inner)) continue
      let covered = null
      for (const [i, o] of pairs) {
        if (i !== slot || !ready(this.slots[o])) continue
        const c = coveredPoints(inner.top, this.slots[o].top)
        covered = covered ? covered.map((v, k) => Math.max(v, c[k])) : c
      }
      inner.top.setCovered(covered)
    }
  }

  // The belt, laid round the pants' waistband as they're draped now, when nothing hangs over it (a top worn
  // out over the pants would). Redone as the pants move.
  wearBelt() {
    const bottom = this.slots.bottom
    const covered = Boolean(this.slots.top) && this.order !== TUCKED_LAYERS
    const ready = this.beltItem && bottom?.shown && bottom.final && !bottom.posing && !covered && this.view !== "fit"
    const stamp = ready ? `${bottom.top.drape.frame}:${bottom.posedAs}:${this.beltItem.color}:${this.beltItem.buckle}` : "none"
    if (stamp === this.belt.stamp) return
    this.belt.stamp = stamp
    for (const part of [this.belt.mesh, this.belt.buckle]) {
      if (!part) continue
      this.scene.remove(part)
      part.geometry.dispose()
      part.material.dispose()
    }
    this.belt.mesh = this.belt.buckle = null
    if (!ready) return
    const { drape, cloth } = bottom.top
    const at = i => { const j = drape.map ? drape.map[i] : i; return [drape.x[3 * j], drape.x[3 * j + 1], drape.x[3 * j + 2]] }
    const rim = (cloth.edges["waistband/rim"] ?? []).map(at)
    const seam = Object.keys(cloth.edges).filter(k => k.startsWith("waistband/sewn_")).flatMap(k => cloth.edges[k].map(at))
    const s = this.fitted.scale ?? 1
    const belt = beltGeometry(rim, seam, { width: 0.033 * s, out: 0.004, thick: 0.004 })
    if (!belt) return
    this.belt.mesh = new THREE.Mesh(belt.geometry, accessoryMaterial(this.beltItem.fabric === "canvas" ? "canvas" : "leather", this.beltItem.color))
    const buckle = new THREE.Mesh(buckleGeometry(belt.buckle.height), accessoryMaterial("metal", this.beltItem.buckle === "gold" ? "#c9a75e" : "#c7c9cc"))
    buckle.position.fromArray(belt.buckle.position)
    this.belt.buckle = buckle
    for (const part of [this.belt.mesh, buckle]) {
      part.castShadow = part.receiveShadow = true
      this.scene.add(part)
    }
  }

  // Draping

  // The top's slot (the page checks on it).
  get draped() {
    return this.slots.top ?? this.slots.outer
  }

  // Whether everything draped is sewn, settled and in the pose shown.
  get settled() {
    return Object.keys(this.waiting).length === 0 && Object.values(this.slots).every(d => !d || (d.top.done && d.posedAs === this.pose && !d.posing))
  }

  // The layers draped under this one.
  under(slot) {
    return (this.order === TUCKED_LAYERS ? TUCKED_OVER : OVER)[slot].map(s => this.slots[s]).filter(Boolean)
  }

  // slot: "bottom" (pants), "top" or "outer" (a casual jacket). item: the outfit item drawn there, or null.
  dressDraped(slot, item) {
    if (!item) {
      this.removeDraped(slot)
      delete this.waiting[slot]
      return
    }
    const style = slot === "bottom" ? item.style ?? "trousers" : DRAPED_STYLES.includes(item.style) ? item.style : "tee"
    // Each layer is sewn over the ones under it, so a new one under it is a new drape for it too.
    const over = this.under(slot).map(d => d.key)
    const key = JSON.stringify([slot, style, item.size, item.fabric, item.cut ?? null, item.tuck ?? null, this.fitted.scale, this.fitted.influences, over, this.feet.key])
    if (this.slots[slot]?.key !== key && this.waiting[slot]?.key !== key) {
      // The garment shown stays until the new one is sewn and in the pose shown, so nothing jumps about.
      this.removeDraped(slot, { keepShown: true })
      const spec = { slot, key, item: { kind: item.kind, style, size: item.size, color: item.color, fabric: item.fabric, cut: item.cut ?? null, tuck: item.tuck ?? null, photoSize: item.photoSize ?? null } }
      // It waits for the layers under it to be sewn, then is sewn over them.
      if (this.under(slot).some(d => !d.top.done)) this.waiting[slot] = spec
      else {
        delete this.waiting[slot]
        this.startDrape(spec)
      }
    }
    const d = this.slots[slot]
    if (!d) return
    d.top.setColor(item.color)
    d.top.setPrint(item.print ?? null, item.backPrint ?? null)
    d.top.setPhotoMap(item.photoMap ?? null)
    d.top.mesh.visible = d.shown
    if (this.view === "fit") d.top.paintFit(item.checks ?? [], STATUS_COLORS)
    d.top.setFitMap(this.view === "fit")
  }

  // The cloth is sewn and settled on the mannequin in its rest pose (arms out, as garment tools do it), then
  // moved into the pose shown and settled again there. Each layer is sewn over those under it, as they lie
  // in that pose.
  startDrape({ slot, key, item }) {
    const rest = this.restSnapshot()
    const over = [...rest.over, ...this.under(slot).filter(d => d.top.done).map(d => clothSnapshot(d.restX ?? d.top.drape.x, d.top, rest.body))]
    const { frame, field } = this.prepare({ ...rest, over }, { arms: slot !== "bottom" })
    // A jacket over a top starts clear of the top's cloth (a tucked top lies close round the waist, so the
    // usual gap clears it; more would stretch the jacket's hem round the hips, to spring back and ride up).
    if (slot === "outer" && this.slots.top && this.order !== TUCKED_LAYERS) frame.gap = 0.03
    const top = new DrapedTop({ item, body: rest.body, frame, field, measures: this.measures, renderer: this.renderer })
    top.mesh.visible = false
    this.scene.add(top.mesh)
    this.slots[slot] = { slot, key, top, rest: { ...rest, over }, frame, posedAs: null, posing: null, shown: false, bodyType: this.bodyType }
    this.start()
  }

  // keepShown: leave the garment on screen (as this.leaving[slot]) until the next one is ready to show.
  removeDraped(slot = "top", { keepShown = false } = {}) {
    const d = this.slots[slot]
    this.slots[slot] = null
    if (!d) { if (!keepShown) this.dropLeaving(slot); return }
    if (keepShown && d.shown) {
      this.dropLeaving(slot)
      this.leaving[slot] = d
      return
    }
    this.scene.remove(d.top.mesh)
    d.top.dispose()
    if (!keepShown) this.dropLeaving(slot)
  }

  dropLeaving(slot) {
    const d = this.leaving[slot]
    if (!d) return
    this.scene.remove(d.top.mesh)
    d.top.dispose()
    this.leaving[slot] = null
  }

  // The body (and the trousers, when worn) and the egg head in the pose garments are sewn in (see SEWING_POSE),
  // with how each bone then maps bind space to world space. The pose shown is put back afterwards.
  restSnapshot() {
    for (const [bone, quaternion] of this.rest) bone.quaternion.copy(quaternion)
    this.turnBones(SEWING_POSE, 1)
    this.model.updateMatrixWorld(true)
    const snapshot = this.snapshotNow()
    const mesh = this.meshes.body
    snapshot.skin = mesh.skeleton.bones.map((bone, i) => new THREE.Matrix4().multiplyMatrices(bone.matrixWorld, mesh.skeleton.boneInverses[i]).multiply(mesh.bindMatrix))
    this.applyPose()
    return snapshot
  }

  // slot: whose drape this is for; it includes the layers draped under it as they are now.
  snapshotNow(slot = null) {
    const body = bodySnapshot(this.meshes.body)
    const over = this.meshes.trousers.visible ? [bodySnapshot(this.meshes.trousers)] : []
    // Shoes and socks are worn under everything: pants lie on them.
    for (const mesh of this.feet.meshes) over.push(meshSnapshot(mesh))
    if (slot) for (const d of this.under(slot)) if (d.top.done) over.push(clothSnapshot(d.top.drape.x, d.top, body))
    return { body, over, egg: this.eggShape() }
  }

  // The egg head as an ellipsoid in world space.
  eggShape() {
    const egg = this.egg
    if (!egg) return null
    egg.updateWorldMatrix(true, false)
    const centre = new THREE.Vector3().setFromMatrixPosition(egg.matrixWorld)
    const scale = new THREE.Vector3().setFromMatrixScale(egg.matrixWorld)
    return { centre: centre.toArray(), radii: scale.toArray() }
  }

  // Once the drape has settled, and whenever the pose changes: the garment, skinned from its rest drape into
  // the pose shown, settles there on the posed body.
  reposeDraped(d) {
    const { top } = d
    const drape = top.drape
    if (!d.restX) {
      d.restX = Float32Array.from(drape.x)
      const pieces = new Array(drape.x.length / 3)
      top.cloth.panel.forEach((p, i) => { pieces[drape.map[i]] ??= top.cloth.panels[p] })
      // Without sleeves, the garment doesn't follow the arms (its straps stay on the shoulders).
      const bones = this.meshes.body.skeleton.bones
      const sleeveless = !Object.keys(top.pattern.panels).some(name => name.startsWith("sleeve"))
      const still = sleeveless ? new Set(bones.flatMap((b, i) => (/^(upperarm|lowerarm|hand|thumb|index|middle|ring|pinky)_/.test(b.name) ? [i] : []))) : null
      const fallback = Math.max(0, bones.findIndex(b => /^spine_?0?3|^spine3|chest/i.test(b.name)))
      d.weights = garmentWeights(d.restX, pieces, d.rest.body, d.frame, { still, fallback, legs: d.slot === "bottom" })
      // Each point back into bind space, through the bones it follows as they were when it was sewn.
      d.restBind = new Float32Array(d.restX.length)
      const blend = new THREE.Matrix4(), point = new THREE.Vector3()
      const { skinIndex, skinWeight } = d.weights
      for (let i = 0; i < d.restX.length / 3; i++) {
        const e = blend.elements.fill(0)
        for (let k = 0; k < 4; k++) {
          const w = skinWeight[4 * i + k]
          if (!w) continue
          const m = d.rest.skin[skinIndex[4 * i + k]].elements
          for (let j = 0; j < 16; j++) e[j] += w * m[j]
        }
        point.set(d.restX[3 * i], d.restX[3 * i + 1], d.restX[3 * i + 2]).applyMatrix4(blend.invert())
        d.restBind[3 * i] = point.x; d.restBind[3 * i + 1] = point.y; d.restBind[3 * i + 2] = point.z
      }
    }
    d.final = false
    d.posing = this.posing(d)
    d.posedAs = this.pose
  }

  // Into the pose a little at a time, settling between, as a person moves: an arm swung down in one jump
  // lands inside the shirt's side and pushes the cloth out over itself; moved in steps, it pushes the cloth
  // aside. The garment on screen stays as it was until the last step (d.final).
  * posing(d) {
    const drape = d.top.drape
    const long = d.top.pattern.style === "dress" || d.top.pattern.measures.length > 85   // more to push aside, further to fall
    const steps = long ? 6 : 3
    let before = null
    for (let s = 1; s <= steps; s++) {
      d.poseStep = (s - 1) / steps
      this.applyPose(s / steps)
      const posed = skinPoints(d.restBind, d.weights.skinIndex, d.weights.skinWeight, this.meshes.body)
      const now = this.snapshotNow(d.slot)
      const { frame, field } = this.prepare(now, { arms: d.slot !== "bottom" })
      if (s < steps) this.applyPose()
      // A skirt or dress keeps hanging round both legs as they come together, rather than falling in
      // between them.
      const envelope = drape.hangs ? { table: frame.torso, top: frame.crotch + 0.03, bottom: frame.floor } : null
      // A tucked top stays gathered round the body as it moves.
      if (drape.tuck) drape.tuck = { ...drape.tuck, table: frame.torso }
      // Pants stay off the feet where the feet now are.
      const feet = drape.feet ? frame.feet : null
      if (!before) drape.repose(posed, field, envelope, feet)
      else {
        for (let i = 0; i < posed.length; i++) drape.x[i] += posed[i] - before[i]
        drape.v.fill(0)
        drape.field = field
        drape.envelope = envelope
        drape.feet = feet
      }
      before = posed
      if (s < steps) { yield* drape.settle(14, 6); continue }
      d.final = true
      d.top.update()
      yield* (long ? drape.settle(180, 50) : drape.settle(70, 25))
    }
  }

  // What a studio render needs to reproduce the screen: the body's shape keys and scale, each item's
  // size adjustments and colour, and the pose.
  snapshot() {
    if (!this.fitted) return null
    return {
      scale: this.fitted.scale,
      // The studio renderer has only the base body's shape keys (its own build is the men's body).
      body: Object.fromEntries(Object.entries(this.fitted.influences).filter(([name]) => name !== "women")),
      pose: this.pose,
      // Shoes, socks and belts are drawn only here, on the page.
      items: this.outfit.filter(item => !["shoes", "socks", "belt"].includes(item.kind)).map(item => ({
        kind: item.kind, style: item.kind === "jacket" ? (item.style ?? "tailored") : item.kind === "top" ? (item.style ?? "tee") : undefined,
        color: item.color, fabric: item.fabric ?? "wool", ease: this.lastEase[item.kind] ?? {}
      }))
    }
  }

  // kind: the mesh ("jacket", "coat" or "trousers"); slot: the outfit's.
  dressMesh(kind, item, ease, slot = kind) {
    this.lastEase[slot] = ease
    const mesh = this.meshes[kind]
    const keys = EASE_KEYS[kind === "trousers" ? "trousers" : "jacket"]
    applyInfluences(mesh, Object.fromEntries(keys.map(key => [key, ease[key] ?? 0])))
    const materials = this.materials[kind]
    const fabric = FABRICS[item.fabric] ?? FABRICS.wool
    materials.cloth.userData.tint.value.set(item.color)
    materials.cloth.sheenColor.set(item.color).offsetHSL(0, 0, 0.35)   // cloth catches light in its own colour
    materials.cloth.roughness = fabric.roughness
    materials.cloth.sheen = fabric.sheen
    materials.cloth.normalScale.setScalar(fabric.weave)
    materials.cloth.clearcoat = fabric.clearcoat
    if (this.view === "fit") {
      paintFitMap(mesh, item.checks, REGIONS[kind === "trousers" ? "trousers" : "jacket"])
      mesh.material = materials.fitMap
    } else {
      mesh.material = materials.cloth
    }
  }

  // Setup

  addLights() {
    // A soft key light for the shadows clothes and limbs cast on each other; the studio HDRI does the rest.
    const key = new THREE.DirectionalLight(0xfff8f0, 1.6)
    key.position.set(1.6, 3.2, 2.4)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.camera.left = key.shadow.camera.bottom = -1.3
    key.shadow.camera.right = key.shadow.camera.top = 1.3
    key.shadow.radius = 8
    key.shadow.bias = -0.0003
    key.shadow.normalBias = 0.01
    this.scene.add(key)
    this.key = key
    // A light from behind, which catches the edges of the cloth and lifts the figure off the backdrop: dim and
    // a little cool on the graphite stage (a studio's separation, not a colour cast), stronger in daylight. And
    // in the daylight studio, a cool fill from the other side.
    this.fill = new THREE.DirectionalLight(0xf2f4ff, 0.55)
    this.fill.position.set(-2.5, 1.8, 2.0)
    this.rim = new THREE.DirectionalLight(RIM.color, RIM.intensity)
    this.rim.position.set(...RIM.position)
    this.fill.visible = false
    this.scene.add(this.fill, this.rim)

    // A faint pool of light on the floor, so the figure stands on something, and its shadow in it.
    const pool = new THREE.Mesh(new THREE.CircleGeometry(1.1, 64), new THREE.MeshBasicMaterial({
      color: 0x59606c, map: glow(), transparent: true, depthWrite: false, toneMapped: false
    }))
    pool.rotation.x = -Math.PI / 2
    pool.position.y = -0.001
    this.scene.add(pool)
    const floor = new THREE.Mesh(new THREE.CircleGeometry(4, 64), new THREE.ShadowMaterial({ opacity: 0.45 }))
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = true
    this.scene.add(floor)
    this.pool = pool
    this.floor = floor
    // Right under the feet, where the floor sees least of the room: a small, soft dark patch, so the figure
    // stands on the floor rather than over it.
    const contact = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.46), new THREE.MeshBasicMaterial({
      color: 0x000000, alphaMap: contactShadow(), transparent: true, opacity: 0.55, depthWrite: false
    }))
    contact.rotation.x = -Math.PI / 2
    contact.position.set(0, 0.0005, 0.02)
    contact.renderOrder = 1
    this.scene.add(contact)
    this.contact = contact
  }

  // "dark" (the graphite stage) or "daylight": a pale seamless studio like a shop's lookbook. The floor is
  // only its shadows on the backdrop's colour, so there's no line where floor meets wall.
  setScene(name) {
    const day = name === "daylight"
    this.sceneLook = day ? "daylight" : "dark"
    this.scene.background?.dispose?.()
    this.scene.background = day ? daylightBackdrop(this.backdropTone(1.05)) : backdrop(this.backdropTone(1))
    this.pool.visible = !day
    this.floor.material.opacity = day ? 0.3 : 0.45
    this.contact.material.opacity = day ? 0.38 : 0.55
    this.fill.visible = day
    this.rim.color.set(day ? 0xffffff : RIM.color)
    this.rim.intensity = day ? 0.55 : RIM.intensity
    this.rim.position.set(...(day ? [0, 2.5, -3] : RIM.position))
    this.key.intensity = day ? 1.7 : 1.6
    this.key.shadow.radius = day ? 14 : 8
    this.scene.environmentIntensity = day ? 0.75 : 0.85
    this.renderer.toneMappingExposure = day ? 1.05 : 1
    this.start()
  }

  async dress(textures) {
    const loader = new THREE.TextureLoader()
    const load = async (path, { color = true, repeat = null } = {}) => {
      const texture = await loader.loadAsync(`${MODELS}/${path}`)
      texture.flipY = false   // glTF texture coordinates
      if (color) texture.colorSpace = THREE.SRGBColorSpace
      texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy()
      if (repeat) {
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping
        texture.repeat.set(repeat, repeat)
      }
      return texture
    }
    const [suit, ao, woolNormal, woolRoughness] = await Promise.all([
      load(textures.suit),
      load(textures.suit_ao, { color: false }),
      load("textures/wool_normal.jpg", { color: false, repeat: WOOL_REPEAT }),
      load("textures/wool_roughness.jpg", { color: false, repeat: WOOL_REPEAT })
    ])
    const maps = { map: suit, aoMap: ao, normalMap: woolNormal, roughnessMap: woolRoughness }

    this.meshes.body.material = mannequinMaterial()
    this.materials = {
      jacket: { cloth: tintableFabric(maps), fitMap: fitMapFabric(maps) },
      coat: { cloth: tintableFabric(maps, { clothOnly: true }), fitMap: fitMapFabric(maps, { clothOnly: true }) },
      trousers: { cloth: tintableFabric(maps), fitMap: fitMapFabric(maps) }
    }
    for (const kind of ["jacket", "coat", "trousers"]) this.meshes[kind].material = this.materials[kind].cloth
  }

  // The head as the cloth meets it: an egg round MakeHuman's head (the mannequin shows its own sculpted
  // head, in the same matte finish), on an oval neck, both hanging from the head bone so they follow the pose
  // and the mannequin's height. Never drawn: a hood or collar drapes over this smooth shape rather than
  // catching on the face.
  addEggHead({ centre, radii }) {
    const material = this.meshes.body.material.userData.plain
    const egg = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), material)
    // A little bigger all round than the head, so a hood lies over its crown and the back of the skull (a
    // little longer at the bottom, down to the jaw).
    egg.scale.set(radii[0] * 1.08, radii[1] * 1.14, radii[2] * 1.18)
    egg.position.fromArray(centre)
    egg.position.y -= radii[1] * 0.06
    egg.position.z -= 0.012   // the back of the skull reaches further back than the face does forward
    // The neck leans forward a little, from the body's neck into the middle of the egg (which sits forward of
    // it). Each body has its own (the women's is slimmer); both are kept, in the model's space.
    const neckAt = ({ radii, centreZ, flare = 1.04 }) => {
      const from = new THREE.Vector3(0, NECK.bottom, centreZ), to = egg.position
      const geometry = new THREE.CylinderGeometry(1, flare, from.distanceTo(to), 48, 1, true)
      geometry.scale(radii[0], 1, radii[1])
      geometry.rotateX(Math.atan2(to.z - from.z, to.y - from.y))
      geometry.translate(...from.clone().lerp(to, 0.5).toArray())
      return geometry
    }
    const neck = new THREE.Mesh(neckAt(NECK), material)
    const women = this.calibration.women?.neck
    this.necks = { men: neck.geometry, women: women ? neckAt({ ...NECK, ...women }) : neck.geometry }
    for (const part of [egg, neck]) {
      part.castShadow = part.receiveShadow = true
      this.model.add(part)
    }
    this.model.updateMatrixWorld(true)
    const head = this.model.getObjectByName("head")
    head?.attach(egg)
    head?.attach(neck)
    egg.visible = neck.visible = false
    this.eggScale = egg.scale.clone()
    this.egg = egg
    this.eggNeck = neck
  }

  // amount: how far from the rest pose into it (0 to 1), for moving into it in steps (see posing).
  applyPose(amount = 1) {
    if (!this.model) return
    for (const [bone, quaternion] of this.rest) bone.quaternion.copy(quaternion)
    const pose = this.poses.poses[this.pose] ?? this.poses.poses.standing
    // Part of the way (while a garment moves into the pose): from the pose it was sewn in.
    if (amount < 1) this.turnBones(SEWING_POSE, 1 - amount)
    this.turnBones(pose.turns, amount)
    // Relaxed hands: fingers gently curled, as on a display mannequin.
    const { bones, curl, thumb_02: thumb } = this.poses.fingers
    for (const side of ["l", "r"]) {
      for (const finger of bones) {
        for (const [joint, angle] of Object.entries(curl)) this.model.getObjectByName(`${finger}_${joint}_${side}`)?.rotateX(angle)
      }
      this.model.getObjectByName(`thumb_02_${side}`)?.rotateX(thumb)
    }
    this.model.updateMatrixWorld(true)
  }

  // Turns bones from where they are: [bone, world axis "x" or "z", radians], `amount` of the way.
  turnBones(turns, amount) {
    const axes = { x: new THREE.Vector3(1, 0, 0), z: new THREE.Vector3(0, 0, 1) }
    // The women's mannequin holds its arms a little further from its body (as display mannequins do), clear of
    // a skirt.
    const armsOut = this.bodyType === "women" && this.hasWomen ? (this.calibration.women.arms ?? 1) : 1
    for (const [name, axis, turn] of turns) {
      const angle = turn * amount * (axis === "z" && name.startsWith("upperarm_") ? armsOut : 1)
      const bone = this.model.getObjectByName(name)
      if (!bone) continue
      // Turn about a world axis, expressed in the bone's parent space.
      this.model.updateMatrixWorld(true)
      const local = axes[axis].clone().applyQuaternion(bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert())
      bone.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(local, angle))
    }
  }

  // Head to toe, a little from the side, like a lookbook photo.
  frame() {
    const H = this.calibration.body.height / 100
    // Room above the head for the controls and below the feet for the size rows (on a phone the controls
    // sit above the picture instead, and the narrow picture needs a little more room round the figure).
    // A little low in the picture, so the note under the controls stays clear of the head.
    const margin = 0.8
    const distance = (H * margin) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))
    this.controls.target.set(0, H * 0.56, 0)
    this.camera.position.set(Math.sin(0.25) * distance, H * 0.6, Math.cos(0.25) * distance)
    this.controls.update()
  }

  // A still picture of what's on screen, sharper than the screen: drawn once at `width` by `height` pixels
  // with finer shadows, then the view goes back as it was. Returns a PNG Blob. Nothing leaves the device.
  async photo({ width = 1600, height = 2000 } = {}) {
    return (await this.photoPasses({ width, height, guides: false })).image
  }

  // The photo, and with `guides` two more pictures from the same camera for an image model to keep to:
  // depth (nearest white, farthest black, the figure only) and the figure's outline (white on black).
  // Returns { image, depth, mask } as PNG Blobs (depth and mask null without guides).
  async photoPasses({ width = 1600, height = 2000, guides = true } = {}) {
    this.wearBelt()
    this.wearScarf()
    this.wearCollars()
    this.hideCovered()
    const renderer = this.renderer, camera = this.camera
    const size = renderer.getSize(new THREE.Vector2()), ratio = renderer.getPixelRatio()
    const { aspect, fov, near, far } = camera
    const key = this.scene.children.find(o => o.isDirectionalLight)
    const mapSize = key?.shadow.mapSize.clone()
    if (key) {
      key.shadow.mapSize.set(4096, 4096)
      key.shadow.map?.dispose()
      key.shadow.map = null
    }
    renderer.setPixelRatio(1)
    renderer.setSize(width, height, false)
    // Framed a little closer than the screen, like a lookbook photo.
    camera.fov = fov * 0.85
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    this.effects?.composer.setPixelRatio(1)
    this.effects?.composer.setSize(width, height)
    this.draw()
    const image = await withGrain(renderer.domElement)
    let depth = null, mask = null
    if (guides) {
      const stand = [this.pool, this.floor, this.contact].filter(Boolean)
      const background = this.scene.background
      const shown = stand.map(o => o.visible)
      stand.forEach(o => { o.visible = false })
      this.scene.background = new THREE.Color(0x000000)
      // Depth over the figure's own span, so its near and far ends use the whole range of grey.
      const sphere = new THREE.Box3().setFromObject(this.model).getBoundingSphere(new THREE.Sphere())
      const distance = camera.position.distanceTo(sphere.center)
      camera.near = Math.max(0.05, distance - sphere.radius * 1.25)
      camera.far = distance + sphere.radius * 1.25
      camera.updateProjectionMatrix()
      const depthMaterial = new THREE.MeshDepthMaterial()
      this.scene.overrideMaterial = depthMaterial
      renderer.render(this.scene, camera)
      depth = canvasBlob(renderer.domElement)
      const maskMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide })
      this.scene.overrideMaterial = maskMaterial
      renderer.render(this.scene, camera)
      mask = canvasBlob(renderer.domElement)
      this.scene.overrideMaterial = null
      depthMaterial.dispose()
      maskMaterial.dispose()
      this.scene.background = background
      stand.forEach((o, i) => { o.visible = shown[i] })
      camera.near = near
      camera.far = far
    }
    camera.fov = fov
    if (key) {
      key.shadow.mapSize.copy(mapSize)
      key.shadow.map?.dispose()
      key.shadow.map = null
    }
    renderer.setPixelRatio(ratio)
    renderer.setSize(size.x, size.y, false)
    this.effects?.composer.setPixelRatio(ratio)
    this.effects?.composer.setSize(size.x, size.y)
    camera.aspect = aspect
    camera.updateProjectionMatrix()
    return { image, depth: await depth, mask: await mask }
  }

  // Left alone, the mannequin turns slowly, as a shop's turntable does, so the clothes are seen all round; a
  // touch stops it, and it starts again a while after. Not for anyone who's asked for less motion.
  idleTurn() {
    const still = matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
    if (still) return
    const controls = this.controls
    controls.autoRotateSpeed = IDLE_TURN.speed
    let timer = null
    const later = () => {
      clearTimeout(timer)
      timer = setTimeout(() => { controls.autoRotate = true }, IDLE_TURN.after)
    }
    controls.addEventListener("start", () => { controls.autoRotate = false; clearTimeout(timer) })
    controls.addEventListener("end", later)
    later()
    this.stopIdleTurn = () => { clearTimeout(timer); controls.autoRotate = false }
  }

  // Contact shading (N8AO): the soft darkening where cloth folds, where an arm meets the body, under a
  // collar and round the feet, as a room's light can't reach. It only darkens what's hidden, so a garment's
  // colour stays the shop's in open light. Then the colours as the renderer would show them (tone mapping),
  // and SMAA for clean edges (the screen's own smoothing doesn't work with it). Without WebGL 2, or if
  // anything fails, the scene is drawn as before.
  addEffects() {
    try {
      if (!this.renderer.capabilities.isWebGL2) return null
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2())
      const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType })
      const composer = new EffectComposer(this.renderer, target)
      const ao = new N8AOPass(this.scene, this.camera, size.x, size.y)
      const phone = navigator.maxTouchPoints > 0 && Math.min(screen.width, screen.height) < 820
      ao.setQualityMode(phone ? "Performance" : "Medium")
      ao.configuration.halfRes = phone
      ao.configuration.gammaCorrection = false   // OutputPass does it
      ao.configuration.transparencyAware = false // sheer cloth and the floor's shadow don't need it
      ao.configuration.aoRadius = AO.radius
      ao.configuration.distanceFalloff = AO.falloff
      ao.configuration.intensity = AO.intensity
      ao.configuration.screenSpaceRadius = false
      composer.addPass(ao)
      composer.addPass(new OutputPass())
      composer.addPass(new SMAAPass(size.x, size.y))
      return { composer, ao }
    } catch {
      return null
    }
  }

  // How the backdrop's colours are to be painted. Drawn straight to the screen, an sRGB backdrop is shown as
  // painted (three.js doesn't tone-map it); through the effects everything is tone-mapped at the end, which
  // would sink the graphite stage to black and hide the floor's shadow in it. So with effects on, it's
  // painted in the colours that come out as before.
  backdropTone(exposure) {
    return this.effects ? css => untoned(css, exposure) : css => css
  }

  // The scene, through the effects when there are any.
  draw() {
    if (this.effects) this.effects.composer.render()
    else this.renderer.render(this.scene, this.camera)
  }

  // Whether what's worn includes a draped garment (a top or casual jacket), which only the page can draw.
  get hasDraped() {
    return Object.values(this.slots).some(Boolean)
  }

  resize() {
    // The canvas's own box (on a phone the controls sit above it), else its container's.
    const box = this.canvas.clientHeight > 0 ? this.canvas : this.canvas.parentElement
    const { clientWidth: width, clientHeight: height } = box
    if (!width || !height) return
    this.renderer.setSize(width, height, false)
    this.effects?.composer.setPixelRatio(this.renderer.getPixelRatio())
    this.effects?.composer.setSize(width, height)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    if (this.calibration) this.frame()
  }

  start() {
    if (this.frameId || !this.visible) return
    this.frameId = requestAnimationFrame(this.tick)
  }

  tick = () => {
    this.controls.update()
    this.advanceDrape()
    this.fitTuck()
    this.wearBelt()
    this.wearScarf()
    this.wearCollars()
    this.hideCovered()
    this.draw()
    this.frameId = this.visible ? requestAnimationFrame(this.tick) : null
  }

  // A few milliseconds of draping per frame, so the page stays smooth while the cloth settles: the pants
  // first, then the top over them.
  advanceDrape() {
    // Once everything is on (or nothing's being put on), say so, once: the page's loader goes.
    if (this.settled) {
      if (this.busy) { this.busy = false; this.onDrape?.("done", true) }
    } else this.busy = true
    // A tucked top waits to be shown until the pants it's tucked into are (it's cut short, to end inside them).
    for (const slot of this.order) if (this.slots[slot]?.final && !this.slots[slot].posing) this.show(this.slots[slot])
    for (const slot of this.order) {
      const spec = this.waiting[slot]
      if (spec && this.under(slot).every(d => d.top.done)) {
        delete this.waiting[slot]
        this.startDrape(spec)
        this.redraw()
      }
    }
    for (const slot of this.order) {
      const d = this.slots[slot]
      if (!d) continue
      if (!d.top.done) {
        d.top.advance(this.drapeBudget)
        this.onDrape?.(d.top.phase, d.top.done)
        return
      }
      // It moves into a pose once the layers under it are there.
      if (this.under(slot).some(u => u.posedAs !== this.pose || u.posing)) return
      if (d.posedAs !== this.pose) {
        this.reposeDraped(d)
        return
      }
      if (d.posing) {
        this.onDrape?.("posing", false)
        const end = performance.now() + this.drapeBudget
        while (performance.now() < end) {
          if (d.posing.next().done) { d.posing = null; d.top.shade(); break }
        }
        if (!d.final) return
        d.top.update()
        // It's sewn and moved into the pose shown: show it in place of the one before.
        this.show(d)
        if (!d.posing && this.settled) this.onDrape?.("done", true)
        if (d.posing) return
      }
    }
  }

  // How far along getting everything on screen is, 0 to 1: each garment's drape counts for most of its
  // share, moving it into the pose for the rest; a garment waiting for the one under it counts as not begun.
  progress() {
    const parts = []
    for (const slot of this.order) {
      if (this.waiting[slot]) { parts.push(0); continue }
      const d = this.slots[slot]
      if (!d) continue
      if (!d.top.done) parts.push(0.8 * d.top.progress())
      else if (d.posedAs !== this.pose || d.posing) parts.push(0.8 + 0.2 * (d.posedAs === this.pose ? d.poseStep ?? 0 : 0))
      else parts.push(1)
    }
    return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 1
  }

  show(d) {
    if (d.shown) return
    const pants = this.slots.bottom
    if (d.slot === "top" && this.order === TUCKED_LAYERS && pants && !pants.shown) return
    d.shown = true
    d.top.mesh.visible = true
    this.dropLeaving(d.slot)
  }

  // A tucked top isn't drawn below where the pants' waistband actually lies (see DrapedTop#tuckedAway).
  fitTuck() {
    const top = this.slots.top?.top, bottom = this.slots.bottom
    if (this.order !== TUCKED_LAYERS || !top?.drape.tuck || !bottom?.shown) return
    const { drape, cloth } = bottom.top
    const stamp = `${drape.frame}:${bottom.posedAs}:${top.drape.frame}`
    if (this.tuckStamp === stamp) return
    this.tuckStamp = stamp
    const points = [...new Set((cloth.edges["waistband/rim"] ?? []).map(i => (drape.map ? drape.map[i] : i)))]
    top.setRim(points.map(j => [drape.x[3 * j], drape.x[3 * j + 1], drape.x[3 * j + 2]]))
  }

  dispose() {
    this.stopIdleTurn?.()
    cancelAnimationFrame(this.frameId)
    for (const slot of LAYERS) this.removeDraped(slot)
    this.resizeObserver.disconnect()
    this.intersectionObserver.disconnect()
    this.controls.dispose()
    this.scene.traverse(object => {
      object.geometry?.dispose()
      for (const material of [object.material].flat().filter(Boolean)) {
        for (const value of Object.values(material)) if (value?.isTexture) value.dispose()
        material.dispose()
      }
    })
    this.scene.environment?.dispose()
    this.effects?.composer.dispose()
    this.effects?.ao.dispose?.()
    this.renderer.dispose()
  }
}

// A collar's leaf (see wearCollars): from the stand's top edge, folded down over it and the shirt below, as
// a strip round the neck, open at the front. top: the shirt's DrapedTop as draped now.
function collarLeaf(top, scale) {
  const { drape, cloth, mesh } = top
  const rim = cloth.edges["collar/rim"]
  if (!rim?.length) return null
  const at = i => { const j = drape.map ? drape.map[i] : i; return new THREE.Vector3(drape.x[3 * j], drape.x[3 * j + 1], drape.x[3 * j + 2]) }
  const points = rim.map(at)
  const centre = points.reduce((c, p) => c.add(p), new THREE.Vector3()).multiplyScalar(1 / points.length)
  const angle = p => Math.atan2(p.x - centre.x, p.z - centre.z)
  // The rim by angle round the neck (0 at the front, toward +x), from the back round to the back.
  const around = 72, columns = []
  for (let j = 0; j <= around; j++) {
    const a = (j / around) * 2 * Math.PI - Math.PI
    if (Math.abs(a) < 0.16) { columns.push(null); continue }   // open at the front
    let best = null, bestD = Infinity
    for (const p of points) {
      const d = Math.abs(Math.atan2(Math.sin(angle(p) - a), Math.cos(angle(p) - a)))
      if (d < bestD) { bestD = d; best = p }
    }
    columns.push({ a, p: best })
  }
  mesh.geometry.computeBoundingSphere()
  const caster = new THREE.Raycaster()
  const polo = top.item.style === "polo"
  const rows = 9, positions = [], index = [], start = []
  for (const column of columns) {
    if (!column) { start.push(-1); continue }
    const { a, p } = column
    start.push(positions.length / 3)
    const u = new THREE.Vector3(Math.sin(a), 0, Math.cos(a))
    // Longer toward the front, where the collar's points are.
    const front = Math.max(0, Math.min(1, (1.1 - Math.abs(a)) / 0.9))
    const drop = (polo ? 0.05 : 0.052 + 0.03 * front * front) * scale
    const rimR = Math.hypot(p.x - centre.x, p.z - centre.z)
    const spread = (polo ? 0.03 : 0.028 + 0.02 * front) * scale
    for (let r = 0; r <= rows; r++) {
      const t = r / rows
      // Out from the neck as it comes down: over the stand's top, then flaring a little over the shirt.
      const out = rimR + (0.003 + spread * Math.sin(Math.min(1, t * 1.25) * Math.PI / 2)) * (r === 0 ? 0.3 : 1)
      const x = centre.x + u.x * out, z = centre.z + u.z * out
      let y = p.y + 0.004 * scale - t * drop
      // Never inside the shirt: over the shoulders' slope it lies on the yoke.
      caster.set(new THREE.Vector3(x, p.y + 0.2, z), new THREE.Vector3(0, -1, 0))
      const below = caster.intersectObject(mesh, false).find(h => h.point.y < p.y - 0.004)
      if (below) y = Math.max(y, below.point.y + 0.004 * scale)
      positions.push(x, y, z)
    }
  }
  for (let c = 0; c + 1 < columns.length; c++) {
    const a0 = start[c], b0 = start[c + 1]
    if (a0 < 0 || b0 < 0) continue
    for (let r = 0; r < rows; r++) index.push(a0 + r, b0 + r, a0 + r + 1, a0 + r + 1, b0 + r, b0 + r + 1)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(index)
  geometry.computeVertexNormals()
  return geometry
}

// A mesh as it stands now, in world space, as something to drape over.
function meshSnapshot(mesh) {
  mesh.updateWorldMatrix(true, false)
  const a = mesh.geometry.attributes.position, v = new THREE.Vector3()
  const positions = new Float32Array(3 * a.count)
  for (let i = 0; i < a.count; i++) { v.fromBufferAttribute(a, i).applyMatrix4(mesh.matrixWorld); positions[3 * i] = v.x; positions[3 * i + 1] = v.y; positions[3 * i + 2] = v.z }
  const index = Uint32Array.from(mesh.geometry.index.array)
  return { positions, normals: vertexNormals(positions, index), index }
}

// A draped garment as something to drape over: its cloth's points (x, the drape's joined points) as a
// triangle mesh with normals. A tucked top is left out from a little above the pants' waistband down: the
// pants cover it, and where it comes out of them, its edge and theirs together would snag the cloth over
// them.
function clothSnapshot(x, garment, body = null) {
  const map = garment.drape.map
  const away = garment.tuckedAway?.(x, -0.025)
  let triangles = garment.triangles
  if (away) triangles = Uint32Array.from(triangles).filter((_, k, all) => { const t = k - (k % 3); return !(away[all[t]] > 0 && away[all[t + 1]] > 0 && away[all[t + 2]] > 0) })
  const index = Uint32Array.from(triangles, i => (map ? map[i] : i))
  const positions = Float32Array.from(x)
  const normals = vertexNormals(positions, index)
  if (body) faceAway(positions, normals, body)
  return { positions, normals, index }
}

// Cloth folded over on itself (loose pants bunched at the hip) faces both ways at once, and a layer sewn over
// it would be pulled into the fold and held there, its seams then dragging the rest of it down after. Its
// normals all face away from the body instead (the way the nearest skin faces), so the fold is pushed out of like any other cloth.
function faceAway(positions, normals, body) {
  const cell = 0.03, grid = new Map(), B = body.positions
  const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`
  for (let i = 0; i < B.length / 3; i++) {
    const k = key(B[3 * i], B[3 * i + 1], B[3 * i + 2])
    if (!grid.has(k)) grid.set(k, [])
    grid.get(k).push(i)
  }
  for (let j = 0; j < positions.length / 3; j++) {
    const x = positions[3 * j], y = positions[3 * j + 1], z = positions[3 * j + 2]
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell)
    let best = -1, bestD = Infinity
    for (let r = 0; r <= 3 && best < 0; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue
        for (const i of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
          const d = (B[3 * i] - x) ** 2 + (B[3 * i + 1] - y) ** 2 + (B[3 * i + 2] - z) ** 2
          if (d < bestD) { bestD = d; best = i }
        }
      }
    }
    if (best < 0) continue
    const M = body.normals
    if (M[3 * best] * normals[3 * j] + M[3 * best + 1] * normals[3 * j + 1] + M[3 * best + 2] * normals[3 * j + 2] < 0) {
      normals[3 * j] *= -1; normals[3 * j + 1] *= -1; normals[3 * j + 2] *= -1
    }
  }
}

function applyInfluences(mesh, influences) {
  const dictionary = mesh.morphTargetDictionary
  if (!dictionary) return
  for (const [name, value] of Object.entries(influences)) {
    const index = dictionary[name]
    if (index !== undefined) mesh.morphTargetInfluences[index] = value
  }
}

// Matte white fibreglass, like a shop's display mannequin. The body is hidden wherever a worn garment
// covers it (the build marks those parts), since clothes fit too close for it not to show through, and
// where its head is (an egg takes its place).
function mannequinMaterial() {
  const hideJacket = { value: 0 }
  const hideCasual = { value: 0 }
  const hideTrousers = { value: 0 }
  // Both sides drawn, so where the neck is cut and meets the egg's neck, any sliver of the inside is white too.
  // Matte, like a ceramic display form: nothing shiny to pull the eye from the clothes.
  const finish = { color: 0xf4f2ee, roughness: 0.86, metalness: 0, clearcoat: 0, side: THREE.DoubleSide }
  const material = new THREE.MeshPhysicalMaterial(finish)
  material.userData = { hideJacket, hideCasual, hideTrousers, plain: new THREE.MeshPhysicalMaterial(finish) }
  material.onBeforeCompile = shader => {
    shader.uniforms.uHideJacket = hideJacket
    shader.uniforms.uHideCasual = hideCasual
    shader.uniforms.uHideTrousers = hideTrousers
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
        attribute float _cover_jacket;
        attribute float _cover_casual;
        attribute float _cover_trousers;
        varying float vCovered;
        uniform float uHideJacket;
        uniform float uHideCasual;
        uniform float uHideTrousers;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        vCovered = max(max(_cover_jacket * uHideJacket, _cover_casual * uHideCasual), _cover_trousers * uHideTrousers);`)
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vCovered;")
      .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>
        if (vCovered > 0.5) discard;`)
  }
  return material
}

// Wool suiting: the suit's own texture (cloth lightened to grey and marked in alpha by the build) dyed
// the item's colour, a fine tiled weave for the surface, baked shading in the folds, a soft sheen, and a
// dark lining on the inside. The shirt collar, cuffs, tie, buttons and shoes keep their own colours; with
// clothOnly (a coat over a jacket) only the cloth is drawn, so the jacket's shirt and tie aren't doubled.
function tintableFabric({ map, aoMap, normalMap, roughnessMap }, { clothOnly = false } = {}) {
  const tint = { value: new THREE.Color("#2a3552") }
  const material = new THREE.MeshPhysicalMaterial({
    map, aoMap, aoMapIntensity: 1, normalMap, normalScale: new THREE.Vector2(0.35, 0.35), roughnessMap,
    roughness: 0.92, sheen: 0.35, sheenRoughness: 0.6, side: THREE.DoubleSide
  })
  material.userData.tint = tint
  const inflate = { value: 0 }
  material.userData.inflate = inflate
  material.onBeforeCompile = shader => {
    shader.uniforms.fabricTint = tint
    standOut(shader, inflate)
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 fabricTint;")
      .replace("#include <map_fragment>", `
        vec4 sampledDiffuseColor = texture2D( map, vMapUv );
        ${clothOnly ? DISCARD_SHIRT : ""}
        vec3 cloth = sampledDiffuseColor.rgb * fabricTint * 1.35;
        diffuseColor.rgb *= mix( sampledDiffuseColor.rgb, cloth, sampledDiffuseColor.a );
        if ( !gl_FrontFacing ) diffuseColor.rgb *= 0.28;   // the lining
      `)
  }
  return material
}

// The fit map: the verdict colours where the texture marks cloth, and the real shirt, tie and buttons
// everywhere else.
function fitMapFabric({ map, aoMap }, { clothOnly = false } = {}) {
  const material = new THREE.MeshStandardMaterial({ map, aoMap, vertexColors: true, roughness: 0.8, side: THREE.DoubleSide })
  const inflate = { value: 0 }
  material.userData.inflate = inflate
  material.onBeforeCompile = shader => {
    standOut(shader, inflate)
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <color_fragment>", "")
      .replace("#include <map_fragment>", `
        vec4 sampledDiffuseColor = texture2D( map, vMapUv );
        ${clothOnly ? DISCARD_SHIRT : ""}
        diffuseColor.rgb *= mix( sampledDiffuseColor.rgb, vColor, sampledDiffuseColor.a );
        if ( !gl_FrontFacing ) diffuseColor.rgb *= 0.35;
      `)
  }
  return material
}

// Moves the cloth out along its normals by `inflate` metres, before skinning.
function standOut(shader, inflate) {
  shader.uniforms.uInflate = inflate
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nuniform float uInflate;")
    .replace("#include <begin_vertex>", "#include <begin_vertex>\ntransformed += normalize(objectNormal) * uInflate;")
}

// Shirt and tie pixels are light or coloured; cloth and buttons are dark and grey.
const DISCARD_SHIRT = `
  float shirtLight = dot( sampledDiffuseColor.rgb, vec3( 0.333 ) );
  float shirtTint = max( max( sampledDiffuseColor.r, sampledDiffuseColor.g ), sampledDiffuseColor.b ) -
                    min( min( sampledDiffuseColor.r, sampledDiffuseColor.g ), sampledDiffuseColor.b );
  if ( sampledDiffuseColor.a < 0.5 && ( shirtLight > 0.3 || shirtTint > 0.1 ) ) discard;`

// Colours a garment by the API's verdict for each part. Each vertex takes the colour of the part whose ease
// shape key moves it most, relative to that key's strongest movement.
function paintFitMap(mesh, checks, regions) {
  const status = Object.fromEntries(checks.map(c => [c.part, c.status]))
  const geometry = mesh.geometry
  const count = geometry.attributes.position.count
  const colors = new Float32Array(count * 3)
  const parts = Object.entries(regions).map(([key, part]) => {
    const deltas = geometry.morphAttributes.position[mesh.morphTargetDictionary[key]]
    let peak = 0
    for (let i = 0; deltas && i < count; i++) peak = Math.max(peak, Math.hypot(deltas.getX(i), deltas.getY(i), deltas.getZ(i)))
    return { deltas, peak, color: new THREE.Color(STATUS_COLORS[status[part] ?? "unknown"]) }
  })
  const neutral = new THREE.Color("#e4e2dd")
  const mixed = new THREE.Color()

  for (let i = 0; i < count; i++) {
    let total = 0
    mixed.setRGB(0, 0, 0)
    for (const { deltas, peak, color } of parts) {
      if (!deltas || peak === 0) continue
      const amount = Math.hypot(deltas.getX(i), deltas.getY(i), deltas.getZ(i)) / peak
      if (amount < 0.06) continue   // smoothing blends a trace of the movement into neighbouring parts
      const weight = amount ** 3
      mixed.r += color.r * weight
      mixed.g += color.g * weight
      mixed.b += color.b * weight
      total += weight
    }
    const out = total > 0 ? mixed.multiplyScalar(1 / total) : neutral
    colors.set([out.r, out.g, out.b], i * 3)
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3))
}

// The backdrop: lightest just above the middle, darkening to the edges.
// A still photo, with a faint film grain in its pixels (a render's perfectly smooth tones read as
// computer-made): a PNG Blob of the canvas.
// The canvas as just drawn, as a PNG Blob (copied at once: a 3D canvas is cleared after it's shown).
function canvasBlob(source) {
  const canvas = document.createElement("canvas")
  canvas.width = source.width
  canvas.height = source.height
  canvas.getContext("2d").drawImage(source, 0, 0)
  return new Promise((resolve, reject) => canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error("no picture"))), "image/png"))
}

function withGrain(source, amount = 3.2) {
  const canvas = document.createElement("canvas")
  canvas.width = source.width
  canvas.height = source.height
  const context = canvas.getContext("2d", { willReadFrequently: true })
  context.drawImage(source, 0, 0)
  const image = context.getImageData(0, 0, canvas.width, canvas.height), d = image.data
  // The same grain each time (a fixed seed), as on one roll of film; brightness only, so colours stay true.
  let seed = 7
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
  for (let i = 0; i < d.length; i += 4) {
    const g = (random() + random() + random() - 1.5) * amount
    d[i] = Math.min(255, Math.max(0, d[i] + g)); d[i + 1] = Math.min(255, Math.max(0, d[i + 1] + g)); d[i + 2] = Math.min(255, Math.max(0, d[i + 2] + g))
  }
  context.putImageData(image, 0, 0)
  return new Promise(resolve => canvas.toBlob(resolve, "image/png"))
}

// The contact shadow's shape: dark in an oval round the feet, fading out.
function contactShadow() {
  const size = 128, data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / (size - 1)) * 2 - 1, v = (y / (size - 1)) * 2 - 1
      const r = Math.hypot(u, v * 1.05)
      const a = Math.max(0, 1 - r) ** 2.2
      const i = 4 * (y * size + x)
      data[i] = data[i + 1] = data[i + 2] = Math.round(a * 255); data[i + 3] = 255
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  texture.needsUpdate = true
  return texture
}

// Khronos PBR Neutral, as three.js r170 applies it (tonemapping_pars_fragment), to linear RGB.
function neutral([r, g, b], exposure) {
  let c = [r * exposure, g * exposure, b * exposure]
  const x = Math.min(...c)
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04
  c = c.map(v => v - offset)
  const peak = Math.max(...c), start = 0.8 - 0.04
  if (peak < start) return c
  const d = 1 - start, top = 1 - (d * d) / (peak + d - start)
  c = c.map(v => (v * top) / peak)
  const k = 1 - 1 / (0.15 * (peak - top) + 1)
  return c.map(v => v + (top - v) * k)
}

// The colour (CSS hex) that comes out as `css` once tone-mapped: the inverse of `neutral`, found by steps.
export function untoned(css, exposure = 1) {
  const want = new THREE.Color(css).toArray() // linear
  let x = want.slice()
  for (let i = 0; i < 40; i++) {
    const got = neutral(x, exposure)
    x = x.map((v, j) => Math.min(1, Math.max(0, v + (want[j] - got[j]))))
  }
  return `#${new THREE.Color().fromArray(x).getHexString()}`
}

function backdrop(tone = css => css) {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 512
  const context = canvas.getContext("2d")
  const gradient = context.createRadialGradient(256, 215, 0, 256, 215, 400)
  gradient.addColorStop(0, tone(BACKDROP[0]))
  gradient.addColorStop(0.55, tone(BACKDROP[1]))
  gradient.addColorStop(1, tone(BACKDROP[2]))
  context.fillStyle = gradient
  context.fillRect(0, 0, 512, 512)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

// The daylight studio's backdrop: warm pale grey, a touch lighter high up, as a sweep is lit.
function daylightBackdrop(tone = css => css) {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 512
  const context = canvas.getContext("2d")
  const gradient = context.createLinearGradient(0, 0, 0, 512)
  gradient.addColorStop(0, tone("#e6e3de"))
  gradient.addColorStop(1, tone("#d5d1ca"))
  context.fillStyle = gradient
  context.fillRect(0, 0, 512, 512)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

// A round soft-edged spot, as a texture.
function glow() {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 128
  const context = canvas.getContext("2d")
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64)
  gradient.addColorStop(0, "rgba(255,255,255,0.55)")
  gradient.addColorStop(0.6, "rgba(255,255,255,0.18)")
  gradient.addColorStop(1, "rgba(255,255,255,0)")
  context.fillStyle = gradient
  context.fillRect(0, 0, 128, 128)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

// Adds a shape key to a mesh: offsets (x, y, z per vertex) from its base shape, as glTF's are.
function addShapeKey(mesh, name, offsets) {
  const geometry = mesh.geometry
  const count = geometry.attributes.position.count
  if (offsets.length !== count * 3 || !geometry.morphAttributes.position || !geometry.morphTargetsRelative) return false
  const attribute = new THREE.Float32BufferAttribute(offsets, 3)
  attribute.name = name
  geometry.morphAttributes.position.push(attribute)
  if (geometry.morphAttributes.normal) geometry.morphAttributes.normal.push(new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3))
  mesh.morphTargetDictionary[name] = geometry.morphAttributes.position.length - 1
  mesh.morphTargetInfluences.push(0)
  return true
}
