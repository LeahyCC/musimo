/**
 * The vocabulary a preset is written in: which feature a mapping can read,
 * how it may bend it, and the named numbers each scene exposes. Like
 * `scenes/catalog.ts` this imports nothing, so the stage's top bar and the
 * preset parser can read it without pulling the WebGPU tree into the main
 * bundle, and the scenes' parameter files can import it without a cycle.
 *
 * A knob is a plain identifier. A post target is dotted, `bloom.intensity`,
 * which is how the parser tells the two apart.
 */

/**
 * What a mapping may read. Ten come straight from the packet; `lowEnd` is the
 * louder of sub and bass, which is what every scene wanted from the low end
 * before presets existed.
 */
export const AUDIO_FIELDS = [
  'sub',
  'bass',
  'lowEnd',
  'lowMid',
  'highMid',
  'treble',
  'energy',
  'flux',
  'onsetStrength',
  'beatPulse',
] as const
export type AudioField = (typeof AUDIO_FIELDS)[number]

/**
 * How a feature is bent before the gain multiplies it. All four keep 0 at 0
 * and 1 at 1 except `invert`, which turns a feature into its absence.
 */
export const CURVES = ['linear', 'square', 'sqrt', 'invert'] as const
export type Curve = (typeof CURVES)[number]

/**
 * The fluid's numbers. `force` and `dye` are what the emitters trickle every
 * second; `hitForce` and `hitDye` are what one onset adds on top.
 */
export const FLUID_KNOBS = [
  'velocityDecay',
  'dyeDecay',
  'vorticity',
  'viscosity',
  'intensity',
  'spread',
  'force',
  'dye',
  'hitForce',
  'hitDye',
  'radius',
  'colourShift',
  'colourDrift',
  'orbitSpeed',
] as const
export type FluidKnob = (typeof FLUID_KNOBS)[number]

export type SceneKnob = FluidKnob

/** Every knob a scene offers, by scene id. The parser checks against this. */
export const SCENE_KNOBS = {
  fluid: FLUID_KNOBS,
} as const satisfies Record<string, readonly SceneKnob[]>

/**
 * The resolved numbers a scene reads each frame. The renderer fills one of
 * these from the preset and its mapping before calling `update`, and each
 * scene's parameter file turns it into that scene's own typed object, falling
 * back to its defaults for anything the preset left out.
 */
export type Tuning = Readonly<Partial<Record<SceneKnob, number>>>

/**
 * A scene's resting numbers, seen from outside. The renderer holds a preset
 * whose scene it does not know at compile time, so what it hands the resolver
 * is this rather than one scene's own record; the parser has already made
 * sure the keys are that scene's.
 */
export type SceneValues = Readonly<Record<string, number>>
