import * as THREE from "three"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { RGBELoader } from "three/addons/loaders/RGBELoader.js"
import { OrbitControls } from "three/addons/controls/OrbitControls.js"
import { drawnSize, fitBody, fitJacket, fitTrousers } from "lib/body_fit"

// The 3D fitting room, styled as a product shot: a white display mannequin in your shape (built by
// script/mannequin/build.py) wearing an outfit (a jacket, a coat over it, trousers) in the chosen sizes,
// in soft studio light on a pale seamless backdrop. Three views: on the mannequin, the clothes alone
// ("ghost"), and the fit map; and a few poses. Drag to turn it.
const MODELS = "/models"
const BACKDROP = 0xeceef1
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
// Jacket styles: "tailored" is the suit's jacket; the rest are the casual jacket with their own details
// (script/mannequin/casual_jacket.py) and collar (1, a stand; 2, a point collar).
export const STYLES = ["tailored", "zip", "bomber", "shirt"]
const COLLARS = { zip: 1, bomber: 1, shirt: 2 }
// The casual jacket is built long and cut to length; its hem is stitched (0), rib knit (1) or a waistband (2).
const HEMS = { zip: 0, bomber: 1, shirt: 2 }

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

export class FittingStage {
  constructor(canvas) {
    this.canvas = canvas
    this.view = "mannequin"
    this.pose = "standing"
    this.outfit = []
    this.lastEase = {}

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.toneMapping = THREE.NeutralToneMapping
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(BACKDROP)
    this.addLights()

    this.camera = new THREE.PerspectiveCamera(22, 1, 0.05, 50)
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.enablePan = false
    this.controls.enableZoom = false   // the page scrolls over it; zooming isn't needed to judge fit
    this.controls.minPolarAngle = 1.2
    this.controls.maxPolarAngle = 1.75

    this.resize()
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(canvas.parentElement)
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
    const [gltf, calibration, poses, studio] = await Promise.all([
      new GLTFLoader().loadAsync(`${MODELS}/mannequin.glb`),
      fetch(`${MODELS}/mannequin.json`).then(r => r.json()),
      fetch(`${MODELS}/poses.json`).then(r => r.json()),
      new RGBELoader().loadAsync(`${MODELS}/studio.hdr`)
    ])
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromEquirectangular(studio).texture
    this.scene.environmentIntensity = 0.85
    studio.dispose()
    pmrem.dispose()

    this.calibration = calibration
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
    // A coat is the jacket again, on its own copy of the geometry (it gets its own fit-map colours),
    // drawn a little bigger so it always sits outside the jacket.
    if (!this.meshes.casual) throw new Error("mannequin.glb has no casual jacket; rebuild the model")
    const coat = this.meshes.jacket.clone()
    coat.geometry = this.meshes.jacket.geometry.clone()
    coat.name = "coat"
    this.meshes.jacket.parent.add(coat)
    this.meshes.coat = coat

    this.rest = new Map()
    this.model.traverse(object => { if (object.isBone) this.rest.set(object, object.quaternion.clone()) })

    await this.dress(calibration.textures)
    this.addEggHead(calibration.head)
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
    this.fitted = fitBody(this.calibration, body)
    this.model.scale.setScalar(this.fitted.scale)
    for (const mesh of Object.values(this.meshes)) applyInfluences(mesh, this.fitted.influences)
    this.redraw()
    return this.fitted.limited
  }

  // items: [{ kind: "jacket" | "coat" | "trousers", size (cm), checks (the API's), color, fabric }]
  setOutfit(items) {
    this.outfit = items
    this.redraw()
  }

  // "mannequin", "ghost" (the clothes alone) or "fit" (the fit map, on the mannequin).
  setView(view) {
    this.view = view
    this.redraw()
  }

  setPose(name) {
    this.pose = name
    this.applyPose()
  }

  redraw() {
    if (!this.meshes || !this.fitted) return
    const worn = Object.fromEntries(this.outfit.map(item => [item.kind, item]))

    const casual = worn.jacket && casualStyle(worn.jacket)
    const body = this.meshes.body
    body.visible = this.view !== "ghost"
    body.material.userData.hideJacket.value = (worn.jacket && !casual) || worn.coat ? 1 : 0
    body.material.userData.hideCasual.value = casual ? 1 : 0
    body.material.userData.hideTrousers.value = worn.trousers ? 1 : 0

    let under = null
    if (worn.jacket) {
      const layer = casual ? "casual" : "jacket"
      const ease = fitJacket(this.calibration, this.fitted, worn.jacket.size, { layer })
      this.dressMesh(layer, worn.jacket, ease, "jacket")
      under = drawnSize(this.calibration, this.fitted, ease, layer)
    }
    if (worn.coat) {
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
    if (worn.trousers) this.dressMesh("trousers", worn.trousers, fitTrousers(this.calibration, this.fitted, worn.trousers.size))
    this.meshes.jacket.visible = Boolean(worn.jacket && !casual)
    this.meshes.casual.visible = Boolean(casual)
    for (const kind of ["coat", "trousers"]) this.meshes[kind].visible = Boolean(worn[kind])
  }

  // What a studio render needs to reproduce the screen: the body's shape keys and scale, each item's
  // size adjustments and colour, and the pose.
  snapshot() {
    if (!this.fitted) return null
    return {
      scale: this.fitted.scale,
      body: this.fitted.influences,
      pose: this.pose,
      items: this.outfit.map(item => ({
        kind: item.kind, style: item.kind === "jacket" ? (item.style ?? "tailored") : undefined,
        color: item.color, fabric: item.fabric ?? "wool", ease: this.lastEase[item.kind] ?? {}
      }))
    }
  }

  // kind: the mesh ("jacket", "casual", "coat" or "trousers"); slot: the outfit's ("jacket" for either jacket).
  dressMesh(kind, item, ease, slot = kind) {
    this.lastEase[slot] = ease
    const mesh = this.meshes[kind]
    const keys = EASE_KEYS[kind === "trousers" ? "trousers" : "jacket"]
    applyInfluences(mesh, Object.fromEntries(keys.map(key => [key, ease[key] ?? 0])))
    const materials = this.materials[kind]
    const fabric = FABRICS[item.fabric] ?? FABRICS.wool
    if (kind === "casual") {
      const style = casualStyle(item)
      const { cloth, fitMap } = materials
      // Length is a cut, not a stretch: a longer jacket has more cloth at the hem, not a lower waist.
      const length = drawnSize(this.calibration, this.fitted, ease, "casual").length
      applyInfluences(mesh, { "ease-length": 0 })
      cloth.userData.length.value = fitMap.userData.length.value = Math.min(Math.max(length, 50), 80) / 100
      cloth.userData.hem.value = HEMS[style]
      cloth.userData.details.value = this.details[style]
      cloth.userData.collar.value = fitMap.userData.collar.value = COLLARS[style]
      cloth.userData.thread.value.set(fabric.thread === "tone" ? item.color : fabric.thread)
      if (fabric.thread === "tone") cloth.userData.thread.value.offsetHSL(0, 0, 0.06)
      cloth.userData.metal.value.set(fabric.metal)
    }
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

    const floor = new THREE.Mesh(new THREE.CircleGeometry(4, 64), new THREE.ShadowMaterial({ opacity: 0.16 }))
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = true
    this.scene.add(floor)
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
    const [suit, ao, woolNormal, woolRoughness, ...details] = await Promise.all([
      load(textures.suit),
      load(textures.suit_ao, { color: false }),
      load("textures/wool_normal.jpg", { color: false, repeat: WOOL_REPEAT }),
      load("textures/wool_roughness.jpg", { color: false, repeat: WOOL_REPEAT }),
      ...CASUAL_STYLES.map(style => load(textures[`casual_${style}`], { color: false }))
    ])
    const maps = { map: suit, aoMap: ao, normalMap: woolNormal, roughnessMap: woolRoughness }
    this.details = Object.fromEntries(CASUAL_STYLES.map((style, i) => [style, details[i]]))

    this.meshes.body.material = mannequinMaterial()
    this.materials = {
      jacket: { cloth: tintableFabric(maps), fitMap: fitMapFabric(maps) },
      casual: { cloth: casualFabric(this.details.zip, maps), fitMap: casualFitMap() },
      coat: { cloth: tintableFabric(maps, { clothOnly: true }), fitMap: fitMapFabric(maps, { clothOnly: true }) },
      trousers: { cloth: tintableFabric(maps), fitMap: fitMapFabric(maps) }
    }
    for (const kind of ["jacket", "casual", "coat", "trousers"]) this.meshes[kind].material = this.materials[kind].cloth
  }

  // A faceless egg in place of MakeHuman's head, as on a shop's display mannequin. It hangs from the head
  // bone, so it follows the pose and the mannequin's height.
  addEggHead({ centre, radii }) {
    const egg = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), this.meshes.body.material.userData.plain)
    egg.scale.set(radii[0], radii[1] * 1.04, radii[2] * 0.96)
    egg.position.fromArray(centre)
    egg.castShadow = egg.receiveShadow = true
    this.model.add(egg)
    this.model.updateMatrixWorld(true)
    this.model.getObjectByName("head")?.attach(egg)
  }

  applyPose() {
    if (!this.model) return
    for (const [bone, quaternion] of this.rest) bone.quaternion.copy(quaternion)
    const axes = { x: new THREE.Vector3(1, 0, 0), z: new THREE.Vector3(0, 0, 1) }
    const pose = this.poses.poses[this.pose] ?? this.poses.poses.standing
    for (const [name, axis, angle] of pose.turns) {
      const bone = this.model.getObjectByName(name)
      if (!bone) continue
      // Turn about a world axis, expressed in the bone's parent space.
      this.model.updateMatrixWorld(true)
      const local = axes[axis].clone().applyQuaternion(bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert())
      bone.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(local, angle))
    }
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

  // Head to toe, a little from the side, like a lookbook photo.
  frame() {
    const H = this.calibration.body.height / 100
    // Tall phone screens have the controls stacked over the picture, so leave more room around the figure.
    const margin = this.camera.aspect < 0.8 ? 0.8 : 0.62
    const distance = (H * margin) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))
    this.controls.target.set(0, H * 0.52, 0)
    this.camera.position.set(Math.sin(0.25) * distance, H * 0.56, Math.cos(0.25) * distance)
    this.controls.update()
  }

  resize() {
    const { clientWidth: width, clientHeight: height } = this.canvas.parentElement
    if (!width || !height) return
    this.renderer.setSize(width, height, false)
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
    this.renderer.render(this.scene, this.camera)
    this.frameId = this.visible ? requestAnimationFrame(this.tick) : null
  }

  dispose() {
    cancelAnimationFrame(this.frameId)
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
    this.renderer.dispose()
  }
}

const CASUAL_STYLES = STYLES.filter(style => style !== "tailored")

// The casual style to draw a jacket in, or null for the suit's tailored jacket.
function casualStyle(item) {
  return CASUAL_STYLES.includes(item.style) ? item.style : null
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
  const finish = { color: 0xf4f2ee, roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.35 }
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
        attribute float _head;
        varying float vCovered;
        uniform float uHideJacket;
        uniform float uHideCasual;
        uniform float uHideTrousers;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        vCovered = max(max(max(_cover_jacket * uHideJacket, _cover_casual * uHideCasual), _cover_trousers * uHideTrousers), _head);`)
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vCovered;")
      .replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\nif (vCovered > 0.5) discard;")
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

// The casual jacket: plain cloth in the item's colour with the style's painted details (red: seams and
// shadows, green: stitching, blue: the zip and buttons), the weave, a dark lining, and only its own collar.
function casualFabric(details, { normalMap, roughnessMap }) {
  const uniforms = {
    tint: { value: new THREE.Color("#2a3552") }, thread: { value: new THREE.Color("#c58b45") },
    metal: { value: new THREE.Color("#8d8f93") }, details: { value: details }, collar: { value: 1 },
    length: { value: 0.64 }, hem: { value: 0 }
  }
  const material = new THREE.MeshPhysicalMaterial({
    normalMap, normalScale: new THREE.Vector2(0.35, 0.35), roughnessMap,
    roughness: 0.92, sheen: 0.35, sheenRoughness: 0.6, side: THREE.DoubleSide
  })
  material.userData = { ...uniforms, inflate: { value: 0 } }
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, {
      fabricTint: uniforms.tint, threadColor: uniforms.thread, metalColor: uniforms.metal,
      detailMap: uniforms.details, uCollar: uniforms.collar, uLength: uniforms.length, uHem: uniforms.hem
    })
    standOut(shader, material.userData.inflate)
    keepCollar(shader)
    cutToLength(shader)
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vDetailUv;")
      .replace("#include <uv_vertex>", "#include <uv_vertex>\nvDetailUv = uv;")
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        uniform vec3 fabricTint;
        uniform vec3 threadColor;
        uniform vec3 metalColor;
        uniform sampler2D detailMap;
        uniform int uHem;
        varying vec2 vDetailUv;
        float seamLine( float value, float at, float halfWidth, float px ) {
          return smoothstep( halfWidth + px, halfWidth - px, abs( value - at ) );
        }`)
      .replace("#include <map_fragment>", `
        vec3 detail = texture2D( detailMap, vDetailUv ).rgb;
        ${HEM_DETAILS}
        diffuseColor.rgb = fabricTint * ( 1.0 - 0.6 * detail.r );
        diffuseColor.rgb = mix( diffuseColor.rgb, threadColor, detail.g );
        diffuseColor.rgb = mix( diffuseColor.rgb, metalColor, detail.b );
        if ( !gl_FrontFacing ) diffuseColor.rgb *= 0.28;   // the lining
      `)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
        roughnessFactor = mix( roughnessFactor, 0.3, detail.b );`)
  }
  return material
}

// The casual jacket's fit map: verdict colours, and only its own collar.
function casualFitMap() {
  const collar = { value: 1 }
  const length = { value: 0.64 }
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide })
  material.userData = { collar, length, inflate: { value: 0 } }
  material.onBeforeCompile = shader => {
    shader.uniforms.uCollar = collar
    shader.uniforms.uLength = length
    keepCollar(shader)
    cutToLength(shader)
    shader.fragmentShader = shader.fragmentShader.replace("#include <color_fragment>", `#include <color_fragment>
      if ( !gl_FrontFacing ) diffuseColor.rgb *= 0.35;`)
  }
  return material
}

// The casual jacket has both a stand collar and a point collar (its _collar attribute is 1 and 2 on them);
// a style shows only its own.
function keepCollar(shader) {
  shader.uniforms.uCollar ??= { value: 1 }
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nattribute float _collar;\nvarying float vCollar;")
    .replace("#include <begin_vertex>", "#include <begin_vertex>\nvCollar = _collar;")
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", "#include <common>\nuniform float uCollar;\nvarying float vCollar;")
    .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>
      if ( vCollar > 0.5 && abs( vCollar - uCollar ) > 0.5 ) discard;`)
}

// Cuts the casual jacket's body to uLength (metres below the collar seam at the back; its _drop attribute
// says how far below it each vertex is, and is 0 on the sleeves and collar).
function cutToLength(shader) {
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nattribute float _drop;\nvarying float vDrop;")
    .replace("#include <begin_vertex>", "#include <begin_vertex>\nvDrop = _drop;")
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", "#include <common>\nuniform float uLength;\nvarying float vDrop;")
    .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>
      if ( vDrop > uLength ) discard;`)
}

// The hem's details, drawn where the cut falls (the texture has everything else; see
// paint_casual_details in script/mannequin/casual_jacket.py): stitching 2.5 cm up, a rib-knit band, or a
// waistband with its buttons. x is metres across the front or back, from its middle.
const HEM_DETAILS = `
  if ( vDrop > 0.0 ) {
    float above = uLength - vDrop;
    float x = ( vDetailUv.x < 0.5 ? vDetailUv.x - 0.25 : 0.75 - vDetailUv.x ) * 1.5;
    float px = fwidth( above ) + 1e-5;
    float stitch = step( fract( x / 0.0042 ), 0.62 );
    if ( uHem == 0 ) {
      detail.g = max( detail.g, seamLine( above, 0.025, 0.00055, px ) * stitch );
    } else if ( uHem == 1 ) {
      if ( above < 0.065 ) detail = vec3( max( detail.r, 0.32 * ( cos( x / 0.0045 * 6.2832 ) * 0.5 + 0.5 ) ), 0.0, detail.b );
      detail.r = max( detail.r, 0.55 * seamLine( above, 0.065, 0.0011, px ) );
    } else {
      if ( above < 0.045 ) detail = vec3( 0.0 );
      detail.r = max( detail.r, 0.55 * seamLine( above, 0.045, 0.0011, px ) );
      detail.g = max( detail.g, max( seamLine( above, 0.04, 0.00055, px ), seamLine( above, 0.005, 0.00055, px ) ) * stitch );
      if ( vDetailUv.x < 0.5 ) {
        for ( int i = 0; i < 3; i++ ) {
          float bx = i == 0 ? 0.0 : ( i == 1 ? 0.21 : -0.21 );
          float radius = i == 0 ? 0.0075 : 0.0065;
          float d = length( vec2( x - bx, above - 0.022 ) );
          float pd = fwidth( d ) + 1e-5;
          detail.b = max( detail.b, smoothstep( radius + pd, radius - pd, d ) );
          detail.r = max( detail.r, 0.6 * seamLine( d, radius * 0.72, 0.0006, pd ) );
        }
      }
    }
  }`

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
