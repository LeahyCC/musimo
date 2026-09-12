/**
 * The one renderer. It owns the device, the feature buffer, the scene and
 * its particle state, and outlives every stage. A stage hands it a canvas
 * to draw on and takes it back on unmount; the popout portals a fresh stage
 * into another document, so the canvas and its context are the only things
 * made per mount.
 *
 * The animation loop belongs to the window the canvas is in: the tab's
 * requestAnimationFrame stops when the tab is hidden, and a popout window
 * stays visible while the tab is not.
 */
import { audioGraph } from '../audio/AudioGraph'
import { FeatureClient } from '../audio/FeatureClient'
import { F, PACKET_LENGTH } from '../audio/FeatureExtractor'
import { Hud } from '../hud/Hud'
import { DEFAULT_PARTICLES, Particles } from '../scenes/Particles'
import { acquireGpu, configureCanvas, onGpuLost } from './Device'
import type { Gpu, GpuInfo } from './Device'

export type AttachResult = 'ok' | 'unsupported' | 'cancelled'

const describe = (info: GpuInfo) =>
  [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ') ||
  'unknown adapter'

class Renderer {
  private gpu: Gpu | null = null
  private features: GPUBuffer | null = null
  private scene: Particles | null = null
  private client: FeatureClient | null = null
  private canvas: HTMLCanvasElement | null = null
  private attaching: HTMLCanvasElement | null = null
  private context: GPUCanvasContext | null = null
  private hud: Hud | null = null
  private hudVisible = false
  private hudCanvas: HTMLCanvasElement | null = null
  private onFailure: (() => void) | null = null
  private observer: ResizeObserver | null = null
  private unwatchVisibility: (() => void) | null = null
  private frame = 0
  private last = 0
  private time = 0
  private particles = DEFAULT_PARTICLES
  private readonly packet = new Float32Array(PACKET_LENGTH)
  private frameMs = 16.7
  private reported = 0

  constructor() {
    onGpuLost(() => this.recover())
  }

  /**
   * Draw on this canvas until `detach`. Resolves once the device is ready.
   * `onFailure` is called later if the device is lost and cannot be
   * recovered, so the stage can fall back to artwork.
   */
  async attach(
    canvas: HTMLCanvasElement,
    hudCanvas: HTMLCanvasElement,
    onFailure: () => void,
  ): Promise<AttachResult> {
    this.attaching = canvas
    const gpu = await acquireGpu()
    if (this.attaching !== canvas) return 'cancelled'
    this.attaching = null
    if (!gpu) return 'unsupported'
    if (this.canvas) this.detach(this.canvas)
    this.gpu = gpu
    this.features ??= gpu.device.createBuffer({
      size: PACKET_LENGTH * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    if (!this.scene) {
      this.scene = new Particles(this.particles)
      this.scene.init({
        device: gpu.device,
        format: gpu.format,
        features: this.features,
        software: gpu.info.software,
      })
    }
    const context = configureCanvas(gpu, canvas)
    if (!context) return 'unsupported'
    this.canvas = canvas
    this.context = context
    this.hudCanvas = hudCanvas
    this.hud = new Hud(hudCanvas)
    this.hud.setVisible(this.hudVisible)
    this.onFailure = onFailure
    canvas.dataset.adapter = describe(gpu.info)
    const win = canvas.ownerDocument.defaultView ?? window
    this.resize()
    this.observer = new win.ResizeObserver(() => this.resize())
    this.observer.observe(canvas)
    const doc = canvas.ownerDocument
    const onVisibility = () => {
      if (doc.visibilityState === 'visible') this.start()
      else this.stop()
    }
    doc.addEventListener('visibilitychange', onVisibility)
    this.unwatchVisibility = () => doc.removeEventListener('visibilitychange', onVisibility)
    this.start()
    return 'ok'
  }

  /** Stop drawing on this canvas. The device, scene and particles stay. */
  detach(canvas: HTMLCanvasElement) {
    if (this.attaching === canvas) this.attaching = null
    if (this.canvas !== canvas) return
    this.stop()
    this.observer?.disconnect()
    this.observer = null
    this.unwatchVisibility?.()
    this.unwatchVisibility = null
    this.context?.unconfigure()
    this.context = null
    this.canvas = null
    this.hud = null
    this.hudCanvas = null
    this.onFailure = null
  }

  setHud(visible: boolean) {
    this.hudVisible = visible
    this.hud?.setVisible(visible)
  }

  setParticleCount(count: number) {
    this.particles = count
    this.scene?.setCount(count)
  }

  private start() {
    if (this.frame || !this.canvas) return
    const win = this.canvas.ownerDocument.defaultView ?? window
    // Each window has its own clock. A popout's starts near zero, so any
    // timestamp kept from the tab would be in its future.
    this.last = win.performance.now()
    this.reported = 0
    this.frame = win.requestAnimationFrame(this.tick)
  }

  private stop() {
    if (!this.frame || !this.canvas) return
    const win = this.canvas.ownerDocument.defaultView ?? window
    win.cancelAnimationFrame(this.frame)
    this.frame = 0
  }

  private resize() {
    const canvas = this.canvas
    if (!canvas) return
    const win = canvas.ownerDocument.defaultView ?? window
    const scale = win.devicePixelRatio || 1
    const width = Math.max(1, Math.round(canvas.clientWidth * scale))
    const height = Math.max(1, Math.round(canvas.clientHeight * scale))
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
      this.scene?.resize(width, height)
    }
    this.hud?.resize(canvas.clientWidth, canvas.clientHeight, scale)
  }

  private readonly tick = (now: number) => {
    this.frame = 0
    const { canvas, context, gpu, scene, features } = this
    if (!canvas || !context || !gpu || !scene || !features || gpu.lost) return
    const win = canvas.ownerDocument.defaultView ?? window
    this.frame = win.requestAnimationFrame(this.tick)
    const dt = Math.min(0.1, Math.max(0.001, (now - this.last) / 1000))
    this.last = now
    this.frameMs += (dt * 1000 - this.frameMs) * 0.1
    this.time += dt

    // Features come from the library element once it has played. Before
    // that the packet is silent and the field just drifts.
    const graph = audioGraph()
    if (!this.client && graph?.attached) this.client = new FeatureClient(graph.analyser)
    if (this.client) {
      this.client.pump(dt)
      this.packet.set(this.client.packet)
    }
    this.packet[F.time] = this.time
    this.packet[F.dt] = dt
    gpu.device.queue.writeBuffer(features, 0, this.packet)

    scene.update(this.packet, dt)
    const encoder = gpu.device.createCommandEncoder()
    scene.render(encoder, context.getCurrentTexture().createView())
    gpu.device.queue.submit([encoder.finish()])

    this.hud?.record(this.packet)
    this.hud?.draw(this.packet, {
      fps: 1000 / this.frameMs,
      frameMs: this.frameMs,
      particles: scene.particleCount,
      adapter: describe(gpu.info),
    })
    // Timing on the element, so a screenshot or a test can read it.
    if (now - this.reported > 500) {
      this.reported = now
      canvas.dataset.frameMs = this.frameMs.toFixed(1)
      canvas.dataset.particles = String(scene.particleCount)
    }
  }

  // The browser took the device away. Drop everything that depended on it
  // and try once to come back on the same canvas.
  private recover() {
    const canvas = this.canvas
    const hudCanvas = this.hudCanvas
    const onFailure = this.onFailure
    if (canvas) this.detach(canvas)
    this.scene?.dispose()
    this.scene = null
    this.features = null
    this.client?.dispose()
    this.client = null
    this.gpu = null
    if (!canvas || !hudCanvas || !onFailure) return
    void this.attach(canvas, hudCanvas, onFailure).then((result) => {
      if (result === 'unsupported') onFailure()
    })
  }
}

export const renderer = new Renderer()
