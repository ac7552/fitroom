import { Controller } from "@hotwired/stimulus"
import * as THREE from "three"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js"

// The home page's opening scene. In cold mist, Fitroom's jacket starts as a technical drawing (its seams,
// lapels and pocket edges, and a scatter of points); scrolling through the section sweeps a glowing line
// down from the collar that turns it into frosted cloth, then its measurements appear across it, numbered,
// like a tailor's chalk lines. The jacket never comes apart.
const MIST = 0xc4c8cf
const MEASURES = [
  { key: "shoulder", label: "Shoulder", value: "18" },
  { key: "chest", label: "Chest", value: "44½" },
  { key: "waist", label: "Waist", value: "39½" },
  { key: "sleeve", label: "Sleeve", value: "25" },
  { key: "length", label: "Length", value: "30", side: "left" }   // keeps clear of the sleeve's label
]

export default class extends Controller {
  static targets = ["canvas", "labels"]
  static values = { model: String }

  connect() {
    this.reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches
    this.pointer = new THREE.Vector2()
    this.progress = this.reducedMotion ? 1 : 0

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvasTarget, antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.toneMapping = THREE.NeutralToneMapping

    this.scene = new THREE.Scene()
    this.scene.fog = new THREE.Fog(MIST, 3.2, 9)
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    pmrem.dispose()
    const key = new THREE.DirectionalLight(0xf2f6ff, 1.4)
    key.position.set(-2, 3, 3)
    this.scene.add(key, new THREE.HemisphereLight(0xffffff, 0xb9bec8, 0.6))

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 40)
    this.camera.position.set(0, 0.05, 4.4)
    this.stage = new THREE.Group()
    this.scene.add(this.stage)
    this.dust = dust()
    this.web = constellation()
    this.scene.add(this.dust, this.web)

    this.resize()
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(this.canvasTarget.parentElement)
    this.visible = true
    this.intersectionObserver = new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting
      if (this.visible) this.start()
    })
    this.intersectionObserver.observe(this.element)
    this.onScroll = () => this.readScroll()
    addEventListener("scroll", this.onScroll, { passive: true })
    this.onVisibilityChange = () => { if (!document.hidden) this.start() }
    document.addEventListener("visibilitychange", this.onVisibilityChange)

    this.clock = new THREE.Clock()
    this.load()
    this.readScroll()
    this.start()
  }

  disconnect() {
    cancelAnimationFrame(this.frame)
    this.frame = null
    removeEventListener("scroll", this.onScroll)
    document.removeEventListener("visibilitychange", this.onVisibilityChange)
    this.resizeObserver?.disconnect()
    this.intersectionObserver?.disconnect()
    this.scene.traverse(object => {
      object.geometry?.dispose()
      object.material?.map?.dispose()
      object.material?.dispose()
    })
    this.scene.environment?.dispose()
    this.renderer.dispose()
  }

  move(event) {
    const rect = this.canvasTarget.getBoundingClientRect()
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
  }

  // Loading

  async load() {
    const gltf = await new GLTFLoader().loadAsync(this.modelValue)
    let source
    gltf.scene.updateMatrixWorld(true)
    gltf.scene.traverse(object => { if (object.isMesh && !source) source = object })
    if (!source) return

    const geometry = source.geometry.clone()
    geometry.applyMatrix4(source.matrixWorld)
    geometry.computeBoundingBox()
    const size = geometry.boundingBox.getSize(new THREE.Vector3())
    const center = geometry.boundingBox.getCenter(new THREE.Vector3())
    // Stand the jacket in the middle of the frame, about 1.6 units tall.
    const scale = 1.6 / size.y
    geometry.translate(-center.x, -center.y, -center.z)
    geometry.scale(scale, scale, scale)
    geometry.computeBoundingBox()

    const reveal = { value: geometry.boundingBox.max.y + 0.1 }
    this.reveal = reveal
    this.top = geometry.boundingBox.max.y + 0.06
    this.bottom = geometry.boundingBox.min.y - 0.06
    this.material = frostedCloth(reveal)
    this.stage.add(new THREE.Mesh(geometry, this.material))
    this.stage.add(technicalDrawing(geometry, reveal))

    this.lines = measurementLines(geometry)
    this.stage.add(this.lines.group)
    this.labelsTarget.innerHTML = MEASURES.map(m =>
      `<span class="hero-label" data-key="${m.key}"><i>+</i>${m.label} <b>${m.value}</b></span>`).join("")
    this.labelElements = Object.fromEntries([...this.labelsTarget.children].map(el => [el.dataset.key, el]))
    this.leftLabels = new Set(MEASURES.filter(m => m.side === "left").map(m => m.key))
    this.element.classList.add("is-loaded")
    if (this.reducedMotion) this.render()
  }

  // Scroll and loop

  readScroll() {
    if (this.reducedMotion) return
    const rect = this.element.getBoundingClientRect()
    const travel = Math.max(rect.height - innerHeight, 1)
    this.progress = THREE.MathUtils.clamp(-rect.top / travel, 0, 1)
    this.start()
  }

  resize() {
    const { clientWidth: width, clientHeight: height } = this.canvasTarget.parentElement
    if (!width || !height) return
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.position.z = width < height ? 4.4 * Math.min(height / width, 1.7) : 4.4
    this.camera.updateProjectionMatrix()
    // The mist starts just behind the jacket wherever the camera sits, so the jacket itself stays clear.
    this.scene.fog.near = this.camera.position.z - 0.6
    this.scene.fog.far = this.camera.position.z + 5
    if (this.reducedMotion) this.render()
  }

  start() {
    if (this.frame || !this.visible || document.hidden) return
    this.frame = requestAnimationFrame(this.tick)
  }

  tick = () => {
    this.render()
    this.frame = this.visible && !document.hidden && !this.reducedMotion ? requestAnimationFrame(this.tick) : null
  }

  render() {
    const time = this.clock.getElapsedTime()
    const revealed = THREE.MathUtils.smoothstep(this.progress, 0.04, 0.7)
    const measured = THREE.MathUtils.smoothstep(this.progress, 0.74, 0.92)

    if (this.reveal) this.reveal.value = THREE.MathUtils.lerp(this.top, this.bottom, revealed)
    // A slow quarter turn as you scroll, so the cloth catches the light.
    this.stage.rotation.y = -0.45 + this.progress * 0.45 + Math.sin(time * 0.15) * 0.05 + this.pointer.x * 0.18
    this.stage.rotation.x = -this.pointer.y * 0.06
    this.dust.material.userData.time.value = time
    this.web.material.opacity = 0.45 * (1 - measured * 0.5)
    this.web.rotation.y = time * 0.01

    if (this.lines) {
      for (const material of this.lines.materials) material.opacity = measured * 0.9
      this.stage.updateMatrixWorld()
      this.placeLabels(measured)
    }
    this.renderer.render(this.scene, this.camera)
  }

  placeLabels(opacity) {
    const rect = this.canvasTarget.getBoundingClientRect()
    const point = new THREE.Vector3()
    for (const [key, anchor] of Object.entries(this.lines.anchors)) {
      const el = this.labelElements[key]
      point.copy(anchor).applyMatrix4(this.stage.matrixWorld).project(this.camera)
      const x = ((point.x + 1) / 2) * rect.width
      const y = ((1 - point.y) / 2) * rect.height
      // Near the right edge, the label sits to the left of its point instead.
      const flip = this.leftLabels.has(key) || x > rect.width - 150 ? " translateX(calc(-100% - 20px))" : ""
      el.style.transform = `translate(${x}px, ${y}px)${flip}`
      el.style.opacity = opacity
    }
  }
}

// Pale, frosted cloth whose edges glow, like ice blocks in a snowfield. Above the reveal line it's cloth;
// below, it isn't drawn yet, and a bright band marks the line itself.
function frostedCloth(reveal) {
  const material = new THREE.MeshPhysicalMaterial({
    color: 0xc4c9d1, roughness: 0.72, sheen: 0.7, sheenColor: 0xe8ecf2, sheenRoughness: 0.45, side: THREE.DoubleSide
  })
  material.onBeforeCompile = shader => {
    shader.uniforms.uReveal = reveal
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vHeight;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvHeight = position.y;")
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uReveal;\nvarying float vHeight;")
      .replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\nif (vHeight < uReveal) discard;")
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        float rim = pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 2.5);
        float band = 1.0 - smoothstep(0.0, 0.07, vHeight - uReveal);
        totalEmissiveRadiance += vec3(0.86, 0.91, 1.0) * (rim * 0.45 + band * 1.6);`)
  }
  return material
}

// The jacket as a drawing: its creases and edges as fine lines, and a sprinkle of its points, shown only
// below the reveal line.
function technicalDrawing(geometry, reveal) {
  const below = material => {
    material.onBeforeCompile = shader => {
      shader.uniforms.uReveal = reveal
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying float vHeight;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvHeight = position.y;")
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform float uReveal;\nvarying float vHeight;")
        .replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\nif (vHeight >= uReveal) discard;")
    }
    return material
  }

  const group = new THREE.Group()
  group.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 10),
    below(new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, fog: false }))))

  const position = geometry.attributes.position
  const sample = []
  for (let i = 0; i < position.count; i += 7) sample.push(position.getX(i), position.getY(i), position.getZ(i))
  const points = new THREE.BufferGeometry()
  points.setAttribute("position", new THREE.Float32BufferAttribute(sample, 3))
  group.add(new THREE.Points(points,
    below(new THREE.PointsMaterial({ color: 0xffffff, size: 0.016, transparent: true, opacity: 1, map: softDot(), depthWrite: false, fog: false }))))
  return group
}

// Chalk lines across the finished jacket, with an anchor for each label.
function measurementLines(geometry) {
  const position = geometry.attributes.position
  const box = geometry.boundingBox
  const y = share => box.min.y + share * (box.max.y - box.min.y)
  const band = (height, spread = 0.02) => {
    let min = Infinity, max = -Infinity, front = -Infinity
    for (let i = 0; i < position.count; i++) {
      if (Math.abs(position.getY(i) - height) > spread) continue
      min = Math.min(min, position.getX(i))
      max = Math.max(max, position.getX(i))
      front = Math.max(front, position.getZ(i))
    }
    return { min, max, front }
  }
  const shoulder = band(y(0.93), 0.03), chest = band(y(0.68)), waist = band(y(0.45))

  // The lowest point on one sleeve is its cuff.
  const cuff = new THREE.Vector3(box.max.x, Infinity, 0)
  for (let i = 0; i < position.count; i++) {
    if (position.getX(i) > box.max.x * 0.55 && position.getY(i) < cuff.y) cuff.set(position.getX(i), position.getY(i), position.getZ(i))
  }

  const z = Math.max(chest.front, waist.front) + 0.04
  const v = (x, height) => new THREE.Vector3(x, height, z)
  const anchors = {
    shoulder: v(shoulder.max, y(0.93)),
    chest: v(chest.max, y(0.68)),
    waist: v(waist.max, y(0.45)),
    sleeve: v(cuff.x, cuff.y),
    length: v(0, box.min.y)
  }
  const points = [
    v(shoulder.min, y(0.93)), anchors.shoulder,
    v(chest.min, y(0.68)), anchors.chest,
    v(waist.min, y(0.45)), anchors.waist,
    anchors.shoulder, anchors.sleeve,
    v(0, box.max.y - 0.02), anchors.length
  ]

  const lineMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthTest: false })
  const dotMaterial = new THREE.PointsMaterial({ color: 0xffffff, size: 0.035, transparent: true, opacity: 0, depthTest: false })
  const group = new THREE.Group()
  group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), lineMaterial))
  group.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(points), dotMaterial))
  return { group, anchors, materials: [lineMaterial, dotMaterial] }
}

// Fine motes drifting down through the mist.
function dust() {
  const count = 700
  const random = seeded(3)
  const positions = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) positions.set([(random() - 0.5) * 9, (random() - 0.5) * 6, (random() - 0.5) * 6 - 1], i * 3)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3))
  const time = { value: 0 }
  const material = new THREE.PointsMaterial({ color: 0xffffff, size: 0.022, transparent: true, opacity: 0.8, depthWrite: false, map: softDot() })
  material.userData.time = time
  material.onBeforeCompile = shader => {
    shader.uniforms.uTime = time
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;")
      .replace("#include <begin_vertex>", `
        vec3 transformed = position;
        transformed.y = mod(position.y - uTime * 0.05 + 3.0, 6.0) - 3.0;
        transformed.x += sin(uTime * 0.2 + position.z * 2.0) * 0.08;`)
  }
  return new THREE.Points(geometry, material)
}

// A faint web of points and lines behind the jacket, as on a star chart.
function constellation() {
  const random = seeded(11)
  const stars = Array.from({ length: 70 }, () => new THREE.Vector3((random() - 0.5) * 10, (random() - 0.5) * 6, -1.5 - random() * 4))
  const points = []
  for (const a of stars) {
    const near = stars.filter(b => b !== a).sort((p, q) => a.distanceTo(p) - a.distanceTo(q)).slice(0, 2)
    for (const b of near) points.push(a, b)
  }
  return new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false, fog: false }))
}

function softDot() {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 32
  const context = canvas.getContext("2d")
  const gradient = context.createRadialGradient(16, 16, 0, 16, 16, 16)
  gradient.addColorStop(0, "rgba(255,255,255,1)")
  gradient.addColorStop(1, "rgba(255,255,255,0)")
  context.fillStyle = gradient
  context.fillRect(0, 0, 32, 32)
  return new THREE.CanvasTexture(canvas)
}

function seeded(seed) {
  return () => {
    seed = (seed * 16807) % 2147483647
    return (seed - 1) / 2147483646
  }
}
