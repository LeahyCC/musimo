// Studio customization options for the preview's Customize panel. Options are
// merged with defaults, baked into preset strings at build time (one shader
// program per study per build) and persisted by the preview owner. Defaults
// reproduce the authored visuals exactly: theme Abyss, motion 1×, trails
// centred (as authored), sensitivity 1×, seed from the journey score.
// This module stays free of DOM, bundler and JSON imports so node tests can
// exercise the merging and seed rules directly.

export const THEMES = ['abyss', 'ember', 'ultraviolet', 'mono'] as const
export type Theme = (typeof THEMES)[number]

export type StudioOptions = {
  theme?: Theme
  motion?: number
  trails?: number
  sensitivity?: number
  seed?: number
}

export type ResolvedStudioOptions = {
  theme: Theme
  motion: number
  trails: number
  sensitivity: number
  seed: number | undefined
}

export const STUDIO_STORAGE_KEY = 'musimo.studio.visual'

export const MOTION_RANGE = { min: 0.3, max: 3 } as const
export const SENSITIVITY_RANGE = { min: 0.25, max: 2.5 } as const
export const SEED_MAX = 0x7fffffff

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value)

// Merge partial or untrusted input (panel state, localStorage JSON) into a
// complete, bounded options object. Unknown or out-of-range values fall back
// to defaults so a stale stored object can never break a build.
export function mergeStudioOptions(options: StudioOptions = {}): ResolvedStudioOptions {
  const theme = THEMES.includes(options.theme as Theme) ? (options.theme as Theme) : 'abyss'
  const motion = finite(options.motion)
    ? clamp(options.motion as number, MOTION_RANGE.min, MOTION_RANGE.max)
    : 1
  const trails = finite(options.trails) ? clamp(options.trails as number, 0, 1) : 0.5
  const sensitivity = finite(options.sensitivity)
    ? clamp(options.sensitivity as number, SENSITIVITY_RANGE.min, SENSITIVITY_RANGE.max)
    : 1
  const seed =
    finite(options.seed) &&
    Number.isInteger(options.seed) &&
    (options.seed as number) >= 0 &&
    (options.seed as number) <= SEED_MAX
      ? (options.seed as number)
      : undefined
  return { theme, motion, trails, sensitivity, seed }
}

// Parse the persisted JSON. Corrupt or absent storage yields defaults.
export function parseStudioOptions(json: string | null): StudioOptions {
  if (!json) return {}
  try {
    const value: unknown = JSON.parse(json)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return value as StudioOptions
  } catch {
    return {}
  }
}

export function serializeStudioOptions(options: ResolvedStudioOptions): string {
  const stored: StudioOptions = {
    theme: options.theme,
    motion: options.motion,
    trails: options.trails,
    sensitivity: options.sensitivity,
  }
  if (options.seed !== undefined) stored.seed = options.seed
  return JSON.stringify(stored)
}

// Seed precedence: explicit re-roll override, then the journey score, then the
// fixed fallback used by score-less studies.
export function resolveSeed(options: { seed?: number }, scoreSeed?: number): number {
  return options.seed ?? scoreSeed ?? 271828
}

// Trails is a 0–1 slider centred on the authored decay. Map it to a multiplier
// on the decay gap (1 − persistence): left shortens trails, right lengthens
// them, centre is exactly the authored value. Asymmetric anchors keep every
// baked decay strictly below 1.
export function trailGapScale(trails: number): number {
  const t = clamp(trails, 0, 1)
  return t <= 0.5 ? 2.5 + (1 - 2.5) * (t * 2) : 1 + (0.25 - 1) * (t * 2 - 1)
}

// Format a number as a GLSL float literal in the same style as the authored
// preset strings: `.997`, `1.`, `.075`. Round to 12 significant digits first so
// binary noise (0.9299999999999999) cannot leak into shader sources.
export function glsl(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Cannot bake a non-finite number into a shader.')
  let text = String(Number(value.toPrecision(12)))
  if (/[eE]/.test(text)) text = String(Number(value.toFixed(12)))
  if (!text.includes('.')) text += '.'
  return text.replace(/^(-?)0\.(?=\d)/, '$1.')
}

export type Rgb = [number, number, number]

export function vec3([r, g, b]: Rgb): string {
  return `vec3(${glsl(r)},${glsl(g)},${glsl(b)})`
}

// Dive journey motif tints, in q21/q22/q23 (orbit/current/bloom) order.
// Abyss is the authored palette and must stay byte-identical to the original
// shader expression.
export const themeTints: Record<Theme, [Rgb, Rgb, Rgb]> = {
  abyss: [
    [0.63, 0.94, 1],
    [0.65, 0.76, 1],
    [1, 0.82, 0.59],
  ],
  ember: [
    [1, 0.55, 0.22],
    [0.95, 0.38, 0.25],
    [1, 0.8, 0.4],
  ],
  ultraviolet: [
    [0.68, 0.45, 1],
    [0.85, 0.35, 0.95],
    [1, 0.5, 0.85],
  ],
  mono: [
    [0.8, 0.8, 0.8],
    [0.62, 0.62, 0.62],
    [1, 1, 1],
  ],
}

// The Sherwin liquid's feedback carries its own hue, which tint multiplication
// alone cannot remove. Each theme therefore also anchors the display-path
// material towards its luminance before tinting: Abyss anchors 0 (exactly the
// authored look, mix(x, lum, 0.) === x), Mono anchors fully (true grayscale
// silver). Display path only — the HDR feedback is never touched.
export const themeDesat: Record<Theme, number> = {
  abyss: 0,
  ember: 0.55,
  ultraviolet: 0.45,
  mono: 1,
}

// GLSL snippet mixing `color` towards its own luminance by the theme's anchor.
export function desaturate(theme: Theme, color: string): string {
  const amount = glsl(themeDesat[theme])
  return `${color}=mix(${color},vec3(dot(${color},vec3(.299,.587,.114))),${amount});`
}
