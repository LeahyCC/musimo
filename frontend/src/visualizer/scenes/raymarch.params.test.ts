import { describe, expect, it } from 'vitest'

import { F, PACKET_LENGTH } from '../audio/FeatureExtractor'
import { presetOrDefault } from '../presets'
import { resolveScene } from '../presets/resolve'
import { DEFAULT_RAYMARCH_STEPS, RAYMARCH_STEPS, SOFTWARE_RAYMARCH_SCALE } from './catalog'
import {
  MARCH_UNIFORM_FLOATS,
  marchFrame,
  marchSize,
  marchSteps,
  RAYMARCH_DEFAULTS,
  raymarchParams,
  renderScale,
  writeMarchUniform,
} from './raymarch.params'

const packet = (values: Partial<Record<keyof typeof F, number>> = {}) => {
  const out = new Float32Array(PACKET_LENGTH)
  for (const [name, value] of Object.entries(values)) out[F[name as keyof typeof F]] = value
  return out
}

const loudest = RAYMARCH_STEPS[RAYMARCH_STEPS.length - 1] ?? DEFAULT_RAYMARCH_STEPS

// The shipped raymarch preset, resolved the way the renderer resolves it, so
// these read the behaviour the stage actually has rather than a bare default.
const preset = presetOrDefault('fold')

const march = (
  values: Partial<Record<keyof typeof F, number>> = {},
  steps = DEFAULT_RAYMARCH_STEPS,
) => {
  const features = packet(values)
  const tuning = resolveScene(preset.sceneParams, preset.audioMapping, features, {})
  return marchFrame(raymarchParams(tuning), features, steps)
}
const radius = (eye: readonly [number, number, number]) => Math.hypot(eye[0], eye[1], eye[2])

describe('march step cap', () => {
  it('takes an offered cap and falls back to the default for anything else', () => {
    for (const steps of RAYMARCH_STEPS) expect(marchSteps(steps, false)).toBe(steps)
    expect(marchSteps(4096, false)).toBe(DEFAULT_RAYMARCH_STEPS)
  })

  it('halves the cap on a software rasteriser, without letting it reach nothing', () => {
    for (const steps of RAYMARCH_STEPS) {
      expect(marchSteps(steps, true)).toBeLessThanOrEqual(Math.round(steps / 2))
      expect(marchSteps(steps, true)).toBeGreaterThanOrEqual(16)
    }
  })

  it('marches at half the canvas on a rasteriser and at all of it otherwise', () => {
    expect(renderScale(false)).toBe(1)
    expect(renderScale(true)).toBe(SOFTWARE_RAYMARCH_SCALE)
    expect(marchSize(1920, 1080, false)).toEqual({ width: 1920, height: 1080 })
    expect(marchSize(1920, 1080, true)).toEqual({ width: 960, height: 540 })
  })

  it('never asks for a target with no texels in it', () => {
    const size = marchSize(0, 1, true)
    expect(size.width).toBeGreaterThanOrEqual(1)
    expect(size.height).toBeGreaterThanOrEqual(1)
  })
})

describe('raymarchParams', () => {
  it('takes the resolved value where there is one and the default otherwise', () => {
    expect(raymarchParams({ fold: 2.4 }).fold).toBe(2.4)
    expect(raymarchParams({}).orbit).toBe(RAYMARCH_DEFAULTS.orbit)
    expect(raymarchParams({ vorticity: 30 })).toEqual(RAYMARCH_DEFAULTS)
  })
})

describe('march frame', () => {
  it('opens the fold with bass', () => {
    const quiet = march({}, DEFAULT_RAYMARCH_STEPS)
    const loud = march({ bass: 1 }, DEFAULT_RAYMARCH_STEPS)
    expect(loud.fold).toBeGreaterThan(quiet.fold)
    // Sub counts as bass, since the two overlap on most material.
    expect(march({ sub: 1 }, DEFAULT_RAYMARCH_STEPS).fold).toBe(loud.fold)
  })

  it('folds more times with treble, always a whole number of them', () => {
    const quiet = march({}, DEFAULT_RAYMARCH_STEPS)
    const busy = march({ treble: 1 }, DEFAULT_RAYMARCH_STEPS)
    expect(busy.iterations).toBeGreaterThan(quiet.iterations)
    expect(Number.isInteger(busy.iterations)).toBe(true)
    expect(Number.isInteger(march({ treble: 0.37 }, 64).iterations)).toBe(true)
  })

  it('pulls the camera in on a beat but never inside the shell', () => {
    const still = march({}, DEFAULT_RAYMARCH_STEPS)
    const beat = march({ beatPulse: 1 }, DEFAULT_RAYMARCH_STEPS)
    expect(radius(beat.eye)).toBeLessThan(radius(still.eye))
    const shove = march({ beatPulse: 1, energy: 1 }, DEFAULT_RAYMARCH_STEPS)
    expect(radius(shove.eye)).toBeGreaterThan(3)
  })

  it('lights harder with energy', () => {
    const quiet = march({}, DEFAULT_RAYMARCH_STEPS)
    const loud = march({ energy: 1 }, DEFAULT_RAYMARCH_STEPS)
    expect(loud.lightStrength).toBeGreaterThan(quiet.lightStrength)
    expect(loud.glow).toBeGreaterThan(quiet.glow)
  })

  it('hands the shader a unit direction for the light', () => {
    for (const time of [0, 3.7, 11.2]) {
      const { light } = march({ time }, DEFAULT_RAYMARCH_STEPS)
      expect(Math.hypot(light[0], light[1], light[2])).toBeCloseTo(1, 6)
    }
  })

  it('keeps the camera basis orthonormal wherever the orbit is', () => {
    for (const time of [0, 2.4, 9.1, 25]) {
      const { basis } = march({ time }, DEFAULT_RAYMARCH_STEPS)
      const dot = (a: readonly number[], b: readonly number[]) =>
        (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0)
      expect(dot(basis.forward, basis.forward)).toBeCloseTo(1, 6)
      expect(dot(basis.right, basis.right)).toBeCloseTo(1, 6)
      expect(dot(basis.up, basis.up)).toBeCloseTo(1, 6)
      expect(dot(basis.forward, basis.right)).toBeCloseTo(0, 6)
      expect(dot(basis.forward, basis.up)).toBeCloseTo(0, 6)
    }
  })

  it('keeps the colour coordinate inside the ramp', () => {
    for (const time of [0, 40, 400, 4000]) {
      const { shift } = march({ time, bass: 1 }, DEFAULT_RAYMARCH_STEPS)
      expect(shift).toBeGreaterThanOrEqual(0)
      expect(shift).toBeLessThan(1.2)
    }
  })

  it('carries the cap it was given, whatever the music does', () => {
    const loud = march({ bass: 1, treble: 1, energy: 1, beatPulse: 1 }, loudest)
    expect(loud.steps).toBe(loudest)
    expect(loud.far).toBeLessThanOrEqual(32)
  })
})

describe('march uniform', () => {
  it('writes every lane with a finite number', () => {
    const out = new Float32Array(MARCH_UNIFORM_FLOATS)
    writeMarchUniform(march({ energy: 1, treble: 1 }, 112), 3840, 2160, out)
    for (const value of out) expect(Number.isFinite(value)).toBe(true)
    expect(out[16]).toBe(3840)
    expect(out[17]).toBe(2160)
    expect(out[18]).toBeCloseTo(3840 / 2160, 6)
  })

  it('never writes a surface threshold or a size the shader would divide by', () => {
    const out = new Float32Array(MARCH_UNIFORM_FLOATS)
    const frame = { ...march({}, DEFAULT_RAYMARCH_STEPS), epsilon: 0 }
    writeMarchUniform(frame, 0, 0, out)
    expect(out[11]).toBeGreaterThan(0)
    expect(out[16]).toBeGreaterThan(0)
    expect(out[17]).toBeGreaterThan(0)
    expect(Number.isFinite(out[18] ?? NaN)).toBe(true)
  })

  it('leaves the array it was handed back, so the scene can keep one', () => {
    const out = new Float32Array(MARCH_UNIFORM_FLOATS)
    expect(writeMarchUniform(march({}, 64), 800, 600, out)).toBe(out)
  })
})
