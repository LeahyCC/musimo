import { describe, expect, it } from 'vitest'

import { DEFAULT_POST_PARAMS } from '../post/params'
import { SCENE_IDS } from '../scenes/catalog'
import { DEFAULT_PRESET_ID, findPreset, firstPresetOf, PRESETS, stepPreset } from './index'
import { FLUID_KNOBS, SCENE_KNOBS } from './knobs'
import { parsePreset } from './parse'
import type { Preset } from './types'

const fluidParams = (): Record<string, number> =>
  Object.fromEntries(FLUID_KNOBS.map((knob) => [knob, 1]))

const good = () => ({
  id: 'test',
  name: 'Test',
  scene: 'fluid',
  sceneParams: fluidParams(),
  postParams: { bloom: { intensity: 0.5 } },
  audioMapping: [{ from: 'treble', to: 'vorticity', gain: 2 }],
})

describe('parsePreset', () => {
  it('reads a whole preset', () => {
    const preset = parsePreset(good(), 'test.json')
    expect(preset.scene).toBe('fluid')
    expect(preset.sceneParams.vorticity).toBe(1)
    expect(preset.audioMapping).toEqual([
      { from: 'treble', to: 'vorticity', gain: 2, curve: 'linear' },
    ])
  })

  it('resolves the post patch over the stack defaults', () => {
    const preset = parsePreset(good(), 'test.json')
    expect(preset.postParams.bloom.intensity).toBe(0.5)
    expect(preset.postParams.bloom.threshold).toBe(DEFAULT_POST_PARAMS.bloom.threshold)
    expect(preset.postParams.feedback).toEqual(DEFAULT_POST_PARAMS.feedback)
    // The defaults are handed out fresh, not shared with the next preset.
    expect(preset.postParams.bloom.weights).not.toBe(DEFAULT_POST_PARAMS.bloom.weights)
  })

  it('names the file and the path when a knob is missing', () => {
    const broken = good()
    delete broken.sceneParams.viscosity
    expect(() => parsePreset(broken, 'presets/broken.json')).toThrow(
      'presets/broken.json: sceneParams.viscosity is missing',
    )
  })

  it('rejects a knob that is not this scene’s', () => {
    const broken = { ...good(), sceneParams: { ...fluidParams(), flow: 3 } }
    expect(() => parsePreset(broken, 'b.json')).toThrow(/sceneParams\.flow is not a knob/)
  })

  it('rejects a mapping onto a knob no scene offers', () => {
    const broken = { ...good(), audioMapping: [{ from: 'treble', to: 'flow', gain: 1 }] }
    expect(() => parsePreset(broken, 'b.json')).toThrow(
      /audioMapping\[0\]\.to is neither a knob of this scene/,
    )
  })

  it('rejects a feature that does not exist', () => {
    const broken = { ...good(), audioMapping: [{ from: 'bassline', to: 'vorticity', gain: 1 }] }
    expect(() => parsePreset(broken, 'b.json')).toThrow(/audioMapping\[0\]\.from is not a feature/)
  })

  it('rejects a curve that does not exist', () => {
    const broken = {
      ...good(),
      audioMapping: [{ from: 'treble', to: 'vorticity', gain: 1, curve: 'cubed' }],
    }
    expect(() => parsePreset(broken, 'b.json')).toThrow(/audioMapping\[0\]\.curve is not a curve/)
  })

  it('rejects a gain that is not a finite number', () => {
    const broken = { ...good(), audioMapping: [{ from: 'treble', to: 'vorticity', gain: 'lots' }] }
    expect(() => parsePreset(broken, 'b.json')).toThrow(
      'b.json: audioMapping[0].gain expected a finite number, got "lots"',
    )
  })

  it('rejects a post field that is not part of its stage', () => {
    const broken = { ...good(), postParams: { bloom: { radius: 2 } } }
    expect(() => parsePreset(broken, 'b.json')).toThrow(
      /postParams\.bloom\.radius is not a field of bloom/,
    )
  })

  it('rejects a post stage that does not exist', () => {
    const broken = { ...good(), postParams: { vignette: { amount: 1 } } }
    expect(() => parsePreset(broken, 'b.json')).toThrow(/postParams\.vignette is not a post stage/)
  })

  it('takes three bloom weights and nothing else', () => {
    const preset = parsePreset(
      { ...good(), postParams: { bloom: { weights: [0.6, 0.3, 0.1] } } },
      'b.json',
    )
    expect(preset.postParams.bloom.weights).toEqual([0.6, 0.3, 0.1])
    expect(() =>
      parsePreset({ ...good(), postParams: { bloom: { weights: [1, 2] } } }, 'b.json'),
    ).toThrow(/postParams\.bloom\.weights expected three numbers/)
  })

  it('takes a stage switch as a boolean only', () => {
    const off = parsePreset({ ...good(), postParams: { grain: { enabled: false } } }, 'b.json')
    expect(off.postParams.grain.enabled).toBe(false)
    expect(() =>
      parsePreset({ ...good(), postParams: { grain: { enabled: 'no' } } }, 'b.json'),
    ).toThrow(/postParams\.grain\.enabled expected true or false/)
  })

  it('rejects a scene that does not exist, and a preset that is not an object', () => {
    expect(() => parsePreset({ ...good(), scene: 'tunnel' }, 'b.json')).toThrow(
      /scene is not a scene/,
    )
    expect(() => parsePreset([1, 2], 'b.json')).toThrow('b.json: the preset expected an object')
    expect(() => parsePreset(null, 'b.json')).toThrow('b.json: the preset expected an object')
  })

  it('rejects a key that is not part of a preset', () => {
    expect(() => parsePreset({ ...good(), colour: 'blue' }, 'b.json')).toThrow(
      'b.json: colour is not part of a preset',
    )
  })
})

describe('the presets', () => {
  it('are two per scene, every one parsed', () => {
    expect(PRESETS).toHaveLength(2 * SCENE_IDS.length)
    for (const scene of SCENE_IDS)
      expect(PRESETS.filter((preset) => preset.scene === scene)).toHaveLength(2)
  })

  it('give every knob of their own scene a finite number', () => {
    for (const preset of PRESETS) {
      const knobs: readonly string[] = SCENE_KNOBS[preset.scene]
      const params: Record<string, number> = preset.sceneParams
      expect(Object.keys(params).sort()).toEqual([...knobs].sort())
      for (const value of Object.values(params)) expect(Number.isFinite(value)).toBe(true)
    }
  })

  it('have unique ids and names', () => {
    expect(new Set(PRESETS.map((preset) => preset.id)).size).toBe(PRESETS.length)
    expect(new Set(PRESETS.map((preset) => preset.name)).size).toBe(PRESETS.length)
  })

  it('has a default that exists and draws the fluid', () => {
    const preset = findPreset(DEFAULT_PRESET_ID) as Preset
    expect(preset).toBeDefined()
    expect(preset.scene).toBe('fluid')
  })

  it('steps both ways and wraps', () => {
    const first = PRESETS[0] as Preset
    const last = PRESETS[PRESETS.length - 1] as Preset
    expect(stepPreset(first.id, 1).id).toBe(PRESETS[1]?.id)
    expect(stepPreset(first.id, -1).id).toBe(last.id)
    expect(stepPreset(last.id, 1).id).toBe(first.id)
    // An id nobody recognises starts the walk from the top rather than off it.
    expect(stepPreset('gone', 1).id).toBe(PRESETS[1]?.id)
  })

  it('offers a first preset for every scene', () => {
    for (const scene of SCENE_IDS) expect(firstPresetOf(scene).scene).toBe(scene)
  })
})
