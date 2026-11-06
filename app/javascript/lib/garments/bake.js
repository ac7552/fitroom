// Baking a draped garment's appearance into maps (see DrapedTop#bake): the garment is drawn by its own
// cloth shader with uBake set, which puts each point at its place in the atlas (fabric.js's aAtlas) instead
// of on screen and writes the cloth's colour (uBake 1) or its surface (2: normal and roughness) instead of a
// lit pixel. Texels no triangle covers are then filled from the nearest covered ones (dilate), so the maps'
// filtering and mips never reach into the void at a panel's edge; texels of hidden cloth (written with a
// coverage one step above nothing) stay, and cut the cloth out in the path tracer (alphaTest).
import * as THREE from "three"
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js"

// The maps' size (texels square): about 8 texels a cm of cloth on a typical top (2048 was tried: with two garments the tracer's texture array, which holds every map at this size, misread, every material taking another's map).
export const BAKE_SIZE = 1024
const DILATE_PASSES = 8
const BAKE_LAYER = 9

const DILATE = new THREE.ShaderMaterial({
  uniforms: { tMap: { value: null }, uStep: { value: new THREE.Vector2(1 / BAKE_SIZE, 1 / BAKE_SIZE) } },
  vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }",
  fragmentShader: `uniform sampler2D tMap; uniform vec2 uStep; varying vec2 vUv;
    void main() {
      vec4 c = texture2D( tMap, vUv );
      if ( c.a > 0.0 ) { gl_FragColor = c; return; }
      // Empty: the first neighbour that isn't, the four sides before the corners.
      vec2 d[8];
      d[0] = vec2( 1.0, 0.0 ); d[1] = vec2( -1.0, 0.0 ); d[2] = vec2( 0.0, 1.0 ); d[3] = vec2( 0.0, -1.0 );
      d[4] = vec2( 1.0, 1.0 ); d[5] = vec2( -1.0, 1.0 ); d[6] = vec2( 1.0, -1.0 ); d[7] = vec2( -1.0, -1.0 );
      for ( int k = 0; k < 8; k++ ) {
        vec4 s = texture2D( tMap, vUv + d[k] * uStep );
        if ( s.a > 0.0 ) { gl_FragColor = s; return; }
      }
      gl_FragColor = c;
    }`,
  depthTest: false, depthWrite: false
})
// The roughness map the path tracer reads (its green channel), from the surface map's alpha.
const ROUGHNESS = new THREE.ShaderMaterial({
  uniforms: { tMap: { value: null } },
  vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }",
  fragmentShader: "uniform sampler2D tMap; varying vec2 vUv; void main() { float r = texture2D( tMap, vUv ).a; gl_FragColor = vec4( r, r, r, 1.0 ); }",
  depthTest: false, depthWrite: false
})
const quad = new FullScreenQuad(DILATE)
const bakeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

// mesh: the garment's drawn mesh (its materials set to bake, below); materials: the ones to set; size: texels.
// Returns { albedo, surface, roughness }: WebGLRenderTargets (the albedo in sRGB, the rest linear).
export function bakeMaps(renderer, mesh, materials, size = BAKE_SIZE) {
  const make = (colorSpace, mips) => {
    const t = new THREE.WebGLRenderTarget(size, size, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, generateMipmaps: mips, minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter, magFilter: THREE.LinearFilter, colorSpace })
    return t
  }
  const albedo = make(THREE.SRGBColorSpace, true), surface = make(THREE.LinearSRGBColorSpace, true), roughness = make(THREE.LinearSRGBColorSpace, true)
  const scratch = make(THREE.NoColorSpace, false)
  // The mesh alone, on its own layer, in whatever scene it's in.
  const scene = mesh.parent ? rootOf(mesh) : mesh
  const layers = []
  mesh.traverse(o => { layers.push([o, o.layers.mask]); o.layers.set(BAKE_LAYER) })
  // (Only the cloth itself: its rim and fuzz have no place in the atlas.)
  const children = mesh.children.map(c => [c, c.visible])
  for (const [c] of children) c.visible = false
  bakeCamera.layers.set(BAKE_LAYER)
  const state = { target: renderer.getRenderTarget(), autoClear: renderer.autoClear, shadows: renderer.shadowMap.enabled, background: scene.background, clear: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(), toneMapping: renderer.toneMapping }
  const blending = materials.map(m => [m.blending, m.transparent, m.depthTest])
  try {
    renderer.shadowMap.enabled = false
    renderer.toneMapping = THREE.NoToneMapping
    if (scene.isScene) scene.background = null
    renderer.autoClear = true
    renderer.setClearColor(0x000000, 0)
    for (const m of materials) { m.blending = THREE.NoBlending; m.transparent = false; m.depthTest = false }
    for (const [pass, target] of [[1, albedo], [2, surface]]) {
      for (const m of materials) m.userData.uniforms.uBake.value = pass
      renderer.setRenderTarget(target)
      renderer.clear(true, true, true)
      renderer.render(scene, bakeCamera)
      dilate(renderer, target, scratch)
    }
    for (const m of materials) m.userData.uniforms.uBake.value = 0
    quad.material = ROUGHNESS
    ROUGHNESS.uniforms.tMap.value = surface.texture
    renderer.setRenderTarget(roughness)
    quad.render(renderer)
    quad.material = DILATE
  } finally {
    for (const [m, [b, t, d]] of materials.map((m, k) => [m, blending[k]])) { m.blending = b; m.transparent = t; m.depthTest = d }
    for (const [o, mask] of layers) o.layers.mask = mask
    for (const [c, v] of children) c.visible = v
    if (scene.isScene) scene.background = state.background
    renderer.shadowMap.enabled = state.shadows
    renderer.toneMapping = state.toneMapping
    renderer.autoClear = state.autoClear
    renderer.setClearColor(state.clear, state.alpha)
    renderer.setRenderTarget(state.target)
  }
  scratch.dispose()
  return { albedo, surface, roughness }
}

// A render target's picture as a plain texture (its pixels read back): the path tracer copies textures
// into its own array by drawing them, which goes wrong for a render target's texture and its colour space
// (it came out white speckle). Linear data stays linear; the albedo, baked in sRGB, is marked so. The
// caller disposes it.
export function plainTexture(renderer, target, colorSpace) {
  const { width, height } = target
  const pixels = new Uint8Array(4 * width * height)
  renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels)
  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.UnsignedByteType)
  texture.colorSpace = colorSpace
  texture.flipY = false
  texture.generateMipmaps = true
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
  texture.needsUpdate = true
  return texture
}

function rootOf(object) {
  let o = object
  while (o.parent) o = o.parent
  return o
}

// Empty texels filled from their neighbours, DILATE_PASSES texels out (ping-pong through `scratch`, ending
// back in `target`).
function dilate(renderer, target, scratch) {
  DILATE.uniforms.uStep.value.set(1 / target.width, 1 / target.height)
  let from = target, to = scratch
  for (let pass = 0; pass < DILATE_PASSES; pass++) {
    DILATE.uniforms.tMap.value = from.texture
    renderer.setRenderTarget(to)
    quad.render(renderer)
    ;[from, to] = [to, from]
  }
  if (from !== target) {
    // (An odd number of passes would leave it in scratch: copy back with one more, which changes nothing.)
    DILATE.uniforms.tMap.value = from.texture
    renderer.setRenderTarget(target)
    quad.render(renderer)
  }
}
