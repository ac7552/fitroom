import { Controller } from "@hotwired/stimulus"
import * as THREE from "three"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js"

// The home page's opening scene. In cold mist, Fitroom's jacket starts as a technical drawing (its seams,
// lapels and pocket edges, and a scatter of points); scrolling through the section sweeps a glowing line
// down from the collar that turns it into frosted cloth, then its measurements appear across it, numbered,
// each marked with a dot. The jacket never comes apart.
const MIST = 0x15171b   // the page's graphite, so the scene fades into it
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
    this.scene.add(key, new THREE.HemisphereLight(0xdfe5ef, 0x1b1e24, 0.55))

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 40)
    this.camera.position.set(0, 0.05, 4.4)
    this.stage = new THREE.Group()
    this.scene.add(this.stage)
    this.dust = dust()
    this.scene.add(this.dust)

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

// Slate cloth whose edges glow, like ice at night. Above the reveal line it's cloth;
// below, it isn't drawn yet, and a bright band marks the line itself.
function frostedCloth(reveal) {
  const material = new THREE.MeshPhysicalMaterial({
    color: 0x5b626d, roughness: 0.72, sheen: 0.7, sheenColor: 0xaab3c2, sheenRoughness: 0.45, side: THREE.DoubleSide
  })
  material.onBeforeCompile = shader => {
    shader.uniforms.uReveal = reveal
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vHeight;\nvarying vec3 vCloth;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvHeight = position.y;\nvCloth = position;")
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        uniform float uReveal;
        varying float vHeight;
        varying vec3 vCloth;
        // Soft folds, as a worn jacket has: long ones falling down the body and the sleeves, a few
        // pulling from under the arms, and bunching at the elbows and above the cuffs.
        float folds(vec3 p) {
          float side = smoothstep(0.26, 0.36, abs(p.x));
          float hang = sin(p.x * 34.0 + sin(p.y * 6.0 + p.x * 4.0) * 1.8) * 0.55 + sin(p.x * 21.0 - p.y * 5.0) * 0.3;
          float pull = sin((abs(p.x) * 0.8 + p.y) * 26.0) * smoothstep(0.35, 0.15, abs(p.y - 0.35)) * (1.0 - side);
          // At the elbow the folds run on a slant and break up, as a bent sleeve's do; above the cuff they're fewer.
          float twist = sin(p.y * 9.0 + p.x * 40.0) * 1.6 + sin(p.z * 30.0) * 0.8;
          float bunch = sin(p.y * 34.0 + p.x * 26.0 * sign(p.x) + twist) * side
            * (smoothstep(0.13, 0.0, abs(p.y + 0.05)) * (0.6 + 0.4 * sin(p.x * 50.0 + p.z * 20.0)) + smoothstep(0.08, 0.0, abs(p.y + 0.5)) * 0.5);
          return hang * (1.0 - side * 0.5) * smoothstep(0.75, 0.2, p.y) + pull * 0.5 + bunch * 0.45;
        }`)
      .replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\nif (vHeight < uReveal) discard;")
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
        {
          // The folds as a bump on the surface (as three.js's bump map does it).
          float h = folds(vCloth) * 0.009;
          vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
          vec3 r1 = cross(sy, normal), r2 = cross(normal, sx);
          float det = dot(sx, r1) * faceDirection;
          vec3 grad = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
          normal = normalize(abs(det) * normal - grad);
        }`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        float rim = pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 2.5);
        float band = 1.0 - smoothstep(0.0, 0.07, vHeight - uReveal);
        totalEmissiveRadiance += vec3(0.86, 0.91, 1.0) * (rim * 0.45 + band * 1.6);`)
  }
  return material
}

// The jacket as a drawing, shown only below the reveal line: a soft dark shape of it (so it reads as a solid
// thing, and hides the lines on its far side), its main edges as fine lines, and a light sprinkle of points.
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
  // The shape: dark, with its outline glowing where the cloth turns away from you, as a pen would draw it.
  const shape = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
    uniforms: { uReveal: reveal, uFill: { value: new THREE.Color(0x323843) }, uLine: { value: new THREE.Color(0xe9eef6) } },
    vertexShader: `
      varying float vHeight; varying vec3 vNormal; varying vec3 vView;
      void main() {
        vHeight = position.y;
        vec4 view = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = -view.xyz;
        gl_Position = projectionMatrix * view;
      }`,
    fragmentShader: `
      uniform float uReveal; uniform vec3 uFill; uniform vec3 uLine;
      varying float vHeight; varying vec3 vNormal; varying vec3 vView;
      void main() {
        if (vHeight >= uReveal) discard;
        float facing = abs(dot(normalize(vNormal), normalize(vView)));
        float outline = smoothstep(0.38, 0.12, facing);
        gl_FragColor = vec4(mix(uFill, uLine, outline * 0.85), 0.92);
        #include <colorspace_fragment>
      }`,
    transparent: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
  }))
  group.add(shape)
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 24),
    below(new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, fog: false })))
  edges.renderOrder = 1
  group.add(edges)

  const position = geometry.attributes.position
  const sample = []
  for (let i = 0; i < position.count; i += 13) sample.push(position.getX(i), position.getY(i), position.getZ(i))
  const points = new THREE.BufferGeometry()
  points.setAttribute("position", new THREE.Float32BufferAttribute(sample, 3))
  const dots = new THREE.Points(points,
    below(new THREE.PointsMaterial({ color: 0xffffff, size: 0.014, transparent: true, opacity: 0.6, map: softDot(), depthWrite: false, fog: false })))
  dots.renderOrder = 1
  group.add(dots)
  return group
}

// A small mark at the edge of the finished jacket for each label (no lines across it).
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
  // Each mark stands a little way out from the jacket, so it reads as a note beside it.
  const out = 0.14
  const anchors = {
    shoulder: v(shoulder.max + out * 0.8, y(0.93) + 0.04),
    chest: v(Math.max(chest.max, cuff.x) + out, y(0.68)),
    waist: v(Math.max(waist.max, cuff.x) + out, y(0.45)),
    sleeve: v(cuff.x + out * 0.6, cuff.y - 0.09),
    length: v(-0.12, box.min.y - 0.1)
  }
  const dotMaterial = new THREE.PointsMaterial({ color: 0xffffff, size: 0.035, transparent: true, opacity: 0, depthTest: false, map: softDot() })
  const group = new THREE.Group()
  group.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(Object.values(anchors)), dotMaterial))
  return { group, anchors, materials: [dotMaterial] }
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
