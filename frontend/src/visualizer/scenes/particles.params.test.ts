import { describe, expect, it } from 'vitest'

import {
  coverIntensity,
  PARTICLE_DEFAULTS,
  PARTICLE_UNIFORM_FLOATS,
  particleParams,
  pointSize,
  writeParticleUniform,
} from './particles.params'

const camera = new Float32Array(16).fill(1)

const write = (overrides: Partial<typeof PARTICLE_DEFAULTS> = {}) => {
  const data = new ArrayBuffer(PARTICLE_UNIFORM_FLOATS * 4)
  const floats = new Float32Array(data)
  const uints = new Uint32Array(data)
  writeParticleUniform(
    { ...PARTICLE_DEFAULTS, ...overrides },
    camera,
    1920,
    1080,
    250_000,
    false,
    floats,
    uints,
  )

  return { floats, uints }
}

describe('particleParams', () => {
  it('takes the resolved value where there is one', () => {
    expect(particleParams({ flow: 2.5 }).flow).toBe(2.5)
  })

  it('falls back to the default for anything the preset left out', () => {
    const params = particleParams({})
    expect(params).toEqual(PARTICLE_DEFAULTS)
  })

  it('ignores a knob from another scene', () => {
    expect(particleParams({ vorticity: 30 })).toEqual(PARTICLE_DEFAULTS)
  })
})

describe('pointSize and coverIntensity', () => {
  it('grows the point with the canvas, so 4K keeps the docked look', () => {
    expect(pointSize(2160)).toBeGreaterThan(pointSize(720))
    expect(pointSize(0)).toBeGreaterThan(0)
  })

  it('dims each particle by how many are expected to land on a pixel', () => {
    const size = pointSize(1080)
    expect(coverIntensity(1_000_000, size, 1920, 1080)).toBeLessThan(
      coverIntensity(100_000, size, 1920, 1080),
    )
  })

  it('never reaches zero, and never passes one', () => {
    expect(coverIntensity(50_000_000, 8, 320, 320)).toBeGreaterThan(0)
    expect(coverIntensity(1, 1, 3840, 2160)).toBeLessThanOrEqual(1)
    // A canvas with no area would otherwise divide by zero.
    expect(Number.isFinite(coverIntensity(250_000, 4, 0, 0))).toBe(true)
  })
})

describe('writeParticleUniform', () => {
  it('writes the camera, the canvas and the count where the struct expects them', () => {
    const { floats, uints } = write()
    expect(Array.from(floats.slice(0, 16))).toEqual(Array.from(camera))
    expect(floats[16]).toBe(1920)
    expect(floats[17]).toBe(1080)
    expect(uints[18]).toBe(250_000)
    expect(uints[19]).toBe(0)
  })

  it('carries every knob into the four tuning vectors', () => {
    const { floats } = write({ flow: 3, push: 7, drag: 2, sizeBump: 1.5, warmth: -0.4 })
    expect(floats[24]).toBe(3)
    expect(floats[27]).toBe(7)
    expect(floats[30]).toBe(2)
    expect(floats[36]).toBeCloseTo(-0.4)
    expect(floats[39]).toBe(1.5)
  })

  it('keeps the two lanes the shader divides or scales by off zero', () => {
    const { floats } = write({ noiseFrequency: 0, speedCap: 0, sizeBump: -3 })
    // The noise is sampled at position times this; zero would stop the flow.
    expect(floats[25]).toBeGreaterThan(0)
    // The cap clamps the velocity; zero would freeze every particle.
    expect(floats[31]).toBeGreaterThan(0)
    expect(floats[39]).toBe(0)
  })

  it('fills the whole uniform and no more', () => {
    const { floats } = write()
    expect(floats).toHaveLength(PARTICLE_UNIFORM_FLOATS)
    for (const value of floats) expect(Number.isFinite(value)).toBe(true)
  })
})
