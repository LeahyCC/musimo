import { AudioLevelAnalyser } from './audio-levels.ts'
import { JourneyController } from './journey.ts'
import type { JourneyScore } from './journey.ts'
import { createAudioFrame, samplePcm } from './pcm.ts'
import type { AudioFrame, Pcm } from './pcm.ts'
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
export { nativeStudies } from './studies/index.ts'
export type { StudyManifest, StudyPass, StudySetting, StudyFrameContext } from './study-manifest.ts'
export { StudyRenderer } from './study-renderer.ts'
export { THEMES, STUDIO_STORAGE_KEY, parseStudioOptions } from './studio-options.ts'
export type { StudioOptions, Theme } from './studio-options.ts'

// Every study runs on the native WebGL2 renderer, compiled from its manifest
// onto the owner's canvas through StudyRenderer.
export const studies = {
  dive: {
    name: 'Dive journey',
    author: 'Based on Flexi, martin + geiss’s Sherwin Maxawow',
  },
  tunnel: {
    name: 'Native tunnel',
    author: 'Musimo study · feedback tunnel',
  },
  kaleidoscope3: {
    name: 'Kaleidoscope V3',
    author: 'Musimo study · kaleidoscopic IFS, evaluated per pixel',
  },
  julia: {
    name: 'Julia spiral',
    author: 'Musimo study · escape-time Julia, self-similar dive',
  },
  contours: {
    name: 'Liquid contours',
    author: 'Musimo study · curl-noise field, drawn as contour lines',
  },
} as const satisfies Record<string, { name: string; author: string }>
export type Study = keyof typeof studies
export const simulationFps = 60
export const reconstructionFrames = 120

// The owner supplies prepared PCM and media time. This class has no audio element or audio graph.
export class VisualizerEngine {
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
    // A native study builds synchronously. Yield once first so an owner that
    // disposes or reloads in the same turn wins, rather than this spending
    // the canvas's single WebGL context on a load nobody is waiting for.
    await Promise.resolve()
    signal.throwIfAborted()
    this.loadNative(study, start)
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

  get position() {
    return this.frame / simulationFps
  }
  get journeyState() {
    return this.controller?.sample(this.position)
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
    if (!this.studyRenderer || !this.study || this.disposed)
      throw new Error('Load the visualizer before starting it.')
    // The native path clears its own buffers, analyser and study state to get
    // a clean feedback buffer, because a canvas cannot hand out a second WebGL context.
    this.resetStudyState()
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
    this.renderNativeFrame(input)
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
    this.studyRenderer.render({
      time: this.position,
      frame: this.frame,
      audio,
      onset: this.levels.onset * this.options.sensitivity,
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
