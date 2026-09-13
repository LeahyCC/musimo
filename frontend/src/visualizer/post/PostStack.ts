/**
 * The post stack: everything between the scene and the swap chain.
 *
 *   scene ──► history[current] ──► bright ──► blur x3 ──► composite ──► canvas
 *                   ▲  add                                    ▲
 *                   └── history[other], zoomed and decayed ────┘
 *
 * The scene draws into one of two floating-point history textures instead of
 * the canvas, so its brightest pixels survive past 1 and the tonemap in the
 * composite has something to roll off. The feedback pass adds the other
 * history texture back over it, warped a little, and the two swap each frame.
 *
 * Like the scene, this belongs to the renderer singleton, so the pipelines,
 * the sampler and the parameters outlive every remount. The textures do not:
 * they are sized from the canvas and rebuilt whenever that size changes,
 * which a dock or popout move always does, so the trails start again from
 * black on each move while the particle field itself keeps running.
 */
import blur from '../shaders/post.blur.wgsl?raw'
import bright from '../shaders/post.bright.wgsl?raw'
import common from '../shaders/post.common.wgsl?raw'
import composite from '../shaders/post.composite.wgsl?raw'
import feedback from '../shaders/post.feedback.wgsl?raw'
import {
  BLOOM_LEVELS,
  bloomLevelSize,
  bloomSourceSize,
  defaultPostParams,
  mergePostParams,
  POST_UNIFORM_FLOATS,
  stageEnabled,
  writePostUniform,
} from './params'
import type { PostParams, PostPatch } from './params'

/**
 * The scene sums thousands of additively blended particles, so its cores run
 * well past 1. Half floats keep that headroom and are filterable, which the
 * blur and the warp both need. The scene renders into this format rather than
 * the canvas's, so the renderer hands it to the scene as well.
 */
export const SCENE_FORMAT: GPUTextureFormat = 'rgba16float'
const BLUR_STEP_BYTES = 16
const BLACK: GPUColor = { r: 0, g: 0, b: 0, a: 1 }

type Target = { texture: GPUTexture; view: GPUTextureView }
type Pair<T> = readonly [T, T]

type Level = {
  target: Target
  temp: Target
  /** Reads the level above into this level's temp, halving it. */
  horizontal: GPUBindGroup
  /** Reads this level's temp back into the level. */
  vertical: GPUBindGroup
  steps: Pair<GPUBuffer>
}

type Gear = {
  device: GPUDevice
  sampler: GPUSampler
  uniform: GPUBuffer
  feedback: GPURenderPipeline
  bright: GPURenderPipeline
  blur: GPURenderPipeline
  composite: GPURenderPipeline
}

type Sized = {
  width: number
  height: number
  history: Pair<Target>
  levels: Level[]
  /** Indexed by the history the scene drew into; reads the other one. */
  feedback: Pair<GPUBindGroup>
  bright: Pair<GPUBindGroup>
  composite: Pair<GPUBindGroup>
}

export class PostStack {
  private gear: Gear | null = null
  private sized: Sized | null = null
  private current: 0 | 1 = 0
  private settings = defaultPostParams()
  private readonly uniformData = new Float32Array(POST_UNIFORM_FLOATS)

  init(device: GPUDevice, format: GPUTextureFormat) {
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

    const pipeline = (code: string, target: GPUColorTargetState) => {
      const shader = module(code)
      return device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: shader, entryPoint: 'vs' },
        fragment: { module: shader, entryPoint: 'fs', targets: [target] },
        primitive: { topology: 'triangle-list' },
      })
    }

    this.gear = {
      device,
      // Linear and clamped: the warp, the downsamples and the blur all rely on
      // the hardware filtering, and a trail must not wrap at the edge.
      sampler: device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      }),
      uniform: device.createBuffer({
        size: POST_UNIFORM_FLOATS * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
      // The scene has already drawn into the target, so the history is added
      // to it rather than read back and mixed.
      feedback: pipeline(feedback, {
        format: SCENE_FORMAT,
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        },
      }),
      bright: pipeline(bright, { format: SCENE_FORMAT }),
      blur: pipeline(blur, { format: SCENE_FORMAT }),
      composite: pipeline(composite, { format }),
    }
  }

  get params(): PostParams {
    return this.settings
  }

  /** Apply a patch. The development handle sets one stage at a time this way. */
  setParams(patch: PostPatch) {
    this.settings = mergePostParams(this.settings, patch)
  }

  /**
   * Draw from this object from now on, rather than a copy of it. The renderer
   * rewrites it every frame from the preset and its audio mapping, and a
   * clone per frame would be thrown away on the next one.
   */
  useParams(params: PostParams) {
    this.settings = params
  }

  /**
   * Where the scene should draw this frame, sizing the textures first. The
   * scene always goes through the stack, even with every stage off, because
   * the canvas is written in the composite and nowhere else.
   */
  target(width: number, height: number): GPUTextureView | null {
    if (!this.gear) return null
    this.resize(width, height)
    return this.sized?.history[this.current].view ?? null
  }

  /** Run the stack over what the scene drew and write `view`. */
  render(encoder: GPUCommandEncoder, view: GPUTextureView, features: Float32Array) {
    const gear = this.gear
    const sized = this.sized
    if (!gear || !sized) return
    const other = this.current === 0 ? 1 : 0
    writePostUniform(this.settings, features, sized.width, sized.height, this.uniformData)
    gear.device.queue.writeBuffer(gear.uniform, 0, this.uniformData)

    if (stageEnabled(this.settings, 'feedback')) {
      const into = sized.history[this.current].view
      draw(encoder, gear.feedback, sized.feedback[this.current], into, 'load')
    }

    if (stageEnabled(this.settings, 'bloom')) {
      const first = sized.levels[0]
      if (first) {
        draw(encoder, gear.bright, sized.bright[this.current], first.target.view, 'clear')
        for (const level of sized.levels) {
          draw(encoder, gear.blur, level.horizontal, level.temp.view, 'clear')
          draw(encoder, gear.blur, level.vertical, level.target.view, 'clear')
        }
      }
    }

    draw(encoder, gear.composite, sized.composite[this.current], view, 'clear')
    // The frame just drawn becomes next frame's history.
    this.current = other
  }

  /** Rebuild every texture for a new canvas size. The trails restart. */
  private resize(width: number, height: number) {
    const gear = this.gear
    if (!gear || (this.sized?.width === width && this.sized.height === height)) return
    this.release()
    const { device } = gear
    const make = (w: number, h: number): Target => {
      const texture = device.createTexture({
        size: { width: Math.max(1, w), height: Math.max(1, h) },
        format: SCENE_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      })

      return { texture, view: texture.createView() }
    }

    const history: Pair<Target> = [make(width, height), make(width, height)]
    const levels: Level[] = []
    for (let index = 0; index < BLOOM_LEVELS; index++) {
      const size = bloomLevelSize(width, height, index)
      const target = make(size.width, size.height)
      const temp = make(size.width, size.height)
      // The horizontal pass reads the texture named by bloomSourceSize, so
      // its taps are spaced by that texture's texels; the vertical pass stays
      // inside this level.
      const from = bloomSourceSize(width, height, index)
      const steps: Pair<GPUBuffer> = [
        blurStep(device, 1 / from.width, 1 / from.height, 1, 0),
        blurStep(device, 1 / size.width, 1 / size.height, 0, 1),
      ]
      const source = index === 0 ? target : (levels[index - 1]?.target ?? target)
      levels.push({
        target,
        temp,
        horizontal: device.createBindGroup({
          layout: gear.blur.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: steps[0] } },
            { binding: 1, resource: gear.sampler },
            { binding: 2, resource: source.view },
          ],
        }),
        vertical: device.createBindGroup({
          layout: gear.blur.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: steps[1] } },
            { binding: 1, resource: gear.sampler },
            { binding: 2, resource: temp.view },
          ],
        }),
        steps,
      })
    }

    // One bind group per history texture the scene might have drawn into.
    const forHistory = (
      build: (drawn: Target, previous: Target) => GPUBindGroup,
    ): Pair<GPUBindGroup> => [build(history[0], history[1]), build(history[1], history[0])]

    const bloomViews = levels.map((level, index) => ({
      binding: 3 + index,
      resource: level.target.view,
    }))

    this.sized = {
      width,
      height,
      history,
      levels,
      feedback: forHistory((_, previous) =>
        gear.device.createBindGroup({
          layout: gear.feedback.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: gear.uniform } },
            { binding: 1, resource: gear.sampler },
            { binding: 2, resource: previous.view },
          ],
        }),
      ),
      bright: forHistory((drawn) =>
        gear.device.createBindGroup({
          layout: gear.bright.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: gear.uniform } },
            { binding: 1, resource: gear.sampler },
            { binding: 2, resource: drawn.view },
          ],
        }),
      ),
      composite: forHistory((drawn) =>
        gear.device.createBindGroup({
          layout: gear.composite.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: gear.uniform } },
            { binding: 1, resource: gear.sampler },
            { binding: 2, resource: drawn.view },
            ...bloomViews,
          ],
        }),
      ),
    }
  }

  private release() {
    const sized = this.sized
    if (!sized) return
    for (const target of sized.history) target.texture.destroy()
    for (const level of sized.levels) {
      level.target.texture.destroy()
      level.temp.texture.destroy()
      for (const step of level.steps) step.destroy()
    }
    this.sized = null
  }

  /** The device is gone or going: drop everything that belonged to it. */
  dispose() {
    this.release()
    this.gear?.uniform.destroy()
    this.gear = null
  }
}

function draw(
  encoder: GPUCommandEncoder,
  pipeline: GPURenderPipeline,
  group: GPUBindGroup,
  view: GPUTextureView,
  loadOp: GPULoadOp,
) {
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view, clearValue: BLACK, loadOp, storeOp: 'store' }],
  })
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, group)
  pass.draw(3)
  pass.end()
}

function blurStep(device: GPUDevice, x: number, y: number, dx: number, dy: number) {
  const buffer = device.createBuffer({
    size: BLUR_STEP_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(buffer, 0, new Float32Array([x, y, dx, dy]))
  return buffer
}
