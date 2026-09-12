/**
 * What the stage can choose: which scene draws, and how much work that scene
 * does. Plain values with no GPU, WGSL or React imports, so the top bar can
 * read them without pulling the visualizer tree into the main bundle.
 */

export const SCENE_IDS = ['particles', 'fluid', 'raymarch'] as const
export type SceneId = (typeof SCENE_IDS)[number]

export const SCENE_LABELS: Record<SceneId, string> = {
  particles: 'Particles',
  fluid: 'Fluid',
  raymarch: 'Raymarch',
}

export const DEFAULT_SCENE: SceneId = 'particles'

export const isSceneId = (value: string): value is SceneId =>
  (SCENE_IDS as readonly string[]).includes(value)

/**
 * Particle counts the stage offers. The default holds the display's cap on
 * Apple Silicon with room to spare; see docs/visualizer.md for measurements.
 */
export const PARTICLE_COUNTS: readonly number[] = [100_000, 250_000, 500_000, 1_000_000]
export const DEFAULT_PARTICLES = 250_000

/** Fluid grid sizes, in texels each side. The grid is square either way. */
export const FLUID_SIZES: readonly number[] = [512, 1024]
export const DEFAULT_FLUID_SIZE = 512
/** A CPU rasteriser gets the small grid whatever was chosen. */
export const SOFTWARE_FLUID_SIZE = 512

/**
 * Step caps the raymarch offers. The march is fill-bound, so this is the one
 * number that decides what a 4K frame costs; see docs/visualizer.md.
 */
export const RAYMARCH_STEPS: readonly number[] = [64, 112]
export const DEFAULT_RAYMARCH_STEPS = 64
/** A CPU rasteriser halves the cap and marches at half the canvas. */
export const SOFTWARE_RAYMARCH_SCALE = 0.5
