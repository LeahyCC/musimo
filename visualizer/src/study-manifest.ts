// A native study is data, not code: a manifest of fragment passes plus an
// optional pure per-frame hook. `study-renderer.ts` compiles it against WebGL2.
// This module holds only types and their defaults so node tests and the studio
// page can import it without touching a GL context.
import type { BandLevels } from './audio-levels.ts'
import type { JourneyState } from './journey.ts'
import type { ResolvedStudioOptions } from './studio-options.ts'

// A live numeric uniform. The studio panel renders these as sliders and the
// renderer updates them without rebuilding a program.
export type StudySetting = {
  name: string
  label: string
  min: number
  max: number
  step: number
  default: number
}

export type StudyPassFormat = 'rgba16f' | 'rgba8'

export type StudyPass = {
  name: string
  // A GLSL ES 3.00 fragment body that assigns `ret`, a vec3. This is
  // Butterchurn's shader_body convention, so preset GLSL ports without edits.
  glsl: string
  output: 'buffer' | 'screen'
  // A persistent pass ping-pongs: it reads its own previous frame as
  // `sampler_<name>` and writes the other half of the pair.
  persistent?: boolean
  // Resolution as a fraction of the canvas. Defaults to 1.
  scale?: number
  // Defaults to rgba16f, falling back to rgba8 without EXT_color_buffer_float.
  format?: StudyPassFormat
}

// Three separable Gaussian levels taken from `source` at 1/2, 1/4 and 1/8 of
// its resolution, exposed as sampler_blur1, sampler_blur2 and sampler_blur3.
export type StudyBlur = { source: string; levels: 3 }

// Accumulators the study owns between frames. Reset to {} on load and at the
// start of every startAt reconstruction, which is what keeps a seek reproducible.
export type StudyState = Record<string, number>

export type StudyFrameContext = {
  state: StudyState
  time: number
  frame: number
  audio: BandLevels
  settings: Readonly<Record<string, number>>
  options: ResolvedStudioOptions
  journey?: JourneyState
}

// Pure: same inputs and same state must give the same output. It must never
// read Math.random, Date or performance, or seeks stop reproducing.
export type StudyFrameHook = (context: StudyFrameContext) => Record<string, number>

export type StudyManifest = {
  id: string
  name: string
  author: string
  passes: StudyPass[]
  frame?: StudyFrameHook
  settings?: StudySetting[]
  blur?: StudyBlur
}

export const DEFAULT_PASS_SCALE = 1
export const DEFAULT_PASS_FORMAT: StudyPassFormat = 'rgba16f'

export function settingDefaults(manifest: StudyManifest): Record<string, number> {
  const values: Record<string, number> = {}
  for (const setting of manifest.settings ?? []) values[setting.name] = setting.default
  return values
}

// Names the renderer reserves. A pass, setting or frame-hook key using one of
// these would collide with a built-in uniform, so the loader rejects it early
// rather than failing later inside a shader compile.
export const RESERVED_UNIFORM_NAMES = new Set([
  'time',
  'frame',
  'resolution',
  'aspect',
  'texsize',
  'bass',
  'mid',
  'treb',
  'vol',
  'bass_att',
  'mid_att',
  'treb_att',
  'vol_att',
  'onset',
  'seed',
  'motion',
  'trails',
  'sensitivity',
  'desat',
  'tintA',
  'tintB',
  'tintC',
  'uv',
  'uv_orig',
  'ret',
  'fragColor',
  'position',
])
