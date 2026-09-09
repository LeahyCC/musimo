import sherwin from 'butterchurn-presets/presets/converted/Flexi, martin + geiss - dedicated to the sherwin maxawow.json'
import witchcraft from 'butterchurn-presets/presets/converted/martin - witchcraft reloaded.json'

import { AudioLevelAnalyser } from './audio-levels.ts'
import {
  createKaleidoscopePreset,
  createPhosphorPreset,
  createPrismPreset,
} from './effects-presets.ts'
import { createJourneyPreset } from './journey-preset.ts'
import { JourneyController } from './journey.ts'
import type { JourneyScore } from './journey.ts'
import { createKaleidoscopeV2Preset } from './kaleidoscope-v2-preset.ts'
import { createKaleidoscopeV3Preset } from './kaleidoscope-v3-preset.ts'
import { createAudioFrame, samplePcm } from './pcm.ts'
import type { AudioFrame, Pcm } from './pcm.ts'
import { createRendererSandbox } from './renderer-sandbox.ts'
import type { Renderer, RendererSandbox } from './renderer-sandbox.ts'
import { nativeStudies } from './studies/index.ts'
import { mergeStudioOptions, resolveSeed } from './studio-options.ts'
import type { ResolvedStudioOptions, StudioOptions } from './studio-options.ts'
import type { StudyManifest, StudyState } from './study-manifest.ts'
import { StudyRenderer } from './study-renderer.ts'

export { samplePcm, createAudioFrame } from './pcm.ts'
export type { Pcm, AudioFrame } from './pcm.ts'
export { AudioLevelAnalyser } from './audio-levels.ts'
export type { BandLevels } from './audio-levels.ts'
export { JourneyController } from './journey.ts'
export type { JourneyScore, JourneyCue, JourneyState, Motif } from './journey.ts'
export type { Renderer } from './renderer-sandbox.ts'
export { nativeStudies } from './studies/index.ts'
export type { StudyManifest, StudyPass, StudySetting, StudyFrameContext } from './study-manifest.ts'
export { StudyRenderer } from './study-renderer.ts'
export { THEMES, STUDIO_STORAGE_KEY } from './studio-options.ts'
export type { StudioOptions, Theme } from './studio-options.ts'

// `renderer` picks the path: Butterchurn presets keep the iframe realm, native
// studies compile their manifest onto the owner's canvas through StudyRenderer.
export const studies = {
  dive: {
    name: 'Dive journey',
    author: 'Based on Flexi, martin + geiss’s Sherwin Maxawow',
    renderer: 'butterchurn',
  },
  phosphor: {
    name: 'Phosphor Memory',
    author: 'Musimo study · relief lighting after Sherwin',
    renderer: 'butterchurn',
  },
  kaleidoscope: {
    name: 'Kaleidoscope Tides',
    author: 'Musimo study · relief lighting after Sherwin',
    renderer: 'butterchurn',
  },
  kaleidoscope2: {
    name: 'Kaleidoscope V2',
    author: 'Musimo study · after Flexi’s log-polar kaleidoscope and fractal feedback',
    renderer: 'butterchurn',
  },
  kaleidoscope3: {
    name: 'Kaleidoscope V3',
    author: 'Musimo study · kaleidoscopic IFS, evaluated per pixel',
    renderer: 'butterchurn',
  },
  prism: {
    name: 'Prism Fracture',
    author: 'Musimo study · relief lighting after Sherwin',
    renderer: 'butterchurn',
  },
  tunnel: {
    name: 'Native tunnel',
    author: 'Musimo study · feedback tunnel',
    renderer: 'native',
  },
  witchcraft: { name: 'martin - witchcraft reloaded', author: 'martin', renderer: 'butterchurn' },
  sherwin: {
    name: 'Flexi, martin + geiss - dedicated to the sherwin maxawow',
    author: 'Flexi, martin + geiss',
    renderer: 'butterchurn',
  },
} as const satisfies Record<string, { name: string; author: string; renderer: RendererKind }>
export type RendererKind = 'butterchurn' | 'native'
export type Study = keyof typeof studies
export const simulationFps = 60
export const reconstructionFrames = 120

// The owner supplies prepared PCM and media time. This class has no audio element or audio graph.
export class VisualizerEngine {
  private renderer: Renderer | undefined
  private sandbox: RendererSandbox | undefined
  private studyRenderer: StudyRenderer | undefined
  private manifest: StudyManifest | undefined
  private studyState: StudyState = {}
  private levels = new AudioLevelAnalyser()
  // A native renderer loses its WebGL context when released, and a canvas only
  // ever yields one. Loading a second native study needs a fresh engine.
  private canvasSpent = false
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
  private options: ResolvedStudioOptions
  readonly costs: number[] = []
  loadMs = 0
  warmMs = 0
  reconstructionMs = 0
  reconstructedFrames = 0

  constructor(
    canvas: HTMLCanvasElement,
    pcm: Pcm,
    width = 1920,
    score?: JourneyScore,
    options: StudioOptions = {},
  ) {
    if (pcm.sampleRate !== 44100 || !pcm.left.length || pcm.left.length !== pcm.right.length) {
      throw new Error('Visualizer PCM must be matching stereo channels decoded at 44.1 kHz.')
    }
    if (!Number.isFinite(width) || width < 320 || width > 3840) {
      throw new Error('Choose a visualizer width between 320 and 3840 pixels.')
    }
    this.pcm = pcm
    this.canvas = canvas
    this.options = mergeStudioOptions(options)
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
    if (studies[study].renderer === 'native') {
      this.loadNative(study, start)
      signal.throwIfAborted()
      return
    }
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
        seed: resolveSeed(this.options, this.controller?.score.seed),
      })
      // The effect studies bake the seed into their drift phases, so they get
      // the same resolved seed the renderer was created with.
      const baked = {
        ...this.options,
        seed: resolveSeed(this.options, this.controller?.score.seed),
      }
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
        study === 'dive'
          ? createJourneyPreset(this.options)
          : study === 'phosphor'
            ? createPhosphorPreset(baked)
            : study === 'kaleidoscope'
              ? createKaleidoscopePreset(baked)
              : study === 'kaleidoscope2'
                ? createKaleidoscopeV2Preset(baked)
                : study === 'kaleidoscope3'
                  ? createKaleidoscopeV3Preset(baked)
                  : study === 'prism'
                    ? createPrismPreset(baked)
                    : study === 'witchcraft'
                      ? witchcraft
                      : sherwin,
        0,
      )
      signal.throwIfAborted()
      if (study === 'dive' && this.controller) {
        const controller = this.controller
        // Sensitivity scales the onset signal where the score is injected into
        // the preset's q variables; every other state passes through untouched.
        const sensitivity = this.options.sensitivity
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
            q25: state.onset * sensitivity,
            q26: state.energy,
            q27: state.texture,
            q28: state.variation,
            q29: state.progress,
            q30: state.transitionActivity,
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

  // Native studies build their programs synchronously; there is no realm to
  // fetch and no preset text to compile into JavaScript.
  private loadNative(study: Study, start: number) {
    const manifest = nativeStudies[study]
    if (!manifest) throw new Error('Unknown visual study.')
    if (this.canvasSpent)
      throw new Error('This canvas has already hosted a native study. Create a new visualizer.')
    this.canvasSpent = true
    this.studyRenderer = new StudyRenderer(
      this.canvas,
      manifest,
      resolveSeed(this.options, this.controller?.score.seed),
      this.options,
    )
    this.manifest = manifest
    this.resetStudyState()
    this.loadMs = performance.now() - start
    const warming = performance.now()
    this.studyRenderer.finish()
    this.warmMs = performance.now() - warming
  }

  private resetStudyState() {
    this.studyState = {}
    this.levels = new AudioLevelAnalyser()
    this.studyRenderer?.reset()
  }

  private get isNative() {
    return Boolean(this.study && studies[this.study].renderer === 'native')
  }

  get position() {
    return this.frame / simulationFps
  }
  get journeyState() {
    if (!this.controller) return undefined
    return this.study === 'dive' || this.isNative
      ? this.controller.sample(this.position)
      : undefined
  }

  // Live studio options on the native path. These are uniforms, so nothing
  // rebuilds. The seed is a load-time input (it generates the noise textures),
  // so changing it still needs a fresh engine.
  setOptions(patch: StudioOptions) {
    this.options = mergeStudioOptions({ ...this.options, ...patch, seed: this.options.seed })
    this.studyRenderer?.setOptions(this.options)
  }

  setSetting(name: string, value: number) {
    if (!this.studyRenderer) throw new Error('Load a native study before changing its settings.')
    this.studyRenderer.setSetting(name, value)
  }

  get studySettings(): Readonly<Record<string, number>> | undefined {
    return this.studyRenderer?.settings
  }

  get studyManifest(): StudyManifest | undefined {
    return this.manifest
  }

  // False when EXT_color_buffer_float was unavailable and the native buffers
  // fell back to 8 bits.
  get floatBuffers(): boolean | undefined {
    return this.studyRenderer?.floatBuffers
  }

  // Reconstruct at most two seconds of feedback and audio smoothing from a fresh
  // seed. The score is exact at the destination; historical pixels are not restored.
  // Yield between small batches so rebuilding cannot monopolize the media owner's UI.
  async startAt(seconds: number, currentMediaTime?: () => number) {
    if (!Number.isFinite(seconds)) throw new Error('The media position must be finite.')
    if ((!this.renderer && !this.studyRenderer) || !this.study || this.disposed)
      throw new Error('Load the visualizer before starting it.')
    // Butterchurn rebuilds its realm to get a clean feedback buffer. The native
    // path clears its own buffers, analyser and study state instead, because a
    // canvas cannot hand out a second WebGL context.
    if (this.isNative) this.resetStudyState()
    else if (this.started) await this.load(this.study)
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
    const start = performance.now()
    const input = samplePcm(
      this.pcm,
      this.position,
      this.input,
      this.controller?.score.recording.timingOffsetSeconds ?? 0,
    )
    if (this.studyRenderer) this.renderNativeFrame(input)
    else if (this.renderer)
      this.renderer.render({ elapsedTime: 1 / simulationFps, audioLevels: input })
    else throw new Error('The visualizer renderer is unavailable.')
    if (measure) {
      this.costs.push(performance.now() - start)
      if (this.costs.length > 3600) this.costs.shift()
    }
  }

  // Band levels, then the study's own frame hook, then the passes. The hook
  // sees the journey whenever the engine has a score, so a study can map score
  // state to its own uniforms without the engine knowing anything about it.
  private renderNativeFrame(input: AudioFrame) {
    if (!this.studyRenderer) throw new Error('The visualizer renderer is unavailable.')
    const audio = this.levels.update(input)
    const frameUniforms = this.manifest?.frame
      ? this.manifest.frame({
          state: this.studyState,
          time: this.position,
          frame: this.frame,
          audio,
          settings: this.studyRenderer.settings,
          options: this.options,
          journey: this.controller?.sample(this.position),
        })
      : {}
    // Onset lands with the next card; the uniform exists so studies can be
    // written against it now.
    this.studyRenderer.render({
      time: this.position,
      frame: this.frame,
      audio,
      onset: 0,
      frameUniforms,
    })
  }

  // The canvas pixels, for the determinism checks. The native path draws to the
  // default framebuffer, so there is no 2D context to read through.
  readPixels(): Uint8Array {
    if (!this.studyRenderer) throw new Error('Only a native study can read its pixels back.')
    return this.studyRenderer.readPixels()
  }

  private releaseRenderer() {
    this.renderer?.loseGLContext()
    this.renderer = undefined
    this.sandbox?.remove()
    this.sandbox = undefined
    this.studyRenderer?.dispose()
    this.studyRenderer = undefined
    this.manifest = undefined
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.pending.abort()
    this.releaseRenderer()
    this.costs.length = 0
  }
}
