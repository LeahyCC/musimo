/**
 * The third scene: one full-screen fragment pass marching a signed distance
 * field, a Mandelbox whose fold the music bends. How far it bends, how often
 * it folds and where the camera sits all come from the preset's numbers with
 * its mapping already added; see `raymarch.params.ts`.
 *
 *   ray per pixel ─► fold ─► surface ─► shadow ─► occlusion from the steps
 *
 * There is no simulation state here, unlike the particle field and the fluid:
 * every frame is drawn from the uniform alone, so nothing is lost when the
 * stage remounts and nothing has to be rebuilt on a resize. The scene still
 * belongs to the renderer singleton, like the other two.
 *
 * The march is fill-bound, so the one number that decides the frame cost is
 * the step cap, chosen in the stage's top bar. A software rasteriser gets half
 * of it and marches at half the canvas, then the result is stretched back.
 */
import type { Tuning } from '../presets/knobs'
import common from '../shaders/raymarch.common.wgsl?raw'
import marchShader from '../shaders/raymarch.march.wgsl?raw'
import upscaleShader from '../shaders/raymarch.upscale.wgsl?raw'
import { DEFAULT_RAYMARCH_STEPS } from './catalog'
import {
  MARCH_UNIFORM_FLOATS,
  marchFrame,
  marchSize,
  marchSteps,
  raymarchParams,
  renderScale,
  writeMarchUniform,
} from './raymarch.params'
import type { Scene, SceneContext } from './Scene'

const TARGET_FORMAT: GPUTextureFormat = 'rgba16float'

type Gear = {
  device: GPUDevice
  uniform: GPUBuffer
  sampler: GPUSampler
  march: GPURenderPipeline
  upscale: GPURenderPipeline
  group: GPUBindGroup
}

/** Only built where the march runs below the canvas, so on a rasteriser. */
type Half = {
  width: number
  height: number
  texture: GPUTexture
  view: GPUTextureView
  group: GPUBindGroup
}

export class Raymarch implements Scene {
  private context: SceneContext | null = null
  private gear: Gear | null = null
  private half: Half | null = null
  private wanted: number
  private steps = DEFAULT_RAYMARCH_STEPS
  private width = 1
  private height = 1
  private readonly uniformData = new Float32Array(MARCH_UNIFORM_FLOATS)

  constructor(steps = DEFAULT_RAYMARCH_STEPS) {
    this.wanted = steps
  }

  /** Takes effect on the next frame; there is no state to lose. */
  setSteps(steps: number) {
    this.wanted = steps
  }

  /** One line for the debug overlay and the canvas dataset. */
  get detail() {
    return `${this.steps}-step raymarch`
  }

  init(context: SceneContext) {
    this.context = context
    const { device, format } = context
    const module = (code: string) => {
      const shader = device.createShaderModule({ code })
      void shader.getCompilationInfo().then((info) => {
        for (const message of info.messages) {
          if (message.type === 'error')
            console.error(`WGSL ${message.lineNum}:${message.linePos} ${message.message}`)
        }
      })

      return shader
    }

    const marchModule = module(common + marchShader)
    const upscaleModule = module(upscaleShader)
    const march = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: marchModule, entryPoint: 'vs' },
      fragment: { module: marchModule, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    })

    const uniform = device.createBuffer({
      size: MARCH_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    this.gear = {
      device,
      uniform,
      sampler: device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      }),
      march,
      upscale: device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: upscaleModule, entryPoint: 'vs' },
        fragment: { module: upscaleModule, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      }),
      group: device.createBindGroup({
        layout: march.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniform } }],
      }),
    }

    this.allocate()
  }

  resize(width: number, height: number) {
    this.width = Math.max(1, width)
    this.height = Math.max(1, height)
    this.allocate()
  }

  // At full resolution the march writes the post stack's texture directly and
  // nothing is allocated here at all.
  private allocate() {
    const gear = this.gear
    const context = this.context
    if (!gear || !context) return
    const size = marchSize(this.width, this.height, context.software)
    if (renderScale(context.software) === 1) {
      this.release()
      return
    }

    if (this.half?.width === size.width && this.half.height === size.height) return
    this.release()
    const texture = gear.device.createTexture({
      size: { width: size.width, height: size.height },
      format: TARGET_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })

    const view = texture.createView()
    this.half = {
      width: size.width,
      height: size.height,
      texture,
      view,
      group: gear.device.createBindGroup({
        layout: gear.upscale.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: gear.sampler },
          { binding: 1, resource: view },
        ],
      }),
    }
  }

  update(features: Float32Array, dt: number, tuning: Tuning) {
    const gear = this.gear
    const context = this.context
    if (!gear || !context) return
    this.steps = marchSteps(this.wanted, context.software)
    const frame = marchFrame(raymarchParams(tuning), features, this.steps)
    const size = this.half ?? { width: this.width, height: this.height }
    writeMarchUniform(frame, size.width, size.height, this.uniformData)
    gear.device.queue.writeBuffer(gear.uniform, 0, this.uniformData)
    void dt
  }

  render(encoder: GPUCommandEncoder, view: GPUTextureView) {
    const gear = this.gear
    if (!gear) return
    const half = this.half
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: half?.view ?? view,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    })
    pass.setPipeline(gear.march)
    pass.setBindGroup(0, gear.group)
    pass.draw(3)
    pass.end()
    if (!half) return

    const blit = encoder.beginRenderPass({
      colorAttachments: [
        { view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' },
      ],
    })
    blit.setPipeline(gear.upscale)
    blit.setBindGroup(0, half.group)
    blit.draw(3)
    blit.end()
  }

  private release() {
    this.half?.texture.destroy()
    this.half = null
  }

  dispose() {
    this.release()
    this.gear?.uniform.destroy()
    this.gear = null
    this.context = null
  }
}
