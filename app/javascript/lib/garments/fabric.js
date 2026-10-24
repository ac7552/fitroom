import * as THREE from "three"

// How draped cloth looks: each kind of cloth's surface (a normal map drawn here, tiling across the cloth at its
// real size), how it catches the light, and the seams, stitching, zips and buttons drawn onto it from where
// each point sits on its pattern piece. The garment's geometry (see dress.js) carries, per point:
//   uv       where it is on its pattern piece, in metres (so textures tile at a real size)
//   aEdge    how far it is from the edge of its piece (cm): seams show as a soft groove along it
//   aHem     how far it is from a hem or other free edge (cm): hems are stitched a little way up
//   aPiece   which piece it's on (1 the front, 0 the rest)
//   aShade   how open to the room it is (1) or tucked into a fold or under the hood (less): ambient light
//            reaching it, worked out from the drape
//   aHide    above 0 where it isn't drawn: a tucked top inside the pants (how far inside, m)
//   aPhoto   where it is in the garment's shop photo, laid on pants and skirts ([u, v, which]: which 1 the
//            photo, 2 its softened copy, 0 neither; see photo_map.js)

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
  stretch: { surface: "fine", tile: 0.012, roughness: 0.68, sheen: 0.35, sheenRoughness: 0.45, normal: 0.12 }
}
// Which pattern fabric (pattern.js) is which cloth here; "denim" and "cotton" are what shops call them.
const ALIASES = { cotton: "jersey", denim: "twill", nylon: "shell", leather: "shell" }

const SIZE = 256
const textures = new Map()
const BLANK = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat)
BLANK.needsUpdate = true

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
    sheenRoughness: look.sheenRoughness, sheenColor: new THREE.Color(color).offsetHSL(0, -0.1, 0.25),
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
    // Pants' and skirts' shop photo, laid on the cloth where aPhoto says (see DrapedTop#setPhotoMap).
    uPhoto: { value: BLANK },
    uPhotoSoft: { value: BLANK },
    uPhotoBack: { value: BLANK },
    // A top's back, from the shop's photo of it (laid as the front's print is).
    uBack: { value: BLANK },
    uBackOn: { value: 0 },
    uPhotoOn: { value: 0 }
  }
  material.userData.uniforms = uniforms
  material.customProgramCacheKey = () => `cloth-${fitMap}`
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
        attribute float aEdge;
        attribute float aHem;
        attribute float aPiece;
        attribute float aShade;
        attribute float aHide;
        attribute vec3 aPhoto;
        varying float vHide;
        varying vec3 vPhoto;
        varying float vEdge;
        varying float vHem;
        varying float vPiece;
        varying float vShade;
        varying vec2 vPattern;`)
      .replace("#include <uv_vertex>", `#include <uv_vertex>
        vEdge = aEdge; vHem = aHem; vPiece = aPiece; vShade = aShade; vHide = aHide; vPhoto = aPhoto; vPattern = uv * 100.0;`)
      // Drawn a hair off the cloth's simulated surface, so the skin under it never shows through.
      .replace("#include <begin_vertex>", "#include <begin_vertex>\ntransformed += normalize( objectNormal ) * 0.0015;")
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
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
        uniform sampler2D uPhoto;
        uniform sampler2D uPhotoSoft;
        uniform sampler2D uPhotoBack;
        uniform sampler2D uBack;
        uniform float uBackOn;
        uniform float uPhotoOn;
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
        if ( vHide > 0.0 ) discard;
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
            // A zip: its tape, then the teeth down the middle.
            shadow = max( shadow, lineAt( x, 0.0, 0.55 ) * 0.35 );
            float teeth = lineAt( x, 0.0, 0.32 ) * step( 0.35, fract( y / 0.32 ) );
            metal = max( metal, teeth );
            stitch = max( stitch, lineAt( x, 1.1, 0.05 ) * dashes( vPattern ) );
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
        diffuseColor.rgb *= 1.0 - 0.22 * groove - 0.5 * shadow;
        diffuseColor.rgb = mix( diffuseColor.rgb, thread, stitch * 0.85 );
        bool backPhoto = uBackOn > 0.5 && vPiece > 1.5;
        // (On the front too, where a bigger size reaches past the photo's print, and the print shows through.)
        if ( uPrintOn > 0.5 && uAllOver > 0.5 && !backPhoto && gl_FrontFacing ) {
          // Started half a repeat off the middle, so the back isn't mirrored about its centre seam.
          vec2 st = vec2( vPattern.x / uTile.x + 0.5, ( -vPattern.y - uTile.z ) / uTile.y );
          diffuseColor.rgb = texture2D( uPrintTile, vec2( st.x, 1.0 - st.y ) ).rgb;
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
        diffuseColor.rgb = mix( diffuseColor.rgb, uMetal, metal );
        if ( !gl_FrontFacing ) diffuseColor.rgb *= 0.55;   // the inside`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
        roughnessFactor = mix( roughnessFactor, 0.28, metal );`)
      .replace("#include <aomap_fragment>", `#include <aomap_fragment>
        reflectedLight.indirectDiffuse *= vShade;
        reflectedLight.indirectSpecular *= vShade;`)
  }
  return material
}

export function clothLook(cloth) {
  return CLOTHS[ALIASES[cloth] ?? cloth] ?? CLOTHS.jersey
}
