/**
 * The second scene: Stam's stable fluids on a square grid of compute
 * textures, with the music injecting velocity and dye on every onset. What an
 * injection is worth, and every decay and strength around it, comes from the
 * preset's numbers with its mapping already added; see `fluid.params.ts`.
 *
 *   advect ─► diffuse ─► vorticity and injection ─► project ─► advect dye
 *
 * The grid is 512 or 1024 texels a side and does not follow the canvas, so
 * nothing is rebuilt on a resize: the square covers the canvas and the
 * overflow is cropped, and `visibleExtent` keeps the emitters inside the band
 * that is actually on screen. Like the particle field this object belongs to
 * the renderer singleton, so a remount of the stage never restarts the fluid.
 *
 * Every field is `rgba16float`, including the three that carry one number
 * (curl, divergence, pressure). `r32float` would halve their memory but is
 * not filterable, so each would need a bind group layout of its own; one
 * format means one layout, and any three fields can go to any step. Curl is
 * read before divergence is written, so both live in the scratch field.
 */
import type { Tuning } from '../presets/knobs'
import common from '../shaders/fluid.common.wgsl?raw'
import render from '../shaders/fluid.render.wgsl?raw'
import simulation from '../shaders/fluid.sim.wgsl?raw'
import { DEFAULT_FLUID_SIZE } from './catalog'
import {
  diffuseIterations,
  fluidFrame,
  fluidParams,
  PALETTE_SIZE,
  paletteLut,
  pressureIterations,
  SIM_UNIFORM_FLOATS,
  simSize,
  visibleExtent,
  writeSimUniform,
} from './fluid.params'
import type { Extent } from './fluid.params'
import type { Scene, SceneContext } from './Scene'

const FIELD_FORMAT: GPUTextureFormat = 'rgba16float'
const WORKGROUP = 8

/** The steps, in the order fluid.sim.wgsl documents. */
const STEPS = [
  'advect_velocity',
  'diffuse',
  'curl',
  'forces',
  'divergence',
  'relax',
  'pressure',
  'gradient',
  'advect_dye',
] as const
type Step = (typeof STEPS)[number]

/** A field of the simulation. The name is only there to key bind groups. */
type Field = { view: GPUTextureView; name: string }
type Pair = readonly [Field, Field]
type Side = 0 | 1

const other = (side: Side): Side => (side === 0 ? 1 : 0)

type Gear = {
  device: GPUDevice
  sampler: GPUSampler
  uniform: GPUBuffer
  palette: GPUTextureView
  paletteTexture: GPUTexture
  layout: GPUBindGroupLayout
  steps: Record<Step, GPUComputePipeline>
  draw: GPURenderPipeline
}

type Sized = {
  size: number
  textures: GPUTexture[]
  velocity: Pair
  dye: Pair
  pressure: Pair
  scratch: Field
  /** One per dye field, since which one holds the dye alternates. */
  draw: readonly [GPUBindGroup, GPUBindGroup]
  /** Built on demand and kept; the sequence below needs a handful. */
  groups: Map<string, GPUBindGroup>
}

export class Fluid implements Scene {
  private context: SceneContext | null = null
  private gear: Gear | null = null
  private sized: Sized | null = null
  private wanted: number
  private velocity: Side = 0
  private dye: Side = 0
  private pressure: Side = 0
  private visible: Extent = { x: 0.5, y: 0.5 }
  private readonly uniformData = new Float32Array(SIM_UNIFORM_FLOATS)

  constructor(size = DEFAULT_FLUID_SIZE) {
    this.wanted = size
  }

  /** Takes effect on the next frame; the fluid restarts. */
  setSize(size: number) {
    this.wanted = size
  }

  get simSize() {
    return this.sized?.size ?? 0
  }

  /** One line for the debug overlay and the canvas dataset. */
  get detail() {
    return `${this.simSize} fluid`
  }

  init(context: SceneContext) {
    this.context = context
    const { device, format } = context
    const module = (code: string) => {
      const shader = device.createShaderModule({ code: common + code })
      void shader.getCompilationInfo().then((info) => {
        for (const message of info.messages) {
          if (message.type === 'error')
            console.error(`WGSL ${message.lineNum}:${message.linePos} ${message.message}`)
        }
      })

      return shader
    }

    // One explicit layout for every step, so any three fields can go to any
    // of them. Under `layout: 'auto'` each step would derive a layout from
    // the bindings it happens to use and no group could be shared.
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        {
          binding: 4,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: FIELD_FORMAT },
        },
      ],
    })

    const simModule = module(simulation)
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] })
    const steps: Partial<Record<Step, GPUComputePipeline>> = {}
    for (const step of STEPS)
      steps[step] = device.createComputePipeline({
        layout: pipelineLayout,
        compute: { module: simModule, entryPoint: step },
      })

    const drawModule = module(render)
    const paletteTexture = device.createTexture({
      size: { width: PALETTE_SIZE, height: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    device.queue.writeTexture(
      { texture: paletteTexture },
      paletteLut(),
      { bytesPerRow: PALETTE_SIZE * 4 },
      { width: PALETTE_SIZE, height: 1 },
    )

    this.gear = {
      device,
      sampler: device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      }),
      uniform: device.createBuffer({
        size: SIM_UNIFORM_FLOATS * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
      palette: paletteTexture.createView(),
      paletteTexture,
      layout,
      steps: steps as Record<Step, GPUComputePipeline>,
      draw: device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: drawModule, entryPoint: 'vs' },
        fragment: { module: drawModule, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      }),
    }

    this.allocate()
  }

  private allocate() {
    const gear = this.gear
    const context = this.context
    if (!gear || !context) return
    this.release()
    const size = simSize(this.wanted, context.software)
    const textures: GPUTexture[] = []
    const field = (name: string): Field => {
      const texture = gear.device.createTexture({
        size: { width: size, height: size },
        format: FIELD_FORMAT,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
      })
      textures.push(texture)
      return { view: texture.createView(), name }
    }

    const velocity: Pair = [field('v0'), field('v1')]
    const dye: Pair = [field('d0'), field('d1')]
    const pressure: Pair = [field('p0'), field('p1')]
    const scratch = field('s')
    const drawGroup = (from: Field) =>
      gear.device.createBindGroup({
        layout: gear.draw.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: gear.uniform } },
          { binding: 1, resource: gear.sampler },
          { binding: 2, resource: from.view },
          { binding: 3, resource: gear.palette },
        ],
      })

    this.sized = {
      size,
      textures,
      velocity,
      dye,
      pressure,
      scratch,
      draw: [drawGroup(dye[0]), drawGroup(dye[1])],
      groups: new Map(),
    }
    this.velocity = 0
    this.dye = 0
    this.pressure = 0
  }

  /** The grid does not follow the canvas; only the crop it is drawn with does. */
  resize(width: number, height: number) {
    this.visible = visibleExtent(width, height)
  }

  update(features: Float32Array, dt: number, tuning: Tuning) {
    const gear = this.gear
    const context = this.context
    if (!gear || !context) return
    if (this.sized?.size !== simSize(this.wanted, context.software)) this.allocate()
    const size = this.sized?.size ?? DEFAULT_FLUID_SIZE
    const frame = fluidFrame(fluidParams(tuning), features, dt, this.visible)
    writeSimUniform(frame, size, this.visible, this.uniformData)
    gear.device.queue.writeBuffer(gear.uniform, 0, this.uniformData)
  }

  render(encoder: GPUCommandEncoder, view: GPUTextureView) {
    const gear = this.gear
    const sized = this.sized
    const context = this.context
    if (!gear || !sized || !context) return
    const { velocity, dye, pressure, scratch } = sized
    const count = Math.ceil(sized.size / WORKGROUP)
    // Dispatches inside one compute pass are ordered and see each other's
    // writes, so the whole step list fits in a single pass.
    const pass = encoder.beginComputePass()
    const step = (name: Step, a: Field, b: Field, into: Field) => {
      pass.setPipeline(gear.steps[name])
      pass.setBindGroup(0, this.group(a, b, into))
      pass.dispatchWorkgroups(count, count)
    }

    // The advected velocity lands in scratch, because the viscosity solve
    // needs it as a right-hand side while both velocity fields ping-pong.
    let side = this.velocity
    step('advect_velocity', velocity[side], velocity[side], scratch)
    const sweeps = Math.max(1, diffuseIterations(context.software))
    for (let sweep = 0; sweep < sweeps; sweep++) {
      const into: Side = sweep % 2 === 0 ? 0 : 1
      step('diffuse', sweep === 0 ? scratch : velocity[other(into)], scratch, velocity[into])
      side = into
    }

    step('curl', velocity[side], velocity[side], scratch)
    step('forces', velocity[side], scratch, velocity[other(side)])
    side = other(side)
    step('divergence', velocity[side], velocity[side], scratch)

    let solve = this.pressure
    step('relax', pressure[solve], pressure[solve], pressure[other(solve)])
    solve = other(solve)
    for (let sweep = 0; sweep < pressureIterations(context.software); sweep++) {
      step('pressure', pressure[solve], scratch, pressure[other(solve)])
      solve = other(solve)
    }

    step('gradient', velocity[side], pressure[solve], velocity[other(side)])
    side = other(side)
    step('advect_dye', dye[this.dye], velocity[side], dye[other(this.dye)])
    pass.end()
    this.velocity = side
    this.pressure = solve
    this.dye = other(this.dye)

    const draw = encoder.beginRenderPass({
      colorAttachments: [
        { view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' },
      ],
    })
    draw.setPipeline(gear.draw)
    draw.setBindGroup(0, sized.draw[this.dye])
    draw.draw(3)
    draw.end()
  }

  /**
   * The bind group for one step. The sequence above asks for a fixed handful
   * of field triples, so each is built the first frame it is needed and kept
   * until the grid is rebuilt.
   */
  private group(a: Field, b: Field, into: Field): GPUBindGroup {
    const sized = this.sized
    const gear = this.gear
    if (!sized || !gear) throw new Error('fluid: no grid')
    const key = `${a.name}>${b.name}>${into.name}`
    const known = sized.groups.get(key)
    if (known) return known
    const group = gear.device.createBindGroup({
      layout: gear.layout,
      entries: [
        { binding: 0, resource: { buffer: gear.uniform } },
        { binding: 1, resource: gear.sampler },
        { binding: 2, resource: a.view },
        { binding: 3, resource: b.view },
        { binding: 4, resource: into.view },
      ],
    })
    sized.groups.set(key, group)
    return group
  }

  private release() {
    for (const texture of this.sized?.textures ?? []) texture.destroy()
    this.sized = null
  }

  dispose() {
    this.release()
    this.gear?.uniform.destroy()
    this.gear?.paletteTexture.destroy()
    this.gear = null
    this.context = null
  }
}
