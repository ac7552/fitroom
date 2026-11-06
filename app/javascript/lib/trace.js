// The path-traced still. Once nothing on screen moves and the clothes are on, the figure is drawn again by
// a path tracer (three-gpu-pathtracer, on the visitor's own GPU through WebGL2): light bouncing between a
// sleeve and the body, the colour of a jacket on the shirt under it, soft studio shadows, true translucency
// through thin cloth, from the same lights and studio map the live view uses. It accumulates a few samples a
// frame and is shown, denoised, over the live picture as soon as there are enough; as soon as anything
// moves, it's the live picture again (still.js drives it). The clothes go in as plain maps baked by their own
// shader (bake.js), the mannequin as it is.
//
// Not everywhere: it needs float render targets (WebGL2 with EXT_color_buffer_float), and on a GPU that takes
// too long over its first sample it gives up for the session; the live view and still.js's averaging stand in.
// ?trace=off turns it off.
import * as THREE from "three"
import { WebGLPathTracer, DenoiseMaterial, ShapedAreaLight } from "three-gpu-pathtracer"
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js"
import { BAKE_SIZE } from "lib/garments/bake"

export const TRACE_ON = typeof location === "undefined" || new URLSearchParams(location.search).get("trace") !== "off"
// Shown once this many samples are in (denoised, it reads clean from about here); done at SAMPLES_DONE.
const SAMPLES_SHOW = 8
const SAMPLES_DONE = 128
// Fully the traced picture from here (blended with the live one before).
const SAMPLES_SOLID = 48
// How long a frame may spend tracing (ms): the page stays responsive.
const BUDGET_MS = 14
// A first sample slower than this (ms) means a GPU that can't carry it: off for the session.
// (?tracepatience=ms raises it: the headless harness traces on a software GPU, slowly.)
const TOO_SLOW_MS = Number(typeof location !== "undefined" && new URLSearchParams(location.search).get("tracepatience")) || 1500
// The studio's lights as the tracer sees them: discs this far from the figure, this wide (m), so shadows have
// the soft edge the live view's filtered shadow maps give them.
const LIGHT_DISTANCE = 4.5, LIGHT_RADIUS = 0.9

export class TracedStill {
  constructor(stage) {
    this.stage = stage
    this.tracer = null
    this.scene = null
    this.key = null
    this.disabled = !TRACE_ON
    this.quad = null
    this.lights = []
    this.meshes = []
  }

  // Whether this browser can run it at all.
  get usable() {
    if (this.disabled) return false
    const renderer = this.stage.renderer
    if (!renderer.capabilities.isWebGL2) return false
    const gl = renderer.getContext()
    return Boolean(gl.getExtension("EXT_color_buffer_float"))
  }

  // Whether there's a still to trace now: the clothes on and settled, laid on and metered, nothing moving.
  ready() {
    const stage = this.stage
    if (!this.usable || !stage.settled || stage.cameraMove || !stage.studioMap) return false
    const slots = Object.values(stage.slots).filter(Boolean)
    if (!slots.length) return false
    for (const d of slots) {
      if (!d.top.done || d.posing || !d.shown || d.fade) return false
      if (d.redrapeState && !["done", "off"].includes(d.redrapeState)) return false
      if (d.top.item.photoCloth && (!d.metered || d.metering)) return false
    }
    return true
  }

  // What the still is of: when it changes, the tracer's scene is built again.
  contentKey() {
    const stage = this.stage
    const parts = [stage.sceneLook, stage.pose, stage.bodyType, JSON.stringify(stage.body ?? null), stage.view, stage.tone ?? ""]
    for (const [slot, d] of Object.entries(stage.slots)) {
      if (!d?.top) continue
      parts.push(slot, d.top.cloth.points.length, d.redrapeState ?? "", JSON.stringify(d.meterGain ?? null), d.top.geometry.attributes.position.version, d.top.geometry.attributes.aPhoto.version, d.top.printImage ? 1 : 0)
    }
    return parts.join("|")
  }

  // Builds (or rebuilds) the tracer's scene for what's on now. Returns false when it couldn't.
  prepare() {
    const stage = this.stage, renderer = stage.renderer
    const key = this.contentKey()
    if (this.tracer && this.key === key) return true
    try {
      if (!this.tracer) {
        this.tracer = new WebGLPathTracer(renderer)
        this.tracer.renderToCanvas = false
        this.tracer.tiles.set(2, 2)
        this.tracer.bounces = 4
        this.tracer.filterGlossyFactor = 1
        this.tracer.textureSize.set(BAKE_SIZE, BAKE_SIZE)
        this.tracer.renderScale = Math.min(1, 1 / renderer.getPixelRatio()) * (renderer.getPixelRatio() > 1 ? 1 : 1)
        this.tracer.dynamicLowRes = false
        this.quad = new FullScreenQuad(new DenoiseMaterial({ map: null, blending: THREE.NormalBlending, transparent: true }))
      }
      this.clear()
      const scene = this.scene = new THREE.Scene()
      scene.environment = stage.studioMap
      scene.environmentIntensity = stage.scene.environmentIntensity
      scene.background = null
      // The mannequin as it stands: a copy of its body, posed and shaped as now (its skin and shape keys
      // applied here, into plain positions: the tracer's own handling of skinned meshes doesn't take the
      // live skeleton), in its finish without its shader (its own material hides skin under the model's
      // clothes with a shader of its own, which the tracer can't read). The model's tailored jacket and coat, when
      // shown, the same way, with their materials' colour and map.
      stage.model.updateMatrixWorld(true)
      for (const object of Object.values(stage.meshes ?? {})) {
        if (!object?.isMesh || !shown(object)) continue
        if (object === stage.meshes.body && stage.view === "ghost") continue
        const geometry = posedGeometry(object)
        const source = object.material
        // (The mannequin's finish as the live view has it: the white form's satin, or the skin tone picked. A
        // fixed white here turned a skin-toned mannequin white once its traced picture came in.)
        const material = new THREE.MeshPhysicalMaterial(object === stage.meshes.body
          ? { color: source.color.clone(), roughness: source.roughness, clearcoat: source.clearcoat ?? 0, clearcoatRoughness: source.clearcoatRoughness ?? 0, sheen: source.sheen ?? 0, sheenColor: source.sheenColor?.clone(), metalness: 0, side: THREE.DoubleSide }
          : { color: source.color?.clone() ?? new THREE.Color(0x888888), map: source.map ?? null, roughness: source.roughness ?? 0.8, metalness: 0, side: THREE.DoubleSide })
        const copy = new THREE.Mesh(geometry, material)
        copy.userData.traced = true
        scene.add(copy)
        this.meshes.push(copy)
      }
      // Each garment as its baked maps on the fine mesh as drawn.
      for (const [slot, d] of Object.entries(stage.slots)) {
        if (!d?.top || !d.shown) continue
        const baked = d.top.bake(renderer, `${key}|${slot}`, BAKE_SIZE)
        for (const mesh of d.top.tracedMeshes(baked)) {
          mesh.userData.traced = true
          scene.add(mesh)
          this.meshes.push(mesh)
        }
      }
      // The studio's lights as soft discs.
      for (const light of [stage.key, stage.fill, stage.rim]) {
        if (!light?.visible || !(light.intensity > 0)) continue
        const target = light.target?.position ?? new THREE.Vector3(0, 1, 0)
        const direction = light.position.clone().sub(target).normalize()
        const disc = new ShapedAreaLight(light.color, 1, LIGHT_RADIUS * 2, LIGHT_RADIUS * 2)
        disc.isCircular = true
        // A directional light's intensity is the irradiance it gives; a disc of radiance L this far gives
        // L times its solid angle: L = E d^2 / (pi r^2).
        disc.intensity = (light.intensity * LIGHT_DISTANCE * LIGHT_DISTANCE) / (Math.PI * LIGHT_RADIUS * LIGHT_RADIUS)
        disc.position.copy(target).addScaledVector(direction, LIGHT_DISTANCE)
        disc.lookAt(target)
        scene.add(disc)
        this.lights.push(disc)
      }
      scene.updateMatrixWorld(true)
      this.tracer.setScene(scene, stage.camera)
      this.key = key
      return true
    } catch (error) {
      console.warn("[trace] off:", error)
      this.disable()
      return false
    }
  }

  clear() {
    // (Only the garments' copies own their geometry and materials; the mannequin's copies share the live ones.)
    for (const mesh of this.meshes) if (mesh.userData.traced) { mesh.geometry.dispose(); for (const m of [mesh.material].flat()) m.dispose() }
    this.meshes = []
    this.lights = []
    this.scene = null
  }

  disable() {
    this.disabled = true
    this.clear()
    try { this.tracer?.dispose?.() } catch { /* a tracer that never finished setting up */ }
    this.tracer = null
  }

  // Starts over (the camera moved, the content changed): the next step traces from nothing.
  reset() {
    if (this.tracer) { this.tracer.updateCamera(); this.tracer.reset() }
  }

  // Samples traced so far (the tracer's own count is of whole passes over its tiles).
  get samples() { return this.tracer ? this.tracer.samples : 0 }

  // One frame's worth of tracing, then the still drawn if there's enough. Returns true when it drew.
  step() {
    if (!this.prepare()) return false
    const tracer = this.tracer
    if (tracer.samples >= SAMPLES_DONE) return this.show()
    const began = performance.now()
    try {
      do tracer.renderSample()
      while (performance.now() - began < BUDGET_MS && tracer.samples < SAMPLES_DONE)
    } catch (error) {
      console.warn("[trace] off:", error)
      this.disable()
      return false
    }
    const took = performance.now() - began
    if (tracer.samples <= 1 && took > TOO_SLOW_MS) { console.info(`[trace] too slow here (${Math.round(took)} ms a sample): off`); this.disable(); return false }
    this.stage.start()
    return tracer.samples >= SAMPLES_SHOW ? this.show() : false
  }

  // The live picture, then the traced one over it (its background is clear, so the backdrop, the floor and
  // its shadow are the live view's), denoised and tone mapped as the live view is.
  show() {
    const { stage, tracer } = this
    stage.draw()
    const renderer = stage.renderer
    const material = this.quad.material
    material.map = tracer.target.texture
    material.uniforms.map.value = tracer.target.texture
    // Faded in over the live picture as the samples come: the live view's detail shows through until the
    // traced picture has enough samples to carry its own, and the lighting changes gradually rather than
    // snapping to a smoothed picture.
    material.opacity = Math.min(1, (tracer.samples - SAMPLES_SHOW + 1) / (SAMPLES_SOLID - SAMPLES_SHOW))
    // Denoised harder while there are few samples (its reach shrinks as they come in, down to a light touch
    // at SAMPLES_DONE: the picture's own detail must come through once it's there).
    // (The threshold is a difference in linear light; a lit cloth's values run to 1 and past it.)
    const t = Math.min(1, Math.max(0, (tracer.samples - SAMPLES_SHOW) / (SAMPLES_DONE - SAMPLES_SHOW)))
    // (The threshold is a difference in linear light: on dark cloth every seam is a small one, so it falls
    // fast with the samples, and the filter's radius with it.)
    material.sigma = 2.5 - 1.5 * t
    material.threshold = 0.25 * (1 - t) + 0.03
    material.kSigma = 1.5 - 0.5 * t
    const autoClear = renderer.autoClear
    renderer.autoClear = false
    renderer.setRenderTarget(null)
    this.quad.render(renderer)
    renderer.autoClear = autoClear
    return true
  }

  dispose() {
    this.clear()
    try { this.tracer?.dispose?.() } catch { /* as above */ }
    this.quad?.dispose()
  }
}

// Whether an object and everything above it is visible.
function shown(object) {
  for (let o = object; o; o = o.parent) if (!o.visible) return false
  return true
}

// A skinned, morphed mesh's geometry as it stands in the world: positions and normals with its shape keys
// and bones applied (three.js's own per-vertex evaluation), in world space, with its index.
function posedGeometry(mesh) {
  const source = mesh.geometry
  const count = source.attributes.position.count
  const position = new Float32Array(3 * count), normal = new Float32Array(3 * count)
  const v = new THREE.Vector3(), n = new THREE.Vector3()
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld)
  const hasNormal = Boolean(source.attributes.normal)
  for (let i = 0; i < count; i++) {
    mesh.getVertexPosition(i, v)
    v.applyMatrix4(mesh.matrixWorld)
    position[3 * i] = v.x; position[3 * i + 1] = v.y; position[3 * i + 2] = v.z
    if (hasNormal) {
      n.fromBufferAttribute(source.attributes.normal, i)
      if (mesh.isSkinnedMesh) {
        // (Skinned normals: through the same bone blend as the position, as three.js's shader does.)
        n.applyNormalMatrix(normalMatrix).normalize()
      } else n.applyNormalMatrix(normalMatrix).normalize()
      normal[3 * i] = n.x; normal[3 * i + 1] = n.y; normal[3 * i + 2] = n.z
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3))
  if (source.attributes.uv) geometry.setAttribute("uv", source.attributes.uv.clone())
  if (source.index) geometry.setIndex(source.index.clone())
  // Normals from the posed triangles (a skinned normal is bent by the pose; the position's is what we have).
  geometry.computeVertexNormals()
  return geometry
}
