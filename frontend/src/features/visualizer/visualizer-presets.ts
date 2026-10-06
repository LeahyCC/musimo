// Only the names: the presets themselves are loaded with the stage, so the pickers stay cheap.
import { getBasePresetKeys } from 'butterchurn-presets/presetPackMeta.js'

import { HARD_PRESETS, PULSE_PRESETS, SOFT_PRESETS } from './visualizer-scenes'
import type { Scene } from './visualizer-scenes'

// Where the rule in `presetLabel` reads badly: the title is an author's name, a remix note is
// fused onto it, or it runs to a sentence. Keyed by the preset's full name.
export const LABEL_FIXES: Record<string, string> = {
  'suksma - Hexcollie - Julian Carnival - shimmy dumb grid': 'Julian Carnival',
  'suksma - Rovastar - Sunflower Passion (Enlightment Mix)_Phat_edit + flexi und martin shaders - circumflex in character classes in regular expression':
    'Sunflower Passion',
  'Milk Artist At our Best - FED - SlowFast Ft AdamFX n Martin - HD CosmoFX': 'SlowFast',
  'Eo.S. - glowsticks v2 05 and proton lights (+Krash′s beat code) _Phat_remix02b':
    'Glowsticks and proton lights',
  'Phat+fiShbRaiN+Eo.S_Mandala_Chasers_remix': 'Mandala chasers',
  'AdamFx 2 Geiss, Zylot and Flexi - Reaction Diffusion 3 (Overload Mix 2) EATIT4 hypno':
    'Reaction Diffusion 3',
  'shifter - dark tides bdrv mix 2': 'Dark tides',
  'high-altitude basket unraveling - singh grooves nitrogen argon nz+': 'Singh grooves',
  'flexi - patternton, district of media, capitol of the united abstractions of fractopia':
    'Patternton',
  'flexi + amandio c - organic12-3d-2.milk': 'Organic 12',
}

/**
 * A preset's full name is its authors, its title and whatever mix notes collected over the years
 * ("Geiss - Cauldron - painterly 2 (saturation remix)"). This keeps the title ("Cauldron"): the
 * part after the first " - ", with bracketed notes, underscores and a `.milk` ending dropped. A
 * bare number there is a catalogue number, so the part after it is taken instead. A numbered
 * "(197)" is kept, since it is what tells three Mashups apart.
 */
export function presetLabel(name: string) {
  const fixed = LABEL_FIXES[name]
  if (fixed) return fixed
  const parts = name
    .replace(/\[[^\]]*\]|\((?!\d+\))[^)]*\)/g, ' ')
    .replace(/\.milk$/i, '')
    .replace(/^[_$\s]+/, '')
    .split(' - ')
    .map((part) => part.replace(/_/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const titles = parts.length > 1 ? parts.slice(1) : parts
  const title = titles.find((part) => !/^\d+$/.test(part)) ?? parts[0] ?? name
  return title.charAt(0).toUpperCase() + title.slice(1)
}

/**
 * Every preset in butterchurn's base pack, by full name, which is also the id that is stored.
 * Sorted by label, so the picker reads A to Z and `[` and `]` walk it in the same order.
 */
export const PRESET_NAMES: readonly string[] = [...getBasePresetKeys().presets].sort((a, b) =>
  presetLabel(a).localeCompare(presetLabel(b), undefined, { numeric: true }),
)

export const DEFAULT_PRESET = 'Flexi, martin + geiss - dedicated to the sherwin maxawow'

export const presetOrDefault = (name: string) =>
  PRESET_NAMES.includes(name) ? name : DEFAULT_PRESET

const PILES: Record<Scene, readonly string[]> = {
  soft: SOFT_PRESETS,
  pulse: PULSE_PRESETS,
  hard: HARD_PRESETS,
}

/** Any preset but `name`. `random` is 0 to 1, as `Math.random` gives. */
export function randomPreset(name: string, random = Math.random()) {
  const others = PRESET_NAMES.filter((other) => other !== name)
  return others[Math.floor(random * others.length)] ?? DEFAULT_PRESET
}

/** Another preset from the pile that fits `scene`. `random` is 0 to 1. */
export function presetForScene(name: string, scene: Scene, random = Math.random()) {
  const pile = PILES[scene].filter((other) => other !== name)
  const pool = pile.length > 0 ? pile : PRESET_NAMES.filter((other) => other !== name)
  return pool[Math.floor(random * pool.length)] ?? DEFAULT_PRESET
}

/** The preset `delta` places along from `name`, wrapping at both ends. */
export function stepPreset(name: string, delta: number) {
  const count = PRESET_NAMES.length
  const from = Math.max(0, PRESET_NAMES.indexOf(presetOrDefault(name)))
  return PRESET_NAMES[(((from + delta) % count) + count) % count] ?? DEFAULT_PRESET
}
