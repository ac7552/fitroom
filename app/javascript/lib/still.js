// The still picture: once nothing on screen is moving (the camera, the cloth, the pose), each frame is drawn
// again a fraction of a pixel to one side and with the key light moved a little round its place, and the
// frames are averaged. In about half a second the edges are smooth past what SMAA does, the contact shading's
// grain is gone, and the shadows have the soft edge a large studio light gives, as an offline render does;
// as soon as anything moves, it's the live picture again. The same averaging makes a sharper photo (photo()).
//
// It needs the effects (stage.js's addEffects: the composer's own last picture is what's averaged); without
// them, nothing changes. ?still=off turns it off.
import * as THREE from "three"
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js"

// How many frames are averaged, at most: past this the picture doesn't change, and it's shown as it is.
export const STILL_SAMPLES = 24
// How many frames nothing must move before the averaging starts (a camera easing to a stop moves less and
// less: starting at once, each restart would show).
const QUIET_FRAMES = 3
// How far round its place the key light is moved (m, across the light's direction): the size of the studio
// light the shadows look cast by.
const LIGHT_RADIUS = 0.35

export const STILL_ON = typeof location === "undefined" || new URLSearchParams(location.search).get("still") !== "off"

// The Halton sequence's k-th value in a base: points spread evenly over [0, 1) however many are taken.
function halton(k, base) {
  let f = 1, r = 0
  for (let i = k + 1; i > 0; i = Math.floor(i / base)) { f /= base; r += f * (i % base) }
  return r
}

const BLEND = new THREE.ShaderMaterial({
  uniforms: { tNew: { value: null }, tOld: { value: null }, weight: { value: 1 } },
  vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }",
  fragmentShader: `uniform sampler2D tNew; uniform sampler2D tOld; uniform float weight; varying vec2 vUv;
    void main() { gl_FragColor = mix( texture2D( tOld, vUv ), texture2D( tNew, vUv ), weight ); }`,
  depthTest: false, depthWrite: false
})
const COPY = new THREE.ShaderMaterial({
  uniforms: { tDiffuse: { value: null } },
  vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }",
  fragmentShader: "uniform sampler2D tDiffuse; varying vec2 vUv; void main() { gl_FragColor = texture2D( tDiffuse, vUv ); }",
  depthTest: false, depthWrite: false
})

export class StillFrames {
  // stage: the FittingStage (its renderer, scene, camera, key light and effects).
  constructor(stage) {
    this.stage = stage
    this.targets = null
    this.count = 0
    this.quiet = 0
    this.signature = null
    this.blend = new FullScreenQuad(BLEND)
    this.copy = new FullScreenQuad(COPY)
  }

  dispose() {
    for (const t of this.targets ?? []) t.dispose()
    this.targets = null
    this.blend.dispose()
    this.copy.dispose()
  }

  reset() { this.count = 0; this.quiet = 0 }

  // A number that changes whenever anything drawn moves: the camera, any mesh's points (a drape stepping),
  // the shape keys, the skeleton's bones, and what's shown.
  sign() {
    const { scene, camera } = this.stage
    let s = 0, k = 1
    const add = v => { s += v * k; k = (k * 1.618034) % 7.3 + 0.5 }
    for (const v of camera.matrixWorld.elements) add(v)
    for (const v of camera.projectionMatrix.elements) add(v)
    scene.traverseVisible(o => {
      if (!o.isMesh) return
      add(o.id)
      const g = o.geometry
      if (g?.attributes.position) add(g.attributes.position.version)
      if (o.morphTargetInfluences) for (const v of o.morphTargetInfluences) add(v)
      if (o.skeleton) { const b = o.skeleton.bones; for (let i = 0; i < b.length; i += 4) for (const v of b[i].matrixWorld.elements) add(v) }
      if (o.material?.opacity !== undefined) add(o.material.opacity)
      if (o.material?.version !== undefined) add(o.material.version)
    })
    return s
  }

  ensure(width, height) {
    if (this.targets && this.targets[0].width === width && this.targets[0].height === height) return
    for (const t of this.targets ?? []) t.dispose()
    const make = () => new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, depthBuffer: false })
    this.targets = [make(), make()]
    this.count = 0
  }

  // One jittered frame through the effects, into the composer's buffer: the camera moved by (jx, jy) pixels
  // and the key light round its place by `light` (a share of LIGHT_RADIUS, [x, y]). Returns that buffer.
  frame(k) {
    const { camera, effects, key } = this.stage
    const composer = effects.composer
    const size = composer.renderTarget1
    const w = size.width, h = size.height
    const jx = halton(k, 2) - 0.5, jy = halton(k, 3) - 0.5
    const view = camera.view?.enabled ? { ...camera.view } : null
    if (k > 0) {
      if (view) camera.setViewOffset(view.fullWidth, view.fullHeight, view.offsetX + (jx * view.width) / w, view.offsetY + (jy * view.height) / h, view.width, view.height)
      else camera.setViewOffset(w, h, jx, jy, w, h)
    }
    let place = null
    if (key && k > 0) {
      place = key.position.clone()
      // Round the light's place, across the way it shines (a disc, by the golden angle).
      const dir = key.position.clone().sub(key.target.position).normalize()
      const u = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize()
      const v = new THREE.Vector3().crossVectors(dir, u)
      const r = Math.sqrt((k + 0.5) / STILL_SAMPLES) * LIGHT_RADIUS * key.position.distanceTo(key.target.position) / 4.3
      const a = k * 2.39996
      key.position.addScaledVector(u, Math.cos(a) * r).addScaledVector(v, Math.sin(a) * r)
    }
    const toScreen = composer.renderToScreen
    composer.renderToScreen = false
    composer.render()
    composer.renderToScreen = toScreen
    if (view) camera.setViewOffset(view.fullWidth, view.fullHeight, view.offsetX, view.offsetY, view.width, view.height)
    else if (k > 0) camera.clearViewOffset()
    if (place) key.position.copy(place)
    return composer.readBuffer
  }

  // Adds frame `k` to the average (the first replaces it). Returns the target holding the average.
  add(k) {
    const { renderer, effects } = this.stage
    const size = effects.composer.renderTarget1
    this.ensure(size.width, size.height)
    const picture = this.frame(k)
    const [old, next] = this.targets
    BLEND.uniforms.tNew.value = picture.texture
    BLEND.uniforms.tOld.value = old.texture
    BLEND.uniforms.weight.value = 1 / (k + 1)
    renderer.setRenderTarget(next)
    this.blend.render(renderer)
    renderer.setRenderTarget(null)
    this.targets = [next, old]
    return next
  }

  show(target) {
    const { renderer } = this.stage
    COPY.uniforms.tDiffuse.value = target.texture
    renderer.setRenderTarget(null)
    this.copy.render(renderer)
  }

  // A frame of the live loop: returns false when the caller should draw as usual (something's moving, or
  // there are no effects), true when it drew the averaged picture.
  draw() {
    if (!STILL_ON || !this.stage.effects || this.stage.plainDraw) return false
    const now = this.sign()
    if (now !== this.signature) { this.signature = now; this.reset(); return false }
    if (++this.quiet < QUIET_FRAMES) return false
    if (this.count < STILL_SAMPLES) this.add(this.count++)
    this.show(this.targets[0])
    return true
  }

  // A still picture of what's there now, averaged over `samples` frames, on the canvas (for a photo).
  drawAveraged(samples = STILL_SAMPLES) {
    if (!this.stage.effects) return false
    let target = null
    for (let k = 0; k < samples; k++) target = this.add(k)
    this.show(target)
    this.reset()
    this.signature = null
    return true
  }
}
