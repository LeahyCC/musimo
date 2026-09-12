/**
 * The first scene: a few hundred thousand particles in a curl-noise flow
 * field, driven by the feature packet. State lives in GPU storage buffers
 * that belong to this object, which the renderer keeps as a singleton, so a
 * remount of the stage never restarts the field.
 */
import { F } from '../audio/FeatureExtractor'
import { lookAt, multiply, perspective } from '../gpu/math'
import common from '../shaders/common.wgsl?raw'
import compute from '../shaders/particles.compute.wgsl?raw'
import render from '../shaders/particles.render.wgsl?raw'
import type { Scene, SceneContext } from './Scene'

export const PARTICLE_COUNTS = [100_000, 250_000, 500_000, 1_000_000] as const
export const DEFAULT_PARTICLES = 250_000
// A CPU rasteriser manages a few thousand particles at best.
const SOFTWARE_CAP = 20_000
const PARTICLE_BYTES = 32
const WORKGROUP = 256
// Params struct in common.wgsl: mat4x4 (64) + vec2 (8) + 2 u32 (8) + 2 f32 (8) + pad (8).
const PARAMS_BYTES = 96
const FOV = Math.PI / 3

export class Particles implements Scene {
  private context: SceneContext | null = null
  private computePipeline: GPUComputePipeline | null = null
  private renderPipeline: GPURenderPipeline | null = null
  private params: GPUBuffer | null = null
  private readonly paramsData = new ArrayBuffer(PARAMS_BYTES)
  private readonly paramsFloats = new Float32Array(this.paramsData)
  private readonly paramsUints = new Uint32Array(this.paramsData)
  private particles: GPUBuffer | null = null
  private computeGroup: GPUBindGroup | null = null
  private renderGroup: GPUBindGroup | null = null
  private count = 0
  private wanted: number
  private reset = true
  private width = 1
  private height = 1
  private projection = perspective(FOV, 1, 0.1, 20)
  private readonly camera = new Float32Array(16)

  constructor(count = DEFAULT_PARTICLES) {
    this.wanted = count
  }

  /** Takes effect on the next frame; the field restarts. */
  setCount(count: number) {
    this.wanted = count
  }

  get particleCount() {
    return this.count
  }

  init(context: SceneContext) {
    this.context = context
    const { device, format } = context
    const computeModule = device.createShaderModule({ code: common + compute })
    const renderModule = device.createShaderModule({ code: common + render })
    for (const module of [computeModule, renderModule]) {
      void module.getCompilationInfo().then((info) => {
        for (const message of info.messages) {
          if (message.type === 'error')
            console.error(`WGSL ${message.lineNum}:${message.linePos} ${message.message}`)
        }
      })
    }
    this.computePipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: computeModule, entryPoint: 'main' },
    })

    this.renderPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: renderModule, entryPoint: 'vs' },
      fragment: {
        module: renderModule,
        entryPoint: 'fs',
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    })

    this.params = device.createBuffer({
      size: PARAMS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.allocate()
  }

  private allocate() {
    const context = this.context
    if (!context || !this.computePipeline || !this.renderPipeline || !this.params) return
    this.particles?.destroy()
    this.count = context.software ? Math.min(this.wanted, SOFTWARE_CAP) : this.wanted
    this.particles = context.device.createBuffer({
      size: this.count * PARTICLE_BYTES,
      usage: GPUBufferUsage.STORAGE,
    })
    const entries = (particles: GPUBuffer) => [
      { binding: 0, resource: { buffer: context.features } },
      { binding: 1, resource: { buffer: this.params as GPUBuffer } },
      { binding: 2, resource: { buffer: particles } },
    ]
    this.computeGroup = context.device.createBindGroup({
      layout: this.computePipeline.getBindGroupLayout(0),
      entries: entries(this.particles),
    })

    this.renderGroup = context.device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: entries(this.particles),
    })
    this.reset = true
  }

  resize(width: number, height: number) {
    this.width = Math.max(1, width)
    this.height = Math.max(1, height)
    this.projection = perspective(FOV, this.width / this.height, 0.1, 20)
  }

  update(features: Float32Array, dt: number) {
    const context = this.context
    if (!context || !this.params) return
    const applied = context.software ? Math.min(this.wanted, SOFTWARE_CAP) : this.wanted
    if (applied !== this.count) this.allocate()
    const time = features[F.time] ?? 0
    // A slow orbit, with a little lift that breathes on the beat.
    const yaw = time * 0.06
    const lift = 0.5 + Math.sin(time * 0.13) * 0.3 + (features[F.beatPulse] ?? 0) * 0.15
    const view = lookAt([Math.sin(yaw) * 3.2, lift, Math.cos(yaw) * 3.2], [0, 0, 0], [0, 1, 0])
    multiply(this.projection, view, this.camera)
    this.paramsFloats.set(this.camera, 0)
    this.paramsFloats[16] = this.width
    this.paramsFloats[17] = this.height
    this.paramsUints[18] = this.count
    this.paramsUints[19] = this.reset ? 1 : 0
    // Point size in framebuffer pixels, so full screen at 2x keeps the look.
    const pointSize = 1.6 + (this.height / 720) * 1.2
    this.paramsFloats[20] = pointSize
    // Additive blending sums every particle a pixel receives, so each one is
    // dimmed by how many are expected to land there: the count times a point's
    // area over the canvas area. That keeps a small docked stage and a 4K full
    // screen at the same brightness instead of one washing out to white.
    const cover = (this.count * Math.PI * pointSize * pointSize) / (this.width * this.height)
    this.paramsFloats[21] = Math.min(1, Math.max(0.006, 0.65 / cover))
    context.device.queue.writeBuffer(this.params, 0, this.paramsData)
    this.reset = false
    void dt
  }

  render(encoder: GPUCommandEncoder, view: GPUTextureView) {
    if (!this.computePipeline || !this.renderPipeline || !this.computeGroup || !this.renderGroup)
      return
    const compute = encoder.beginComputePass()
    compute.setPipeline(this.computePipeline)
    compute.setBindGroup(0, this.computeGroup)
    compute.dispatchWorkgroups(Math.ceil(this.count / WORKGROUP))
    compute.end()
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: { r: 0.008, g: 0.012, b: 0.02, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    })
    pass.setPipeline(this.renderPipeline)
    pass.setBindGroup(0, this.renderGroup)
    pass.draw(6, this.count)
    pass.end()
  }

  dispose() {
    this.particles?.destroy()
    this.params?.destroy()
    this.particles = null
    this.params = null
    this.context = null
  }
}
