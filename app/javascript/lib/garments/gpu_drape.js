// A proof of concept of the drape's solver on the GPU (WebGPU compute), to time against drape.js on the same
// cloth. It runs the core of Drape#step for a sewn garment: each small step the cloth moves under gravity,
// its threads (stretch) and its bends hold their lengths, and points inside the skin go back out onto it
// (the body's SkinField, as a 3D texture), and pants are held up by their waistband and rest on the floor.
// Not yet here: the cloth touching itself, friction, and cuffs on the arms, a tuck, pants off the hands and feet.
//
// The CPU solver goes through each thread in turn (Gauss-Seidel). Here the threads are split into colours, no
// two of one colour sharing a point, and each colour is solved all at once: the same solve, in a different
// order, so the cloth behaves as it does on the CPU.
//
//   const result = await benchDrape(drape, { frames: 120 })
//   → { cpu: { msPerFrame, ... }, gpu: { msPerFrame, ... } | { unavailable } , apart }
import { CLOTHS } from "lib/garments/drape"

const FRAME = 1 / 60, SUBSTEPS = 10, GRAVITY = -9.81
const GROUP = 64

const SHADER = /* wgsl */ `
struct Params { n: u32, h: f32, fall: f32, drag: f32, thick: f32, cell: f32, band: f32, pad: f32, fieldMin: vec4<f32>, dims: vec4<u32> }
struct Thread { a: u32, b: u32, rest: f32, alpha: f32 }
struct Colour { offset: u32, count: u32 }
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> x: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> v: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> pa: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> w: array<f32>;
// The threads and bends, colour by colour.
@group(0) @binding(5) var<storage, read> threads: array<Thread>;
@group(0) @binding(6) var dist: texture_3d<f32>;
@group(0) @binding(7) var norm: texture_3d<f32>;
// How low each point may go: the floor, and for a waistband's points a centimetre under where it was sewn
// (as Drape#holdRing and its floor do it).
@group(0) @binding(8) var<storage, read> lowest: array<f32>;
// The colour being solved (a dynamic offset per colour).
@group(1) @binding(0) var<uniform> C: Colour;

@compute @workgroup_size(${GROUP}) fn predict(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x; if (i >= P.n) { return; }
  var vv = v[i]; vv.y += P.fall; v[i] = vv;
  pa[i] = x[i] + vv * P.h;
}

// One colour of threads: none of them shares a point, so each moves its two points without a race.
@compute @workgroup_size(${GROUP}) fn solve(@builtin(global_invocation_id) id: vec3<u32>) {
  let k = id.x; if (k >= C.count) { return; }
  let t = threads[C.offset + k];
  let wa = w[t.a]; let wb = w[t.b];
  let d = pa[t.a].xyz - pa[t.b].xyz; let len = length(d);
  if (len < 1e-9) { return; }
  let lambda = -(len - t.rest) / (wa + wb + t.alpha);
  let s = d / len * lambda;
  pa[t.a] = vec4<f32>(pa[t.a].xyz + s * wa, 0.0);
  pa[t.b] = vec4<f32>(pa[t.b].xyz - s * wb, 0.0);
}

// The skin's distance at a point and its normal there (blended from the 8 grid points round it), as
// SkinField#grid does it; the band (far outside) off the grid.
fn field(q: vec3<f32>) -> vec4<f32> {
  let f = (q - P.fieldMin.xyz) / P.cell; let c = floor(f);
  let dims = vec3<f32>(P.dims.xyz);
  if (any(c < vec3<f32>(0.0)) || any(c >= dims - vec3<f32>(1.0))) { return vec4<f32>(P.band, 0.0, 0.0, 0.0); }
  let u = f - c; let base = vec3<i32>(c);
  var d = 0.0; var n = vec3<f32>(0.0);
  for (var k = 0; k < 8; k++) {
    let o = vec3<i32>(k & 1, (k >> 1u) & 1, k >> 2u);
    let wgt = select(1.0 - u.x, u.x, o.x == 1) * select(1.0 - u.y, u.y, o.y == 1) * select(1.0 - u.z, u.z, o.z == 1);
    d += textureLoad(dist, base + o, 0).x * wgt;
    n += textureLoad(norm, base + o, 0).xyz * wgt;
  }
  let l = length(n);
  if (l < 1e-3) { return vec4<f32>(P.band, 0.0, 0.0, 0.0); }
  return vec4<f32>(d, n / l);
}

@compute @workgroup_size(${GROUP}) fn collide(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x; if (i >= P.n) { return; }
  var q = pa[i].xyz; let s = field(q);
  if (s.x < P.thick) { q += s.yzw * (P.thick - s.x); }
  q.y = max(q.y, lowest[i]);
  pa[i] = vec4<f32>(q, 0.0);
}

@compute @workgroup_size(${GROUP}) fn finish(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x; if (i >= P.n) { return; }
  let q = pa[i];
  v[i] = (q - x[i]) / P.h * P.drag;
  x[i] = q;
}
`

// Constraints (pairs of points, rest lengths, compliance) coloured greedily so no two of one colour share a
// point: { threads (Uint8Array, 16 bytes each: a, b, rest, alpha), colours: [[offset, count], ...] }.
export function coloured(lists) {
  const all = []
  for (const { pairs, rest, alphaOf } of lists) {
    const used = new Map()
    const colourOf = new Int32Array(rest.length)
    let most = 0
    for (let e = 0; e < rest.length; e++) {
      const a = pairs[2 * e], b = pairs[2 * e + 1]
      const ua = used.get(a) ?? 0n, ub = used.get(b) ?? 0n
      let c = 0
      while (((ua | ub) >> BigInt(c)) & 1n) c++
      colourOf[e] = c; most = Math.max(most, c + 1)
      used.set(a, ua | (1n << BigInt(c))); used.set(b, ub | (1n << BigInt(c)))
    }
    for (let c = 0; c < most; c++) {
      const group = []
      for (let e = 0; e < rest.length; e++) if (colourOf[e] === c) group.push([pairs[2 * e], pairs[2 * e + 1], rest[e], alphaOf(e)])
      all.push(group)
    }
  }
  const total = all.reduce((n, g) => n + g.length, 0)
  const buffer = new ArrayBuffer(16 * Math.max(1, total)), u = new Uint32Array(buffer), f = new Float32Array(buffer)
  const colours = []
  let k = 0
  for (const group of all) {
    colours.push([k, group.length])
    for (const [a, b, rest, alpha] of group) { u[4 * k] = a; u[4 * k + 1] = b; f[4 * k + 2] = rest; f[4 * k + 3] = alpha; k++ }
  }
  return { threads: new Uint8Array(buffer), colours }
}

export class GpuCloth {
  static async create(drape) {
    if (typeof navigator === "undefined" || !navigator.gpu) return null
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
    if (!adapter) return null
    const device = await adapter.requestDevice()
    device.pushErrorScope("validation")
    const cloth = new GpuCloth(device, drape, adapter)
    const error = await device.popErrorScope()
    if (error) { device.destroy(); throw new Error(error.message) }
    return cloth
  }

  constructor(device, drape, adapter) {
    this.device = device
    this.adapter = adapter
    const n = this.n = drape.x.length / 3
    const h = FRAME / SUBSTEPS
    const params = drape.params
    const stretch = params.stretch / (h * h), ribStretch = CLOTHS.rib.stretch / (h * h), bendC = params.bend / (h * h)
    const HEM_BEND = 0.08   // (as drape.js has it)
    const { threads, colours } = coloured([
      { pairs: drape.edges, rest: drape.rest, alphaOf: e => (drape.edgeRib[e] ? ribStretch : stretch) },
      { pairs: drape.bends, rest: drape.bendRest, alphaOf: e => (drape.bendHem[e] ? bendC * HEM_BEND : bendC) }
    ])
    this.colours = colours
    const buffer = (data, usage) => {
      const buf = device.createBuffer({ size: Math.max(16, Math.ceil(data.byteLength / 4) * 4), usage: usage | GPUBufferUsage.COPY_DST })
      device.queue.writeBuffer(buf, 0, data)
      return buf
    }
    const vec4 = src => { const out = new Float32Array(4 * n); for (let i = 0; i < n; i++) { out[4 * i] = src[3 * i]; out[4 * i + 1] = src[3 * i + 1]; out[4 * i + 2] = src[3 * i + 2] } return out }
    const STORAGE = GPUBufferUsage.STORAGE
    this.x = buffer(vec4(drape.x), STORAGE | GPUBufferUsage.COPY_SRC)
    this.v = buffer(new Float32Array(4 * n), STORAGE)
    this.pa = buffer(new Float32Array(4 * n), STORAGE)
    this.w = buffer(Float32Array.from(drape.w), STORAGE)
    const threadsBuffer = buffer(threads, STORAGE)
    const lowest = new Float32Array(n).fill(-1e9)
    if (drape.floor !== null && drape.floor !== undefined) lowest.fill(drape.floor)
    if (drape.ring) {
      const points = drape.map ? drape.ring.order.map(i => drape.map[i]) : drape.ring.order
      for (const j of points) lowest[j] = Math.max(lowest[j], (drape.ring.sewnAt?.get(j) ?? drape.x[3 * j + 1]) - 0.01)
    }
    const lowestBuffer = buffer(lowest, STORAGE)
    // The skin's field as two 3D textures: distance, and the normal (as SkinField keeps it, -127..127).
    const field = drape.field
    const [nx, ny, nz] = field.dims
    const dist = device.createTexture({ size: [nx, ny, nz], dimension: "3d", format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
    device.queue.writeTexture({ texture: dist }, field.distance, { bytesPerRow: 4 * nx, rowsPerImage: ny }, [nx, ny, nz])
    const normals = new Int8Array(4 * nx * ny * nz)
    for (let g = 0; g < nx * ny * nz; g++) { normals[4 * g] = field.normal[3 * g]; normals[4 * g + 1] = field.normal[3 * g + 1]; normals[4 * g + 2] = field.normal[3 * g + 2] }
    const norm = device.createTexture({ size: [nx, ny, nz], dimension: "3d", format: "rgba8snorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
    device.queue.writeTexture({ texture: norm }, normals, { bytesPerRow: 4 * nx, rowsPerImage: ny }, [nx, ny, nz])
    // Params: as one small uniform block.
    const p = new ArrayBuffer(64), pu = new Uint32Array(p), pf = new Float32Array(p)
    pu[0] = n; pf[1] = h; pf[2] = GRAVITY * h; pf[3] = Math.exp(-params.drag * h); pf[4] = params.thickness
    pf[5] = field.cell; pf[6] = field.band
    pf[8] = field.min[0]; pf[9] = field.min[1]; pf[10] = field.min[2]
    pu[12] = nx; pu[13] = ny; pu[14] = nz
    const uniform = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(uniform, 0, p)
    const module = device.createShaderModule({ code: SHADER })
    this.compiled = module.getCompilationInfo?.()
    const layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      ...[1, 2, 3].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } })),
      ...[4, 5].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } })),
      { binding: 6, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float", viewDimension: "3d" } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float", viewDimension: "3d" } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } }
    ] })
    const colourLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 8 } }
    ] })
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout, colourLayout] })
    this.pipelines = Object.fromEntries(["predict", "solve", "collide", "finish"].map(entryPoint =>
      [entryPoint, device.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint } })]))
    this.group = device.createBindGroup({ layout, entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: this.x } }, { binding: 2, resource: { buffer: this.v } },
      { binding: 3, resource: { buffer: this.pa } }, { binding: 4, resource: { buffer: this.w } },
      { binding: 5, resource: { buffer: threadsBuffer } },
      { binding: 6, resource: dist.createView() }, { binding: 7, resource: norm.createView() },
      { binding: 8, resource: { buffer: lowestBuffer } }
    ] })
    // Each colour's range, 256 bytes apart (the alignment dynamic offsets need).
    const ranges = new Uint32Array(64 * Math.max(1, colours.length))
    colours.forEach(([offset, count], c) => { ranges[64 * c] = offset; ranges[64 * c + 1] = count })
    const rangeBuffer = buffer(ranges, GPUBufferUsage.UNIFORM)
    this.colourGroup = device.createBindGroup({ layout: colourLayout, entries: [{ binding: 0, resource: { buffer: rangeBuffer, size: 8 } }] })
  }

  // Runs `frames` frames (each SUBSTEPS small steps) in one submission, and waits for the GPU to finish.
  async run(frames) {
    const encoder = this.device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    pass.setBindGroup(0, this.group)
    const groups = Math.ceil(this.n / GROUP)
    for (let f = 0; f < frames; f++) {
      for (let st = 0; st < SUBSTEPS; st++) {
        pass.setBindGroup(1, this.colourGroup, [0])
        pass.setPipeline(this.pipelines.predict)
        pass.dispatchWorkgroups(groups)
        pass.setPipeline(this.pipelines.solve)
        this.colours.forEach(([, count], c) => {
          pass.setBindGroup(1, this.colourGroup, [256 * c])
          pass.dispatchWorkgroups(Math.ceil(count / GROUP))
        })
        pass.setPipeline(this.pipelines.collide)
        pass.dispatchWorkgroups(groups)
        pass.setPipeline(this.pipelines.finish)
        pass.dispatchWorkgroups(groups)
      }
    }
    pass.end()
    this.device.pushErrorScope("validation")
    this.device.queue.submit([encoder.finish()])
    const error = await this.device.popErrorScope()
    if (error) throw new Error(error.message)
    await this.device.queue.onSubmittedWorkDone()
  }

  // The cloth's points, read back (Float32Array, 3 per point).
  async read() {
    const size = 16 * this.n
    const staging = this.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const encoder = this.device.createCommandEncoder()
    encoder.copyBufferToBuffer(this.x, 0, staging, 0, size)
    this.device.queue.submit([encoder.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    const four = new Float32Array(staging.getMappedRange().slice(0))
    staging.unmap()
    const out = new Float32Array(3 * this.n)
    for (let i = 0; i < this.n; i++) { out[3 * i] = four[4 * i]; out[3 * i + 1] = four[4 * i + 1]; out[3 * i + 2] = four[4 * i + 2] }
    return out
  }

  destroy() {
    this.device.destroy()
  }
}

// A copy of a drape to step without touching the one shown: its moving arrays copied, the rest shared.
function copyOf(drape) {
  const copy = Object.assign(Object.create(Object.getPrototypeOf(drape)), drape)
  copy.x = Float32Array.from(drape.x); copy.p = Float32Array.from(drape.p); copy.v = Float32Array.from(drape.v)
  copy.params = { ...drape.params }
  return copy
}

// Times drape.js's step against the GPU's on the same sewn cloth, from where it lies: `frames` frames each,
// the CPU with everything it does and without the cloth touching itself (which the GPU doesn't do yet).
// Returns { points, frames, cpu: { msPerFrame, withoutSelf }, gpu: { msPerFrame, firstMs } | { unavailable },
// apart: { rms, most } (m, CPU and GPU cloth after the frames: not the same solver, so only roughly alike) }.
export async function benchDrape(drape, { frames = 120 } = {}) {
  const result = { points: drape.x.length / 3, frames, cpu: {}, gpu: null }
  const cpu = copyOf(drape)
  let t = performance.now()
  for (let f = 0; f < frames; f++) cpu.step({ gravity: true, sew: false })
  result.cpu.msPerFrame = (performance.now() - t) / frames
  const lone = copyOf(drape)
  lone.selfCollide = () => {}
  t = performance.now()
  for (let f = 0; f < frames; f++) lone.step({ gravity: true, sew: false })
  result.cpu.withoutSelf = (performance.now() - t) / frames
  let gpu = null
  try {
    gpu = await GpuCloth.create(drape)
  } catch (error) {
    result.gpu = { unavailable: String(error?.message ?? error) }
    return result
  }
  if (!gpu) { result.gpu = { unavailable: "no WebGPU here" }; return result }
  try {
    t = performance.now()
    await gpu.run(1)
    const firstMs = performance.now() - t
    t = performance.now()
    await gpu.run(frames)
    result.gpu = { msPerFrame: (performance.now() - t) / frames, firstMs, adapter: gpu.adapter.info?.description || gpu.adapter.info?.vendor || "" }
    const x = await gpu.read()
    let sum = 0, most = 0
    for (let i = 0; i < x.length; i += 3) {
      const d = Math.hypot(x[i] - lone.x[i], x[i + 1] - lone.x[i + 1], x[i + 2] - lone.x[i + 2])
      sum += d * d; most = Math.max(most, d)
    }
    result.apart = { rms: Math.sqrt(sum / (x.length / 3)), most }
  } finally {
    gpu.destroy()
  }
  return result
}
