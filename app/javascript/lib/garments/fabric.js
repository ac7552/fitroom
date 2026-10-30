import * as THREE from "three"
import { BORDER, DEPTH_BIAS, FACING, LIGHT } from "lib/projection"

// How draped cloth looks: each kind of cloth's surface (a normal map drawn here, tiling across the cloth at its
// real size), how it catches the light, and the seams, stitching, zips and buttons drawn onto it from where
// each point sits on its pattern piece. The garment's geometry (see dress.js) carries, per point:
//   uv       where it is on its pattern piece, in metres (so textures tile at a real size)
//   aEdge    how far it is from the edge of its piece (cm): seams show as a soft groove along it
//   aHem     how far it is from a hem or other free edge (cm): hems are stitched a little way up
//   aPiece   which piece it's on (1 the front, 2 the back, 3 the left sleeve, 4 the right, 0 the rest)
//   aShade   how open to the room it is (1) or tucked into a fold or under the hood (less): ambient light
//            reaching it, worked out from the drape
//   aHide    above 0 where it isn't drawn: a tucked top inside the pants (how far inside, m)
//   aHole    above 0 inside a cut-out (cm in from its edge): not drawn
//   aStrain  how squeezed the cloth is (0 to 1; see DrapedTop#markStrain): its surface shows deeper there
//   aCover   1 where a garment worn over this one covers it, though the drape left this one a hair outside
//            it (it would show through): not drawn
//   aSheer   1 where the cloth is sheer (drawn see-through, as much as uSheer says), 0 elsewhere
//   aPhoto   where it is in the garment's shop photo, laid on pants and skirts ([u, v, which]: which 1 the
//            photo, 2 its softened copy, 0 neither; see photo_map.js)
//   aDown    how far down the garment it is (cm below the shoulders, as the shop photo shows it laid flat;
//            see dress.js's heightsDown): a striped print is laid on every piece by this
//   aAcross  how far across the garment it is (cm from the front's middle; see photo_map.js's widthsAcross):
//            a vertically striped print is laid on every piece by this

// Each cloth: the texture, its tile (metres of cloth one repeat covers), and its finish.
const CLOTHS = {
  jersey: { surface: "knit", tile: 0.02, roughness: 0.92, sheen: 0.45, sheenRoughness: 0.7, normal: 0.28 },
  rib: { surface: "rib", tile: 0.02, roughness: 0.92, sheen: 0.45, sheenRoughness: 0.7, normal: 0.9 },
  fleece: { surface: "fleece", tile: 0.025, roughness: 0.97, sheen: 0.75, sheenRoughness: 0.85, normal: 0.4 },
  twill: { surface: "twill", tile: 0.012, roughness: 0.88, sheen: 0.2, sheenRoughness: 0.5, normal: 0.5 },
  shell: { surface: "ripstop", tile: 0.03, roughness: 0.42, sheen: 0.1, sheenRoughness: 0.3, normal: 0.25, clearcoat: 0.25 },
  // Nylon pants (track pants, technical trousers): a tight plain weave, matte, with only a faint sheen along
  // the folds; nothing like a jacket's glossy shell.
  matte: { surface: "plain", tile: 0.006, roughness: 0.82, sheen: 0.16, sheenRoughness: 0.55, normal: 0.12 },
  wool: { surface: "felt", tile: 0.03, roughness: 0.95, sheen: 0.4, sheenRoughness: 0.6, normal: 0.35 },
  // Leather: a fine grain, a soft sheen, nothing like a plastic or vinyl shine (a glossy coat on draped
  // cloth catches every small fold).
  leather: { surface: "grain", tile: 0.04, roughness: 0.74, sheen: 0.12, sheenRoughness: 0.55, normal: 0.3, clearcoat: 0.03, clearcoatRoughness: 0.8 },
  // Silk, satin, chiffon: smooth, with a strong soft sheen along the folds.
  silk: { surface: "smooth", tile: 0.05, roughness: 0.4, sheen: 1, sheenRoughness: 0.3, normal: 0.06 },
  // Stretch (nylon and elastane): a very fine knit, a little sheen.
  stretch: { surface: "fine", tile: 0.012, roughness: 0.68, sheen: 0.35, sheenRoughness: 0.45, normal: 0.12 },
  // Suiting and other cloths that hold their shape: a tight, matte weave with a faint sheen.
  structured: { surface: "plain", tile: 0.008, roughness: 0.8, sheen: 0.22, sheenRoughness: 0.5, normal: 0.14 },
  // A puffer's nylon shell: smooth, with a soft gloss on each baffle (the quilting itself is drawn by the
  // shader, see QUILT).
  puffer: { surface: "plain", tile: 0.004, roughness: 0.46, sheen: 0.22, sheenRoughness: 0.4, normal: 0.06, clearcoat: 0.3, clearcoatRoughness: 0.5 }
}
// A puffer's quilting: baffles round the body and the sleeves, SPACING cm apart (by aDown, so they meet at the
// side seams), each puffed out up to LOFT m between its stitched seams, and a little darker in those seams.
export const QUILT = { spacing: 11, loft: 0.008, seam: 0.3 }
// Creases (see the cloth shader): how much a fold's shade (1 - aShade) counts beside the cloth's squeeze, and
// how much darker and rougher the cloth is at a full crease. Kept low: dark creases read as dirt.
const CREASE = { fold: 0.6, dark: 0.14, rough: 0.3 }
// Which pattern fabric (pattern.js) is which cloth here; "denim" and "cotton" are what shops call them.
const ALIASES = { cotton: "jersey", denim: "twill", nylon: "shell", leather: "shell" }

const SIZE = 256
const textures = new Map()
const BLANK = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat)
BLANK.needsUpdate = true
export const BLANK_TEXTURE = BLANK

// A picture laid onto the cloth from the camera that took it (see stage.js#wearPhoto and lib/projection.js):
// the AI's picture of this very view, with the stores' clothes painted on. Every point is projected by the
// capture camera's view-projection (uCaptureVP) into the picture; it takes the picture's colour where it faces
// that camera, is inside the frame and is what the camera saw (its depth against uCaptureDepth, the depth the
// camera recorded, as a shadow map is read). The picture has the scene's light baked in, and the cloth is lit
// again here, so the light is taken out first (uProjectedMode):
//   0  the picture as it is (lit twice; to compare)
//   1  the picture divided by a blurred copy of itself (uProjectedFlat), so only its texture stays, on the
//      cloth's own colour (the way local_studio.js#keepDetails keeps a repaint's light): loses its colours
//   2  the picture divided by the page's light there: the page's own photo of the same view (uProjectedBase)
//      over the cloth's own colour at this point (as that photo was drawn from it). What the AI changed stays
//      (its colours, prints, zip, light over dark), the page's light is taken out to be put back by the scene,
//      and where the AI changed nothing the cloth is exactly the page's. The one used (see projection.js)
// Where the picture can't reach (the back, the sides), the cloth is the page's own, tinted toward the
// picture's overall colour shift (uProjectedTint) near where the picture stops, so there's no line.
export function projectionUniforms() {
  return {
    uProjected: { value: BLANK },
    uProjectedFlat: { value: BLANK },
    uProjectedBase: { value: BLANK },
    uProjectedOn: { value: 0 },
    uProjectedMode: { value: 2 },
    uProjectedTint: { value: new THREE.Vector3(1, 1, 1) },
    uCaptureVP: { value: new THREE.Matrix4() },
    uCaptureDepth: { value: BLANK },
    uCaptureDepthOn: { value: 0 },
    uCaptureNearFar: { value: new THREE.Vector2(0.1, 10) },
    uCaptureSize: { value: new THREE.Vector2(1, 1) },
    uCaptureDir: { value: new THREE.Vector3(0, 0, -1) }
  }
}

export const PROJECTION = {
  vertexDeclare: `
    varying vec3 vProjWorldPos;
    varying vec3 vProjWorldNormal;`,
  // After project_vertex: `transformed` is the point in object space (skinned, morphed, stood off) and
  // transformedNormal its normal in view space.
  vertexAssign: `
    vProjWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
    vProjWorldNormal = inverseTransformDirection( transformedNormal, viewMatrix );`,
  fragmentDeclare: `
    #define PROJ_BORDER ${BORDER.toFixed(3)}
    #define PROJ_FACING_FROM ${FACING.from.toFixed(3)}
    #define PROJ_FACING_TO ${FACING.to.toFixed(3)}
    #define PROJ_BIAS ${DEPTH_BIAS.toFixed(4)}
    #define PROJ_DARK ${LIGHT.dark.toFixed(3)}
    #define PROJ_LIGHT_MIN ${LIGHT.min.toFixed(3)}
    #define PROJ_LIGHT_MAX ${LIGHT.max.toFixed(3)}
    const vec3 PROJ_LUMA = vec3( 0.2126, 0.7152, 0.0722 );
    uniform sampler2D uProjected;
    uniform sampler2D uProjectedFlat;
    uniform sampler2D uProjectedBase;
    uniform float uProjectedOn;
    uniform int uProjectedMode;
    uniform vec3 uProjectedTint;
    uniform mat4 uCaptureVP;
    uniform sampler2D uCaptureDepth;
    uniform float uCaptureDepthOn;
    uniform vec2 uCaptureNearFar;
    uniform vec2 uCaptureSize;
    uniform vec3 uCaptureDir;
    varying vec3 vProjWorldPos;
    varying vec3 vProjWorldNormal;
    float projLinearDepth( float d ) {
      float n = uCaptureNearFar.x, f = uCaptureNearFar.y;
      return 2.0 * n * f / ( f + n - ( 2.0 * d - 1.0 ) * ( f - n ) );
    }
    // How much of what the capture camera saw at uv is this point (its depth mine, in m): a 3 by 3 read of
    // the depth the camera recorded, each tap 1 where this point is what it saw (within the bias).
    float projUnoccluded( vec2 uv, float mine ) {
      if ( uCaptureDepthOn < 0.5 ) return 1.0;
      vec2 texel = 1.0 / uCaptureSize;
      float seen = 0.0;
      for ( int i = -1; i <= 1; i++ ) for ( int j = -1; j <= 1; j++ ) {
        float stored = projLinearDepth( texture2D( uCaptureDepth, uv + vec2( float( i ), float( j ) ) * texel ).r );
        seen += 1.0 - smoothstep( PROJ_BIAS, 2.0 * PROJ_BIAS, mine - stored );
      }
      return seen / 9.0;
    }`,
  // Applied to diffuseColor.rgb once the cloth's own colour (prints, stripes, stitching, the inside) is done.
  fragmentApply: `
    if ( uProjectedOn > 0.5 ) {
      vec4 projClip = uCaptureVP * vec4( vProjWorldPos, 1.0 );
      if ( projClip.w > 1e-6 ) {
        vec3 projNdc = projClip.xyz / projClip.w;
        vec2 projUv = projNdc.xy * 0.5 + 0.5;
        float projFaceDir = gl_FrontFacing ? 1.0 : -1.0;
        float projCos = dot( normalize( vProjWorldNormal ) * projFaceDir, -uCaptureDir );
        float projFacing = smoothstep( PROJ_FACING_FROM, PROJ_FACING_TO, projCos );
        float projInside = smoothstep( 0.0, PROJ_BORDER, projUv.x ) * smoothstep( 0.0, PROJ_BORDER, 1.0 - projUv.x )
                         * smoothstep( 0.0, PROJ_BORDER, projUv.y ) * smoothstep( 0.0, PROJ_BORDER, 1.0 - projUv.y );
        float projW = projFacing * projInside;
        if ( projW > 0.001 ) projW *= projUnoccluded( projUv, projLinearDepth( projNdc.z * 0.5 + 0.5 ) );
        vec3 projColor = texture2D( uProjected, projUv ).rgb;
        if ( uProjectedMode == 1 ) {
          vec3 projFlat = texture2D( uProjectedFlat, projUv ).rgb;
          projColor = diffuseColor.rgb * clamp( projColor / max( projFlat, vec3( 0.02 ) ), 0.6, 1.6 );
        } else if ( uProjectedMode == 2 ) {
          // The page's light here: its photo over the cloth's own colour (per channel; from the brightness
          // alone where a channel is too dark to divide by). The picture over that light is the AI's cloth.
          vec3 projAlbedo = max( diffuseColor.rgb, vec3( 0.002 ) );
          vec3 projBase = texture2D( uProjectedBase, projUv ).rgb;
          float projLuma = dot( projBase, PROJ_LUMA ) / max( dot( projAlbedo, PROJ_LUMA ), 0.002 );
          vec3 projLight = mix( vec3( projLuma ), projBase / projAlbedo, smoothstep( PROJ_DARK, 2.5 * PROJ_DARK, projAlbedo ) );
          projColor = clamp( projColor / clamp( projLight, PROJ_LIGHT_MIN, PROJ_LIGHT_MAX ), 0.0, 1.0 );
        }
        // Where the picture doesn't reach, the page's cloth carries the picture's colour shift a little way
        // round, so the picture doesn't stop at a line.
        float projTint = smoothstep( PROJ_FACING_FROM - 0.25, PROJ_FACING_FROM, projCos ) * projInside;
        vec3 projFallback = diffuseColor.rgb * mix( vec3( 1.0 ), uProjectedTint, projTint );
        diffuseColor.rgb = mix( projFallback, projColor, projW );
      }
    }`
}

// Adds the projection's varyings to a material's vertex shader and its uniforms and functions to the fragment
// shader; the caller puts PROJECTION.fragmentApply where the cloth's colour is finished.
export function withProjection(shader, uniforms) {
  Object.assign(shader.uniforms, uniforms)
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", `#include <common>${PROJECTION.vertexDeclare}`)
    .replace("#include <project_vertex>", `#include <project_vertex>${PROJECTION.vertexAssign}`)
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", `#include <common>${PROJECTION.fragmentDeclare}`)
}

// A normal map for a surface, drawn once.
function surfaceTexture(kind, renderer) {
  if (textures.has(kind)) return textures.get(kind)
  const height = heightField(kind)
  const data = new Uint8Array(SIZE * SIZE * 4)
  const at = (x, y) => height[((y + SIZE) % SIZE) * SIZE + ((x + SIZE) % SIZE)]
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 2.5, dy = (at(x, y + 1) - at(x, y - 1)) * 2.5
      const l = Math.hypot(dx, dy, 1)
      const i = 4 * (y * SIZE + x)
      data[i] = Math.round((-dx / l * 0.5 + 0.5) * 255)
      data[i + 1] = Math.round((-dy / l * 0.5 + 0.5) * 255)
      data[i + 2] = Math.round((1 / l * 0.5 + 0.5) * 255)
      data[i + 3] = 255
    }
  }
  const texture = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.generateMipmaps = true
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.anisotropy = renderer?.capabilities.getMaxAnisotropy() ?? 4
  texture.needsUpdate = true
  textures.set(kind, texture)
  return texture
}

// A tileable height field (0..1) for each surface.
function heightField(kind) {
  const h = new Float32Array(SIZE * SIZE)
  const noise = tileNoise(7)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE, v = y / SIZE
      let value
      switch (kind) {
        case "knit": value = knit(u, v, 14, 18) * 0.75 + noise(u, v, 4) * 0.25; break
        case "rib": {
          // Two knit wales up, two purl down, repeated; each wale a column of loops.
          const ribs = 0.5 + 0.5 * Math.cos(u * 2 * Math.PI * 5)
          value = ribs * 0.75 + knit(u, v, 20, 13) * 0.2 * ribs + noise(u, v, 4) * 0.05
          break
        }
        case "fleece": value = knit(u, v, 8, 10) * 0.55 + noise(u, v, 8) * 0.3 + noise(u, v, 2) * 0.15; break
        case "fine": value = knit(u, v, 40, 48) * 0.6 + noise(u, v, 6) * 0.4; break
        case "grain": value = noise(u, v, 40) * 0.5 + noise(u, v, 16) * 0.35 + noise(u, v, 4) * 0.15; break
        case "smooth": value = noise(u, v, 3) * 0.8 + noise(u, v, 12) * 0.2; break
        case "twill": {
          // Diagonal ridges of the weave, with the yarns' slubs.
          const ridge = 0.5 + 0.5 * Math.cos((u + v) * 2 * Math.PI * 16)
          value = ridge * 0.7 + noise(u, v, 16) * 0.2 + noise(u, v, 3) * 0.1
          break
        }
        case "plain": {
          // Over-under: each crossing of warp and weft is a little bump, in a checkerboard.
          const weave = Math.sin(u * 2 * Math.PI * 24) * Math.sin(v * 2 * Math.PI * 24)
          value = 0.5 + weave * 0.3 + noise(u, v, 12) * 0.2
          break
        }
        case "ripstop": {
          const grid = Math.max(line(u * 6), line(v * 6))
          value = grid * 0.6 + noise(u, v, 6) * 0.4
          break
        }
        default: value = noise(u, v, 6) * 0.6 + noise(u, v, 24) * 0.4
      }
      h[y * SIZE + x] = value
    }
  }
  return h
}

// A column of knit loops: `wales` columns of V-shaped stitches across the tile, `courses` rows up it.
function knit(u, v, wales, courses) {
  const cu = (u * wales) % 1, cv = (v * courses) % 1
  const side = cu < 0.5 ? cu * 2 : (1 - cu) * 2      // 0 at a column's edge, 1 at its middle
  const lean = (cv + (cu < 0.5 ? 0 : 0.5) + side * 0.35) % 1
  return Math.sin(Math.PI * side) ** 0.7 * (0.55 + 0.45 * Math.sin(Math.PI * lean))
}

// A raised line at each whole number (ripstop's thicker yarns).
function line(t) {
  const d = Math.abs(t - Math.round(t))
  return Math.max(0, 1 - d * 14)
}

// Smooth value noise that tiles over the unit square: noise(u, v, cells) with `cells` (a whole number) noise
// cells across it.
function tileNoise(seed) {
  const random = mulberry(seed)
  const N = 64
  const grid = Float32Array.from({ length: N * N }, () => random())
  return (u, v, cells) => {
    const x = u * cells, y = v * cells
    const fx = Math.floor(x), fy = Math.floor(y), tx = x - fx, ty = y - fy
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty)
    const at = (i, j) => grid[(((j % cells) + cells) % cells % N) * N + (((i % cells) + cells) % cells % N)]
    const a = at(fx, fy), b = at(fx + 1, fy), c = at(fx, fy + 1), d = at(fx + 1, fy + 1)
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
  }
}

function mulberry(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// The material for one cloth of a garment. options: color, cloth (a CLOTHS name or alias), details: what to
// draw on it ({ stitch: "hem" | "topstitch" | null, closure: "zip" | "buttons" | "placket" | null, pocket: "kangaroo" |
// null, neckDepth (cm, where a front closure starts), length (cm, the front's length) }), fitMap (true: the
// fit map's colours instead).
export function clothMaterial({ color = "#2a3552", cloth = "jersey", details = {}, fitMap = false, renderer = null } = {}) {
  const look = CLOTHS[ALIASES[cloth] ?? cloth] ?? CLOTHS.jersey
  // The geometry's uv is in metres, so one repeat of the surface every `tile` metres.
  const normalMap = surfaceTexture(look.surface, renderer).clone()
  normalMap.repeat.setScalar(1 / look.tile)
  const material = new THREE.MeshPhysicalMaterial({
    color: fitMap ? 0xffffff : color, vertexColors: fitMap, roughness: look.roughness, normalMap,
    normalScale: new THREE.Vector2(look.normal, look.normal), sheen: fitMap ? 0 : look.sheen,
    sheenRoughness: look.sheenRoughness, sheenColor: sheenTint(color),
    clearcoat: fitMap ? 0 : look.clearcoat ?? 0, clearcoatRoughness: look.clearcoatRoughness ?? 0.5, side: THREE.DoubleSide
  })
  const uniforms = {
    uStitch: { value: { hem: 1, topstitch: 2 }[details.stitch] ?? 0 },
    uClosure: { value: { zip: 1, buttons: 2, placket: 3 }[details.closure] ?? 0 },
    uPocket: { value: details.pocket === "kangaroo" ? 1 : 0 },
    uNeckDepth: { value: details.neckDepth ?? 9 },
    uLength: { value: details.length ?? 70 },
    uThread: { value: new THREE.Color(details.thread ?? color).offsetHSL(0, 0, details.thread ? 0 : 0.07) },
    uMetal: { value: new THREE.Color(details.metal ?? "#9a9ca0") },
    // A print on the front, from the shop's photo (see print.js and DrapedTop#setPrint): the photo's front of
    // the garment, laid across the front piece from its shoulders (half as wide as uPrintHalf either side of
    // the middle) down uPrintLength to the hem.
    uPrint: { value: BLANK },
    uPrintOn: { value: 0 },
    uPrintHalf: { value: 26 },
    uPrintLength: { value: 70 },
    // An all-over print: the printed cloth itself (a piece of the photo's front), repeated over every other
    // piece at its size on the garment (uTile: across and down, cm, and how far below the shoulders it starts).
    uPrintTile: { value: BLANK },
    uAllOver: { value: 0 },
    uTile: { value: new THREE.Vector3(20, 20, 0) },
    // A striped front (see print.js's stripeStrip): the cloth's colour at each height down the garment, laid
    // on every piece by aDown, so the stripes meet at the seams.
    uStripe: { value: BLANK },
    uStripeOn: { value: 0 },
    uStripeLength: { value: 70 },   // how far down the garment the strip reaches (cm)
    // Vertical stripes (a striped button-up): x 1 for them, y half the photo's front width (cm), z where the
    // strip starts across the front and w how much of it it spans (shares of its width). Laid by aAcross.
    uStripeAcross: { value: new THREE.Vector4(0, 26, 0, 1) },
    // Pants' and skirts' shop photo, laid on the cloth where aPhoto says (see DrapedTop#setPhotoMap).
    uPhoto: { value: BLANK },
    uPhotoSoft: { value: BLANK },
    uPhotoBack: { value: BLANK },
    // A top's back, from the shop's photo of it (laid as the front's print is).
    uBack: { value: BLANK },
    uBackOn: { value: 0 },
    // Graphics on the sleeves, from the shop's photos (print.js's sleevePrint): each sleeve's front half
    // and back half, by the wearer's side. uSleeveSize: half the sleeve's width at the top and at the hem,
    // and its length (cm), down which each strip is laid.
    // All four in one texture, side by side (right front, left front, right back, left back): a GPU has
    // only so many textures a material may read, and the cloth's are nearly all spoken for.
    uSleeveOn: { value: 0 },
    uSleeves: { value: BLANK },
    // For the 3D view's check (stage.js's lookShot): only the body's outside is drawn (no sleeves, nor the
    // cloth's inside seen through the neck), as a flat shop photo shows the front.
    uLookOnly: { value: 0 },
    uSleeveHave: { value: new THREE.Vector4() },
    uSleeveSize: { value: new THREE.Vector3(16, 12, 60) },
    uPhotoOn: { value: 0 },
    // How much of a sheer part's colour shows (1: none of it is sheer).
    uSheer: { value: details.sheer ?? 1 },
    // A puffer's baffles: x how far each puffs out (m; 0 for no quilting), y how far apart they are (cm).
    uQuilt: { value: new THREE.Vector2(details.quilt ? QUILT.loft : 0, QUILT.spacing) },
    // The AI's picture of this view, laid back on from its camera (see PROJECTION; stage.js#wearPhoto sets it).
    ...projectionUniforms()
  }
  material.userData.uniforms = uniforms
  if (details.sheer && details.sheer < 1 && !fitMap) material.transparent = true
  material.customProgramCacheKey = () => `cloth-${fitMap}`
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms)
    withProjection(shader, {})
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
        attribute float aEdge;
        attribute float aHem;
        attribute float aPiece;
        attribute float aShade;
        attribute float aHide;
        attribute vec3 aPhoto;
        attribute float aHole;
        attribute float aCover;
        attribute float aStrain;
        attribute float aDown;
        attribute float aAcross;
        uniform vec2 uQuilt;
        varying float vAcross;
        varying float vCover;
        varying float vStrain;
        varying float vDown;
        attribute float aSheer;
        varying float vHole;
        varying float vSheer;
        varying float vHide;
        varying vec3 vPhoto;
        varying float vEdge;
        varying float vHem;
        varying float vPiece;
        varying float vShade;
        varying vec2 vPattern;`)
      .replace("#include <uv_vertex>", `#include <uv_vertex>
        vEdge = aEdge; vHem = aHem; vPiece = aPiece; vShade = aShade; vHide = aHide; vPhoto = aPhoto; vPattern = uv * 100.0; vHole = aHole; vSheer = aSheer; vCover = aCover; vStrain = aStrain; vDown = aDown; vAcross = aAcross;`)
      // Drawn a hair off the cloth's simulated surface, so the skin under it never shows through.
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        transformed += normalize( objectNormal ) * 0.0015;
        // A puffer's baffles: each puffs out between its seams, which stay where the drape left the cloth (so
        // nothing under it shows through there), as do the pieces' edges (puffed by different amounts either side
        // of a seam, the cloth would part along it).
        if ( uQuilt.x > 0.0 ) transformed += normalize( objectNormal ) * uQuilt.x * sqrt( max( sin( 3.14159265 * fract( aDown / uQuilt.y ) ), 0.0 ) ) * smoothstep( 0.0, 2.5, aEdge );`)
    shader.fragmentShader = shader.fragmentShader
      // Squeezed cloth shows its weave deeper: fine creases where it's gathered.
      .replace("#include <normal_fragment_maps>", THREE.ShaderChunk.normal_fragment_maps.replace("mapN.xy *= normalScale;", "mapN.xy *= normalScale * ( 1.0 + 3.0 * vStrain );") + `
        if ( uQuilt.x > 0.0 ) normal = quiltNormal( - vViewPosition, normal, faceDirection );`)
      .replace("#include <common>", `#include <common>
        #define CREASE_FOLD ${CREASE.fold.toFixed(2)}
        #define CREASE_DARK ${CREASE.dark.toFixed(2)}
        #define CREASE_ROUGH ${CREASE.rough.toFixed(2)}
        uniform int uStitch;
        uniform int uClosure;
        uniform int uPocket;
        uniform float uNeckDepth;
        uniform float uLength;
        uniform vec3 uThread;
        uniform vec3 uMetal;
        uniform sampler2D uPrint;
        uniform float uPrintOn;
        uniform float uPrintHalf;
        uniform float uPrintLength;
        uniform sampler2D uPrintTile;
        uniform float uAllOver;
        uniform vec3 uTile;
        uniform sampler2D uStripe;
        uniform float uStripeOn;
        uniform float uStripeLength;
        uniform vec4 uStripeAcross;
        varying float vAcross;
        uniform sampler2D uPhoto;
        uniform sampler2D uPhotoSoft;
        uniform sampler2D uPhotoBack;
        uniform sampler2D uBack;
        uniform float uBackOn;
        uniform float uSleeveOn;
        uniform sampler2D uSleeves;
        uniform float uLookOnly;
        uniform vec4 uSleeveHave;
        uniform vec3 uSleeveSize;
        uniform float uPhotoOn;
        uniform float uSheer;
        uniform vec2 uQuilt;
        varying float vCover;
        varying float vStrain;
        varying float vDown;
        varying float vHole;
        varying float vSheer;
        varying vec3 vPhoto;
        varying float vHide;
        varying float vEdge;
        varying float vHem;
        varying float vPiece;
        varying float vShade;
        varying vec2 vPattern;
        float lineAt( float value, float at, float halfWidth ) {
          float px = fwidth( value ) + 1e-4;
          return smoothstep( halfWidth + px, halfWidth - px, abs( value - at ) );
        }
        float dashes( vec2 p ) { return step( fract( ( p.x + p.y ) / 0.42 ), 0.62 ); }
        // A puffer baffle's height (m) at this point, by how far down the garment it is (see uQuilt).
        float quiltHeight() { return uQuilt.x * sqrt( max( sin( 3.14159265 * fract( vDown / uQuilt.y ) ), 1e-3 ) ) * smoothstep( 0.0, 2.5, vEdge ); }
        // The surface's normal tilted by the baffles' slope (three.js's bump mapping, by screen derivatives).
        vec3 quiltNormal( vec3 position, vec3 normal, float faceDirection ) {
          float h = quiltHeight();
          vec3 dx = dFdx( position ), dy = dFdy( position );
          vec2 slope = vec2( dFdx( h ) / max( length( dx ), 1e-6 ), dFdy( h ) / max( length( dy ), 1e-6 ) );
          vec3 sx = normalize( dx ), sy = normalize( dy );
          vec3 r1 = cross( sy, normal ), r2 = cross( normal, sx );
          float det = dot( sx, r1 ) * faceDirection;
          return normalize( abs( det ) * normal - sign( det ) * ( slope.x * r1 + slope.y * r2 ) );
        }
        // Distance to a kangaroo pocket's outline on the front (cm): a trapezoid with curved hand openings.
        float pocketDistance( vec2 p ) {
          float bottom = -uLength + 4.0, top = bottom + 22.0;
          float halfBottom = 17.0, halfTop = 11.5;
          if ( p.y < bottom - 3.0 || p.y > top + 3.0 ) return 99.0;
          float y = clamp( ( p.y - bottom ) / ( top - bottom ), 0.0, 1.0 );
          float halfWidth = mix( halfBottom, halfTop, y );
          float d = abs( abs( p.x ) - halfWidth );
          if ( p.y > top ) d = length( vec2( max( abs( p.x ) - halfTop, 0.0 ), p.y - top ) );
          if ( p.y < bottom ) d = length( vec2( max( abs( p.x ) - halfBottom, 0.0 ), p.y - bottom ) );
          d = min( d, abs( p.y - top ) + max( abs( p.x ) - halfTop, 0.0 ) );
          return d;
        }`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        if ( uLookOnly > 0.5 && ( vPiece > 2.5 || !gl_FrontFacing ) ) discard;
        if ( vHide > 0.0 || vHole > 0.0 || vCover > 0.5 ) discard;
        diffuseColor.a *= mix( 1.0, uSheer, clamp( vSheer, 0.0, 1.0 ) );
        // The shop's photo, as the cloth's own colour (its seams and stitching are drawn over it as on any).
        if ( uPhotoOn > 0.5 && vPhoto.z > 0.5 ) diffuseColor.rgb = ( vPhoto.z < 1.5 ? texture2D( uPhoto, vPhoto.xy ) : vPhoto.z < 2.5 ? texture2D( uPhotoSoft, vPhoto.xy ) : texture2D( uPhotoBack, vPhoto.xy ) ).rgb;
        vec3 thread = uThread;
        float groove = 1.0 - smoothstep( 0.0, 0.45, vEdge );
        float stitch = 0.0, metal = 0.0, shadow = 0.0;
        // Hems: two rows of stitching a little way up from the edge (knits), or one (wovens).
        if ( uStitch == 1 && vHem < 3.0 ) stitch = max( lineAt( vHem, 1.6, 0.05 ), lineAt( vHem, 2.2, 0.05 ) ) * dashes( vPattern );
        if ( uStitch == 2 ) stitch = max( lineAt( vEdge, 0.6, 0.05 ), lineAt( vHem, 1.2, 0.05 ) ) * dashes( vPattern );
        if ( vPiece > 0.5 && vPiece < 1.5 ) {
          float x = abs( vPattern.x ), y = vPattern.y;
          bool placket = y < -uNeckDepth + 0.5;
          if ( uClosure == 1 && placket ) {
            // A zip: its tape, then the teeth down the middle, and the slider with its pull at the top.
            shadow = max( shadow, lineAt( x, 0.0, 0.55 ) * 0.35 );
            float teeth = lineAt( x, 0.0, 0.32 ) * step( 0.35, fract( y / 0.32 ) );
            metal = max( metal, teeth );
            stitch = max( stitch, lineAt( x, 1.1, 0.05 ) * dashes( vPattern ) );
            float slider = step( x, 0.55 ) * step( -uNeckDepth - 1.6, y ) * step( y, -uNeckDepth + 0.3 );
            float pull = step( x, 0.28 ) * step( -uNeckDepth - 4.6, y ) * step( y, -uNeckDepth - 1.6 );
            float eye = smoothstep( 0.2, 0.1, length( vec2( x, y + uNeckDepth + 3.9 ) ) );
            metal = max( metal, max( slider, pull * ( 1.0 - eye ) ) );
            shadow = max( shadow, ( step( x, 0.75 ) * step( -uNeckDepth - 1.8, y ) * step( y, -uNeckDepth + 0.5 ) - slider ) * 0.6 + pull * eye * 0.6 );
          }
          // A polo's short placket: three buttons, 13 cm down from the neck.
          if ( uClosure == 3 ) placket = placket && y > -uNeckDepth - 13.0;
          if ( ( uClosure == 2 || uClosure == 3 ) && placket ) {
            // A placket down the front with buttons every 9 cm.
            shadow = max( shadow, lineAt( x, 1.6, 0.06 ) * 0.5 );
            stitch = max( stitch, lineAt( x, 1.3, 0.04 ) * dashes( vPattern ) );
            float gap = uClosure == 3 ? 5.0 : 9.0;
            float k = floor( ( -uNeckDepth - 1.5 - y ) / gap + 0.5 );
            float by = -uNeckDepth - 1.5 - k * gap;
            float d = length( vec2( vPattern.x, y - by ) );
            float button = smoothstep( 0.62, 0.52, d ) * step( y, -uNeckDepth ) * step( -uLength + 5.0, y );
            metal = max( metal, button * 0.6 );
            shadow = max( shadow, ( smoothstep( 0.7, 0.6, d ) - smoothstep( 0.6, 0.5, d ) ) * 0.6 * button );
          }
          if ( uPocket == 1 ) {
            float d = pocketDistance( vPattern );
            shadow = max( shadow, lineAt( d, 0.0, 0.12 ) * 0.45 );
            stitch = max( stitch, lineAt( d, 0.55, 0.05 ) * dashes( vPattern ) );
          }
        }
        // A puffer's stitched seams between its baffles, where the shell is pulled in: a little darker.
        if ( uQuilt.x > 0.0 ) shadow = max( shadow, ${QUILT.seam.toFixed(2)} * ( 1.0 - smoothstep( 0.0, 0.3, sin( 3.14159265 * fract( vDown / uQuilt.y ) ) ) ) );
        diffuseColor.rgb *= 1.0 - 0.22 * groove - 0.5 * shadow;
        diffuseColor.rgb = mix( diffuseColor.rgb, thread, stitch * 0.85 );
        bool backPhoto = uBackOn > 0.5 && vPiece > 1.5 && vPiece < 2.5;
        // (On the front too, where a bigger size reaches past the photo's print, and the print shows through.)
        if ( uPrintOn > 0.5 && uAllOver > 0.5 && !backPhoto && gl_FrontFacing ) {
          // Started half a repeat off the middle, so the back isn't mirrored about its centre seam.
          vec2 st = vec2( vPattern.x / uTile.x + 0.5, ( -vPattern.y - uTile.z ) / uTile.y );
          diffuseColor.rgb = texture2D( uPrintTile, vec2( st.x, 1.0 - st.y ) ).rgb;
        }
        // Stripes: the front's colour at this height, on every piece (the front's own photo goes on over it).
        // A striped knit is striped on its inside too, a little duller: where a long sleeve gathers and a fold
        // turns the cloth over, the fold shows stripes, not a plain band that reads as a tear.
        if ( uStripeOn > 0.5 && !backPhoto ) {
          vec2 at = uStripeAcross.x > 0.5
            ? vec2( ( 0.5 + vAcross / ( 2.0 * uStripeAcross.y ) - uStripeAcross.z ) / uStripeAcross.w, 0.5 )
            : vec2( 0.5, 1.0 - clamp( vDown / uStripeLength, 0.0, 1.0 ) );
          vec3 stripe = texture2D( uStripe, at ).rgb;
          diffuseColor.rgb = gl_FrontFacing ? stripe : mix( diffuseColor.rgb, stripe, 0.8 );
        }
        if ( backPhoto && gl_FrontFacing ) {
          vec2 st = vec2( 0.5 + vPattern.x / ( 2.0 * uPrintHalf ), -vPattern.y / uPrintLength );
          if ( st.x > 0.0 && st.x < 1.0 && st.y > 0.0 && st.y < 1.0 ) {
            vec4 printed = texture2D( uBack, vec2( st.x, 1.0 - st.y ) );
            diffuseColor.rgb = mix( diffuseColor.rgb, printed.rgb, printed.a );
          }
        }
        if ( uPrintOn > 0.5 && vPiece > 0.5 && vPiece < 1.5 && gl_FrontFacing ) {
          vec2 st = vec2( 0.5 + vPattern.x / ( 2.0 * uPrintHalf ), -vPattern.y / uPrintLength );
          if ( st.x > 0.0 && st.x < 1.0 && st.y > 0.0 && st.y < 1.0 ) {
            vec4 printed = texture2D( uPrint, vec2( st.x, 1.0 - st.y ) );
            diffuseColor.rgb = mix( diffuseColor.rgb, printed.rgb, printed.a );
          }
        }
        // A sleeve's graphic: down it by its length from the top of the cap, across it from its top line (x 0)
        // to the underarm seam (x at half its width there), on the half facing the way the photo saw it.
        if ( uSleeveOn > 0.5 && vPiece > 2.5 && gl_FrontFacing ) {
          bool right = vPiece > 3.5;
          float along = -vPattern.y / uSleeveSize.z;
          float across = abs( vPattern.x ) / mix( uSleeveSize.x, uSleeveSize.y, clamp( along, 0.0, 1.0 ) );
          // The right sleeve's front half is on its +x side, the left's on its -x side (pattern.js's sleeve).
          bool front = right ? vPattern.x >= 0.0 : vPattern.x <= 0.0;
          if ( along > 0.0 && along < 1.0 && across < 1.0 ) {
            float slot = ( front ? 0.0 : 2.0 ) + ( right ? 0.0 : 1.0 );
            float have = slot < 0.5 ? uSleeveHave.x : slot < 1.5 ? uSleeveHave.y : slot < 2.5 ? uSleeveHave.z : uSleeveHave.w;
            if ( have > 0.5 ) {
              // Kept off the strip's own edges, so a neighbour's pixels don't bleed in.
              vec4 printed = texture2D( uSleeves, vec2( ( slot + clamp( across, 0.02, 0.98 ) ) / 4.0, 1.0 - along ) );
              diffuseColor.rgb = mix( diffuseColor.rgb, printed.rgb, printed.a );
            }
          }
        }
        diffuseColor.rgb = mix( diffuseColor.rgb, uMetal, metal );
        // Creases: where the cloth is gathered (squeezed) or tucked into a fold, its tiny folds shade each
        // other, so it's a little darker and rougher there (the photo's colour too, laid on above).
        float crease = clamp( vStrain + CREASE_FOLD * ( 1.0 - vShade ), 0.0, 1.0 ) * ( 1.0 - metal );
        diffuseColor.rgb *= 1.0 - CREASE_DARK * crease;
        if ( !gl_FrontFacing ) diffuseColor.rgb *= 0.55;   // the inside
        ${fitMap ? "" : PROJECTION.fragmentApply}`)
      // The inside of the cloth (a hood's, a turned-back cuff's) is in its own shade: its sheen dimmed with it,
      // or a black hood's inside catches a grey shine the outside doesn't.
      .replace("#include <lights_physical_fragment>", `#include <lights_physical_fragment>
        #ifdef USE_SHEEN
          if ( !gl_FrontFacing ) material.sheenColor *= 0.3;
        #endif`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
        roughnessFactor = mix( roughnessFactor, 0.28, metal );
        roughnessFactor = min( 1.0, roughnessFactor * ( 1.0 + CREASE_ROUGH * crease ) );`)
      .replace("#include <aomap_fragment>", `#include <aomap_fragment>
        reflectedLight.indirectDiffuse *= vShade;
        reflectedLight.indirectSpecular *= vShade;
        if ( !gl_FrontFacing ) { reflectedLight.indirectSpecular *= 0.3; reflectedLight.directSpecular *= 0.3; }`)
      // The check's picture is the cloth's own colours, unlit: a fold's shadow isn't read as a print, and the
      // colour is the cloth's, not the light's (stage.js's lookShot).
      .replace("#include <colorspace_fragment>", `if ( uLookOnly > 0.5 ) gl_FragColor = vec4( diffuseColor.rgb, 1.0 );
        #include <colorspace_fragment>`)
  }
  return material
}

// The light a cloth's nap catches along its folds: its own colour, a little paler. Dark cloth's sheen is
// faint (a fixed lift turns black fleece's folds mid-grey, like a satin), pale cloth's brighter.
export function sheenTint(color) {
  const c = new THREE.Color(color), hsl = c.getHSL({})
  return c.offsetHSL(0, -0.1, 0.06 + 0.2 * hsl.l)
}

export function clothLook(cloth) {
  return CLOTHS[ALIASES[cloth] ?? cloth] ?? CLOTHS.jersey
}
