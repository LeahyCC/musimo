/**
 * The six presets, two per scene, parsed at load. They are JSON so that one
 * is a file of numbers and nothing else, and they go through `parsePreset` on
 * the way in, so a typo in a knob name is an error naming the file and the
 * path rather than a scene quietly drawing with a default.
 *
 * Nothing here touches the GPU or WGSL, so the stage's top bar can import it
 * for the picker without pulling the visualizer into the main bundle.
 */
import drift from './drift.json'
import fold from './fold.json'
import furnace from './furnace.json'
import { parsePreset } from './parse'
import plume from './plume.json'
import storm from './storm.json'
import type { Preset } from './types'
import wash from './wash.json'

/** The order the picker lists them in, and the order `[` and `]` walk. */
export const PRESETS: readonly Preset[] = [
  parsePreset(drift, 'presets/drift.json'),
  parsePreset(storm, 'presets/storm.json'),
  parsePreset(plume, 'presets/plume.json'),
  parsePreset(wash, 'presets/wash.json'),
  parsePreset(fold, 'presets/fold.json'),
  parsePreset(furnace, 'presets/furnace.json'),
]

/** The particle field as PR #56 tuned it, which is what the stage showed. */
export const DEFAULT_PRESET_ID = 'drift'

export const findPreset = (id: string): Preset | undefined =>
  PRESETS.find((entry) => entry.id === id)

/** The preset named, or the default; a stored choice goes through here. */
export function presetOrDefault(id: string): Preset {
  const found = findPreset(id) ?? findPreset(DEFAULT_PRESET_ID) ?? PRESETS[0]
  if (!found) throw new Error('presets: none were loaded')
  return found
}

/** Where `[` and `]` land from here. Wraps both ways. */
export function stepPreset(id: string, delta: number): Preset {
  const at = PRESETS.findIndex((entry) => entry.id === id)
  const from = at < 0 ? 0 : at
  const next = (((from + delta) % PRESETS.length) + PRESETS.length) % PRESETS.length
  return PRESETS[next] ?? presetOrDefault(DEFAULT_PRESET_ID)
}

/** The first preset written for a scene; where the scene select points. */
export const firstPresetOf = (scene: Preset['scene']): Preset =>
  PRESETS.find((entry) => entry.scene === scene) ?? presetOrDefault(DEFAULT_PRESET_ID)
