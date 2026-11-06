// Fuzz: the fibres standing up off brushed and felted cloth (fleece, a wool coat, a lambswool knit), which
// make its edges soft where it turns away from you and catch the light there. Drawn the way real-time
// renderers draw fur and velvet: a few thin layers of the garment just above its surface, each a little
// further out, each showing only the fibres tall enough to reach it, faint, and fainter still where the cloth
// faces you (fibres are seen end on there, and the cloth's own surface shows through). All the layers are one
// instanced draw of the garment's own geometry, so it follows the drape as the cloth does.
import * as THREE from "three"

// Which surfaces (fabric.js's) have it: { length (m, the fibres' height), density (fibres a cm), opacity }.
export const FUZZY = {
  fleece: { length: 0.0016, density: 9, opacity: 0.38 },
  felt: { length: 0.0012, density: 11, opacity: 0.3 },
  rib: { length: 0.0007, density: 14, opacity: 0.2 }
}
// Layers: fewer on a phone (each is the garment drawn again, faintly).
const PHONE = typeof navigator !== "undefined" && navigator.maxTouchPoints > 0 && Math.min(screen.width, screen.height) < 820
export const LAYERS = PHONE ? 5 : 9
// ?fuzz=off draws none.
export const FUZZ_ON = typeof location === "undefined" || new URLSearchParams(location.search).get("fuzz") !== "off"

// geometry: the garment's (DrapedTop#makeGeometry: position, normal, uv in metres, aHide, aCover, aHole);
// surface: fabric.js's surface name; color: the cloth's. Returns the fuzz mesh, or null for a smooth cloth.
export function fuzzFor(geometry, surface, color) {
  const look = FUZZY[surface]
  if (!FUZZ_ON || !look) return null
  // One pass for both sides: three.js draws a transparent double-sided material in two passes, marking it
  // changed each time, which the still (still.js) took for movement and never settled; the shells are thin
  // and their layers overlap anyway, so one pass draws them as well.
  const material = new THREE.MeshLambertMaterial({ color: fibreColor(color), transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true })
  const uniforms = { uFuzz: { value: new THREE.Vector3(look.length, look.density, look.opacity) }, uLayers: { value: LAYERS } }
  material.userData.uniforms = uniforms
  material.customProgramCacheKey = () => "fuzz"
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
        attribute float aHide;
        attribute float aCover;
        attribute float aHole;
        uniform vec3 uFuzz;
        uniform float uLayers;
        varying float vLayer;
        varying float vGone;
        varying vec2 vPattern;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        // Layer k of uLayers, from just off the cloth (where its shader draws it) out to the fibres' tips.
        vLayer = ( float( gl_InstanceID ) + 1.0 ) / uLayers;
        transformed += normalize( objectNormal ) * ( 0.0015 + uFuzz.x * vLayer );
        vGone = max( max( aHide, aHole ), aCover > 0.5 ? 1.0 : -1.0 );
        vPattern = uv * 100.0;`)
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        uniform vec3 uFuzz;
        varying float vLayer;
        varying float vGone;
        varying vec2 vPattern;
        float fibreHash( vec2 p ) { return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ); }
        // A fibre's height where it stands: cells of the fibres' spacing, each a fibre of its own height and
        // a round cross-section, so a layer shows round dots of the fibres that reach it.
        float fibre( vec2 p ) {
          vec2 cell = floor( p ), f = fract( p ) - 0.5;
          vec2 jitter = vec2( fibreHash( cell ), fibreHash( cell + 17.0 ) ) - 0.5;
          float r = length( f - jitter * 0.5 );
          return fibreHash( cell + 3.7 ) * smoothstep( 0.5, 0.15, r );
        }`)
      .replace("#include <alphatest_fragment>", `#include <alphatest_fragment>
        if ( vGone > 0.0 ) discard;
        // Two scales of fibre, so the dots don't line up.
        float tall = max( fibre( vPattern * uFuzz.y ), 0.8 * fibre( vPattern * uFuzz.y * 1.73 + 5.1 ) );
        if ( tall < vLayer ) discard;
        // Seen edge on, the fibres stand against the light; seen face on, hardly at all.
        vec3 eye = normalize( vViewPosition );
        float graze = pow( 1.0 - abs( dot( normalize( vNormal ), eye ) ), 1.6 );
        diffuseColor.a *= uFuzz.z * ( 1.0 - vLayer * 0.7 ) * ( 0.03 + 0.97 * graze );`)
  }
  const mesh = new THREE.InstancedMesh(geometry, material, LAYERS)
  for (let k = 0; k < LAYERS; k++) mesh.setMatrixAt(k, new THREE.Matrix4())
  mesh.frustumCulled = false
  mesh.castShadow = false
  mesh.receiveShadow = true
  mesh.renderOrder = 2
  return mesh
}

// The fibres a little paler than the cloth's face (each catches light round its own sides).
export function fibreColor(color) {
  return new THREE.Color(color).offsetHSL(0, -0.04, 0.05)
}
