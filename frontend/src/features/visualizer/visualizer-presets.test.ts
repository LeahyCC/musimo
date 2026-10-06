import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PRESET,
  LABEL_FIXES,
  PRESET_NAMES,
  presetForScene,
  presetLabel,
  presetOrDefault,
  randomPreset,
  stepPreset,
} from './visualizer-presets'
import { HARD_PRESETS, PULSE_PRESETS, SOFT_PRESETS } from './visualizer-scenes'

describe('visualizer presets', () => {
  it('has the default in the pack', () => {
    expect(PRESET_NAMES).toContain(DEFAULT_PRESET)
  })

  it('falls back to the default for a name it does not know', () => {
    expect(presetOrDefault('plume')).toBe(DEFAULT_PRESET)
    expect(presetOrDefault(PRESET_NAMES[3] ?? '')).toBe(PRESET_NAMES[3])
  })

  it('steps both ways and wraps at the ends', () => {
    const first = PRESET_NAMES[0] ?? ''
    const last = PRESET_NAMES[PRESET_NAMES.length - 1] ?? ''
    expect(stepPreset(first, 1)).toBe(PRESET_NAMES[1])
    expect(stepPreset(first, -1)).toBe(last)
    expect(stepPreset(last, 1)).toBe(first)
  })
})

describe('preset labels', () => {
  it('keeps the title and drops authors and mix notes', () => {
    expect(presetLabel('Geiss - Cauldron - painterly 2 (saturation remix)')).toBe('Cauldron')
    expect(presetLabel('$$$ Royal - Mashup (197)')).toBe('Mashup (197)')
    expect(presetLabel('_Mig_049')).toBe('Mig 049')
    expect(presetLabel('yin - 191 - Temporal singularities')).toBe('Temporal singularities')
    expect(presetLabel('flexi - bouncing balls [double mindblob neon mix]')).toBe('Bouncing balls')
  })

  it('gives every preset in the pack a short, distinct label', () => {
    const labels = PRESET_NAMES.map(presetLabel)
    expect(new Set(labels.map((label) => label.toLowerCase())).size).toBe(labels.length)
    for (const label of labels) {
      expect(label).not.toMatch(/[[\]_]| - /)
      expect(label.length).toBeLessThanOrEqual(45)
    }
  })

  it('only fixes names that are in the pack', () => {
    for (const name of Object.keys(LABEL_FIXES)) expect(PRESET_NAMES).toContain(name)
  })
})

describe('random preset', () => {
  it('never picks the one already drawing', () => {
    for (const random of [0, 0.5, 0.999])
      expect(randomPreset(DEFAULT_PRESET, random)).not.toBe(DEFAULT_PRESET)
  })
})

describe('preset scenes', () => {
  it('puts every preset in one pile', () => {
    const piles = [...SOFT_PRESETS, ...PULSE_PRESETS, ...HARD_PRESETS]
    expect(new Set(piles).size).toBe(piles.length)
    expect([...piles].sort()).toEqual([...PRESET_NAMES].sort())
  })

  it('picks another preset from the pile the moment asked for', () => {
    const first = SOFT_PRESETS[0] ?? ''
    const chosen = presetForScene(first, 'soft', 0)
    expect(SOFT_PRESETS).toContain(chosen)
    expect(chosen).not.toBe(first)
    const loud = HARD_PRESETS[0] ?? ''
    const others = HARD_PRESETS.filter((name) => name !== loud)
    expect(presetForScene(loud, 'hard', 0.999)).toBe(others[others.length - 1])
  })
})
