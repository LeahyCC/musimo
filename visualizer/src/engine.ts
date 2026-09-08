import sherwin from 'butterchurn-presets/presets/converted/Flexi, martin + geiss - dedicated to the sherwin maxawow.json'
import witchcraft from 'butterchurn-presets/presets/converted/martin - witchcraft reloaded.json'

import { createJourneyPreset } from './journey-preset.ts'
import { JourneyController } from './journey.ts'
import type { JourneyScore } from './journey.ts'
import { createAudioFrame, samplePcm } from './pcm.ts'
import type { Pcm } from './pcm.ts'
import { createRendererSandbox } from './renderer-sandbox.ts'
import type { Renderer, RendererSandbox } from './renderer-sandbox.ts'

export { samplePcm, createAudioFrame } from './pcm.ts'
export type { Pcm, AudioFrame } from './pcm.ts'
export { JourneyController } from './journey.ts'
export type { JourneyScore, JourneyCue, JourneyState, Motif } from './journey.ts'
export type { Renderer } from './renderer-sandbox.ts'

export const studies = {
  dive: { name: 'Dive journey', author: 'Based on Flexi, martin + geiss’s Sherwin Maxawow' },
  witchcraft: { name: 'martin - witchcraft reloaded', author: 'martin' },
  sherwin: {
    name: 'Flexi, martin + geiss - dedicated to the sherwin maxawow',
    author: 'Flexi, martin + geiss',
  },
} as const
export type Study = keyof typeof studies
export const simulationFps = 60
export const reconstructionFrames = 120

// The owner supplies prepared PCM and media time. This class has no audio element or audio graph.
export class VisualizerEngine {
  private renderer: Renderer | undefined
  private sandbox: RendererSandbox | undefined
  private pending = new AbortController()
  private canvas: HTMLCanvasElement
  private pcm: Pcm
  private controller: JourneyController | undefined
  private input = createAudioFrame()
  private frame = 0
  private disposed = false
  private started = false
  private preparing = false
  private study: Study | undefined
  readonly costs: number[] = []
  loadMs = 0
  warmMs = 0
  reconstructionMs = 0
  reconstructedFrames = 0

  constructor(canvas: HTMLCanvasElement, pcm: Pcm, width = 1920, score?: JourneyScore) {
    if (pcm.sampleRate !== 44100 || !pcm.left.length || pcm.left.length !== pcm.right.length) {
      throw new Error('Visualizer PCM must be matching stereo channels decoded at 44.1 kHz.')
    }
    if (!Number.isFinite(width) || width < 320 || width > 3840) {
      throw new Error('Choose a visualizer width between 320 and 3840 pixels.')
    }
    this.pcm = pcm
    this.canvas = canvas
    canvas.width = Math.round(width)
    canvas.height = Math.round((width * 9) / 16)
    if (score) {
      this.controller = new JourneyController(score)
      if (Math.abs(pcm.left.length / pcm.sampleRate - score.recording.duration) > 0.25) {
        throw new Error('The journey does not match this recording’s duration.')
      }
    }
  }

  async load(study: Study) {
    if (this.disposed) throw new Error('This visualizer has been disposed.')
    if (!(study in studies)) throw new Error('Unknown visual study.')
    if (study === 'dive' && !this.controller)
      throw new Error('Dive needs its matching journey score.')
    this.pending.abort()
    this.pending = new AbortController()
    const signal = this.pending.signal
    this.releaseRenderer()
    this.started = false
    this.study = study
    const start = performance.now()
    const sandbox = await createRendererSandbox(signal)
    if (signal.aborted || this.disposed) {
      sandbox.remove()
      signal.throwIfAborted()
      return
    }
    this.sandbox = sandbox
    try {
      this.renderer = sandbox.factory.createVisualizer(null, this.canvas, {
        width: this.canvas.width,
        height: this.canvas.height,
        pixelRatio: 1,
        textureRatio: 1,
        deterministic: true,
        seed: this.controller?.score.seed ?? 271828,
      })
      const clock = this.renderer.renderer
      // Upstream elapsedTime still passes through an FPS smoother. Set the clock
      // directly from the integer media frame, never by repeated floating additions.
      clock.calcTimeAndFPS = () => {
        clock.fps = simulationFps
        clock.time = this.position
        clock.frameNum = this.frame - 1
        clock.blendProgress =
          clock.blendDuration > 0
            ? Math.min(1, (clock.time - clock.blendStartTime) / clock.blendDuration)
            : 1
        clock.blending = clock.blendProgress < 1
      }
      await this.renderer.loadPreset(
        study === 'dive' ? createJourneyPreset() : study === 'witchcraft' ? witchcraft : sherwin,
        0,
      )
      signal.throwIfAborted()
      if (study === 'dive' && this.controller) {
        const controller = this.controller
        const runner = clock.presetEquationRunner
        const evaluate = runner.runFrameEquations.bind(runner)
        runner.runFrameEquations = (variables) => {
          const state = controller.sample(this.position)
          return evaluate({
            ...variables,
            q21: state.orbit,
            q22: state.current,
            q23: state.bloom,
            q24: state.intensity,
            q25: state.onset,
            q26: state.energy,
            q27: state.texture,
            q28: state.variation,
            q29: state.progress,
          })
        }
      }
      this.loadMs = performance.now() - start
      const warming = performance.now()
      // All three forms share these programs. Complete preparation before audio
      // entry; no shader compilation or second renderer is needed at cue changes.
      this.renderer.gl.finish()
      this.warmMs = performance.now() - warming
      const error = this.renderer.gl.getError()
      if (error !== this.renderer.gl.NO_ERROR)
        throw new Error(`Visualizer preparation failed (${error}).`)
    } catch (error) {
      if (this.sandbox === sandbox) this.releaseRenderer()
      throw error
    }
  }

  get position() {
    return this.frame / simulationFps
  }
  get journeyState() {
    return this.study === 'dive' ? this.controller?.sample(this.position) : undefined
  }

  // Reconstruct at most two seconds of feedback and audio smoothing from a fresh
  // seed. The score is exact at the destination; historical pixels are not restored.
  // Yield between small batches so rebuilding cannot monopolize the media owner's UI.
  async startAt(seconds: number, currentMediaTime?: () => number) {
    if (!Number.isFinite(seconds)) throw new Error('The media position must be finite.')
    if (!this.renderer || !this.study || this.disposed)
      throw new Error('Load the visualizer before starting it.')
    if (this.started) await this.load(this.study)
    const signal = this.pending.signal
    this.preparing = true
    this.started = true
    const start = performance.now()
    const target = this.mediaFrame(seconds)
    const first = Math.max(0, target - reconstructionFrames + 1)
    this.reconstructedFrames = 0
    try {
      for (this.frame = first; this.frame <= target; this.frame++) {
        signal.throwIfAborted()
        this.renderFrame(false)
        this.reconstructedFrames++
        if (this.reconstructedFrames % 8 === 0 && this.frame < target) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
        }
      }
      this.frame = target
      // A playing owner can have advanced while reconstruction yielded. Land on
      // its latest media time once, retaining the deliberately approximate history.
      if (currentMediaTime) {
        const current = currentMediaTime()
        if (!Number.isFinite(current)) throw new Error('The media position must be finite.')
        const landing = this.mediaFrame(current)
        if (landing !== target) {
          this.frame = landing
          this.renderFrame(false)
        }
      }
      this.reconstructionMs = performance.now() - start
    } finally {
      this.preparing = false
    }
  }

  advance(seconds: number) {
    if (!Number.isFinite(seconds)) throw new Error('The media position must be finite.')
    if (this.disposed || !this.started || this.preparing) return false
    const target = this.mediaFrame(seconds)
    // Large clock jumps and hidden-tab recovery ask the owner for a reconstruction.
    if (target < this.frame || target - this.frame > 30) return false
    while (this.frame < target) {
      this.frame++
      this.renderFrame(true)
    }
    return true
  }

  private mediaFrame(seconds: number) {
    return Math.floor(
      Math.max(0, Math.min(seconds, this.pcm.left.length / this.pcm.sampleRate)) * simulationFps,
    )
  }

  private renderFrame(measure: boolean) {
    if (!this.renderer) throw new Error('The visualizer renderer is unavailable.')
    const start = performance.now()
    this.renderer.render({
      elapsedTime: 1 / simulationFps,
      audioLevels: samplePcm(
        this.pcm,
        this.position,
        this.input,
        this.controller?.score.recording.timingOffsetSeconds ?? 0,
      ),
    })
    if (measure) {
      this.costs.push(performance.now() - start)
      if (this.costs.length > 3600) this.costs.shift()
    }
  }

  private releaseRenderer() {
    this.renderer?.loseGLContext()
    this.renderer = undefined
    this.sandbox?.remove()
    this.sandbox = undefined
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.pending.abort()
    this.releaseRenderer()
    this.costs.length = 0
  }
}
