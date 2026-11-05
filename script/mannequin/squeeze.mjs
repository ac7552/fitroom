// The mannequin smaller over the wire, with its geometry exactly as the page reads it: EXT_meshopt_compression
// in its lossless mode. Vertex order is kept (no reordering: women.bin and mannequin.json index the
// vertices) and nothing is quantized (the body is measured off its positions, in metres). Run after the
// Blender build (script/mannequin/build.py), which writes the plain glTF:
//
//   npm i --prefix tmp/squeeze @gltf-transform/core@4 @gltf-transform/extensions@4 meshoptimizer@1
//   NODE_PATH=tmp/squeeze/node_modules node script/mannequin/squeeze.mjs public/models/mannequin.glb public/models/mannequin.glb
//
// The page decodes it with three.js's MeshoptDecoder (vendor/javascript/three-addons/meshopt_decoder.module.js).
import { createRequire } from "node:module"
import path from "node:path"
const require = createRequire(path.resolve(process.env.NODE_PATH ?? "node_modules", "x"))
const { NodeIO } = require("@gltf-transform/core")
const { ALL_EXTENSIONS, EXTMeshoptCompression } = require("@gltf-transform/extensions")
const { MeshoptEncoder, MeshoptDecoder } = require("meshoptimizer")

await MeshoptEncoder.ready
await MeshoptDecoder.ready
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder })
const [src, out] = process.argv.slice(2)
const doc = await io.read(src)
if (doc.getRoot().listExtensionsUsed().some(e => e.extensionName === "EXT_meshopt_compression")) {
  console.log(`${src} is already compressed`)
  process.exit(0)
}
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER })
await io.write(out, doc)
console.log(`wrote ${out}`)
