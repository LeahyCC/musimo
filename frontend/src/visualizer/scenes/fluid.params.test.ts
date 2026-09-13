import { describe, expect, it } from 'vitest'

import { F, PACKET_LENGTH } from '../audio/FeatureExtractor'
import { presetOrDefault } from '../presets'
import type { Tuning } from '../presets/knobs'
import { resolveScene } from '../presets/resolve'
import { DEFAULT_FLUID_SIZE, SOFTWARE_FLUID_SIZE } from './catalog'
import {
  EMITTERS,
  FLUID_DEFAULTS,
  fluidFrame,
  fluidParams,
  PALETTE_SIZE,
  PALETTE_STOPS,
  paletteLut,
  SIM_UNIFORM_FLOATS,
  simSize,
  visibleExtent,
  writeSimUniform,
} from './fluid.params'

const packet = (values: Partial<Record<keyof typeof F, number>> = {}) => {
  const out = new Float32Array(PACKET_LENGTH)
  for (const [name, value] of Object.entries(values)) out[F[name as keyof typeof F]] = value
  return out
}

const square = { x: 0.5, y: 0.5 }

// The shipped fluid preset, resolved the way the renderer resolves it, so
// these read the behaviour the stage actually has rather than a bare default.
const plume = presetOrDefault('plume')

const frame = (
  values: Partial<Record<keyof typeof F, number>> = {},
  dt = 1 / 60,
  visible = square,
) => {
  const features = packet(values)
  const tuning = resolveScene(plume.sceneParams, plume.audioMapping, features, {})
  return fluidFrame(fluidParams(tuning), features, dt, visible)
}

describe('fluid grid size', () => {
  it('takes an offered size and falls back to the default for anything else', () => {
    expect(simSize(1024, false)).toBe(1024)
    expect(simSize(512, false)).toBe(512)
    expect(simSize(2048, false)).toBe(DEFAULT_FLUID_SIZE)
  })

  it('gives a software rasteriser the small grid whatever was chosen', () => {
    expect(simSize(1024, true)).toBe(SOFTWARE_FLUID_SIZE)
  })
})

describe('visible extent', () => {
  it('shows the whole square on a square canvas', () => {
    expect(visibleExtent(600, 600)).toEqual({ x: 0.5, y: 0.5 })
  })

  it('crops the short axis, so the scale is the same on both', () => {
    const wide = visibleExtent(1920, 1080)
    expect(wide.x).toBe(0.5)
    expect(wide.y).toBeCloseTo(0.5 / (1920 / 1080), 6)
    const tall = visibleExtent(1080, 1920)
    expect(tall.y).toBe(0.5)
    expect(tall.x).toBeCloseTo(0.5 * (1080 / 1920), 6)
  })

  it('survives a canvas with no area rather than dividing by zero', () => {
    const extent = visibleExtent(0, 0)
    expect(Number.isFinite(extent.x)).toBe(true)
    expect(Number.isFinite(extent.y)).toBe(true)
  })
})

describe('fluidParams', () => {
  it('takes the resolved value where there is one and the default otherwise', () => {
    expect(fluidParams({ vorticity: 40 }).vorticity).toBe(40)
    expect(fluidParams({}).viscosity).toBe(FLUID_DEFAULTS.viscosity)
    // A knob no scene offers; the parser rejects one, so this is the backstop.
    expect(fluidParams({ flow: 3 } as Tuning)).toEqual(FLUID_DEFAULTS)
  })
})

describe('fluid frame', () => {
  it('places every emitter inside the part of the grid the canvas shows', () => {
    const wide = visibleExtent(1920, 1080)
    // Louder music spreads the emitters further, so the loudest case is the
    // one that could push them off screen.
    for (const time of [0, 1.7, 5.3, 11, 23.5]) {
      const built = frame({ time, energy: 1 }, 1 / 60, wide)
      expect(built.splats).toHaveLength(EMITTERS)
      for (const splat of built.splats) {
        expect(Math.abs(splat.x - 0.5)).toBeLessThanOrEqual(wide.x)
        expect(Math.abs(splat.y - 0.5)).toBeLessThanOrEqual(wide.y)
      }
    }
  })

  it('pushes along the orbit, so the direction is a unit vector', () => {
    const built = frame({ time: 3.1 })
    for (const splat of built.splats) expect(Math.hypot(splat.dx, splat.dy)).toBeCloseTo(1, 6)
  })

  it('injects much harder on an onset, and harder still with bass', () => {
    const quiet = frame()
    const hit = frame({ onset: 1, onsetStrength: 1 })
    const loud = frame({ onset: 1, onsetStrength: 1, bass: 1 })
    const force = (frame: { splats: { force: number }[] }) => frame.splats[0]?.force ?? 0
    const dye = (frame: { splats: { dye: number }[] }) => frame.splats[0]?.dye ?? 0

    expect(force(hit)).toBeGreaterThan(force(quiet) * 5)
    expect(force(loud)).toBeGreaterThan(force(hit))
    expect(dye(hit)).toBeGreaterThan(dye(quiet) * 5)
    expect(dye(loud)).toBeGreaterThan(dye(hit))
  })

  it('keeps a trickle between onsets, scaled by the step so the rate holds', () => {
    const slow = frame()
    const fast = frame({}, 1 / 120)
    expect(slow.splats[0]?.dye ?? 0).toBeGreaterThan(0)
    expect(fast.splats[0]?.dye ?? 0).toBeCloseTo((slow.splats[0]?.dye ?? 0) / 2, 6)
  })

  it('clamps the step, so a stalled tab cannot advance the sim by a second', () => {
    expect(frame({}, 1).dt).toBeLessThanOrEqual(1 / 30)
    expect(frame({}, 0).dt).toBeGreaterThan(0)
  })

  it('raises vorticity with treble and clears the dye faster with energy', () => {
    const dull = frame()
    const bright = frame({ treble: 1 })
    expect(bright.vorticity).toBeGreaterThan(dull.vorticity)
    // More treble means less smoothing, so the detail survives.
    expect(bright.viscosity).toBeLessThan(dull.viscosity)

    const loud = frame({ energy: 1 })
    expect(loud.dyeDecay).toBeGreaterThan(dull.dyeDecay)
    expect(loud.velocityDecay).toBeGreaterThan(dull.velocityDecay)
  })

  it('keeps the palette coordinate inside the table', () => {
    for (const time of [0, 9, 60, 600, 4000]) {
      const built = frame({ time, treble: 1 })
      for (const splat of built.splats) {
        expect(splat.colour).toBeGreaterThanOrEqual(0)
        expect(splat.colour).toBeLessThan(1)
      }
    }
  })
})

describe('palette', () => {
  it('is one opaque row of the requested length', () => {
    const lut = paletteLut()
    expect(lut).toHaveLength(PALETTE_SIZE * 4)
    for (let index = 3; index < lut.length; index += 4) expect(lut[index]).toBe(255)
  })

  it('starts and ends on the same colour, so the coordinate wraps with no seam', () => {
    const lut = paletteLut()
    const last = (PALETTE_SIZE - 1) * 4
    for (let part = 0; part < 3; part++) expect(lut[last + part]).toBe(lut[part])
  })

  it('lands on each stop and moves between them', () => {
    const lut = paletteLut(PALETTE_SIZE)
    const stop = PALETTE_STOPS[3]
    expect(stop).toBeDefined()
    const at = Math.round((stop?.at ?? 0) * (PALETTE_SIZE - 1)) * 4
    expect(lut[at]).toBeCloseTo(Math.round((stop?.colour[0] ?? 0) * 255), -1)
    // Not one flat colour: the middle differs from the ends.
    expect(lut[PALETTE_SIZE * 2]).not.toBe(lut[0])
  })
})

describe('sim uniform', () => {
  it('writes the grid, its texel and the cover scale the shader divides by', () => {
    const visible = visibleExtent(1920, 1080)
    const built = frame({}, 1 / 60, visible)
    const out = writeSimUniform(built, 512, visible, new Float32Array(SIM_UNIFORM_FLOATS))

    expect(out[0]).toBe(512)
    expect(out[1]).toBe(512)
    expect(out[2]).toBeCloseTo(1 / 512, 8)
    expect(out[12]).toBeCloseTo(visible.x * 2, 6)
    expect(out[13]).toBeCloseTo(visible.y * 2, 6)
  })

  it('never writes a radius the shader would divide by zero', () => {
    const built = frame()
    built.splats = []
    const out = writeSimUniform(built, 1024, square, new Float32Array(SIM_UNIFORM_FLOATS))
    for (let index = 0; index < EMITTERS; index++)
      expect(out[16 + index * 8 + 5] ?? 0).toBeGreaterThan(0)
  })

  it('carries every emitter through in order', () => {
    const built = frame({ time: 2, onset: 1, onsetStrength: 1 })
    const out = writeSimUniform(built, 512, square, new Float32Array(SIM_UNIFORM_FLOATS))
    built.splats.forEach((splat, index) => {
      const base = 16 + index * 8
      expect(out[base]).toBeCloseTo(splat.x, 6)
      expect(out[base + 1]).toBeCloseTo(splat.y, 6)
      expect(out[base + 4]).toBeCloseTo(splat.force, 6)
      expect(out[base + 6]).toBeCloseTo(splat.dye, 6)
    })
  })
})
