import type { CSSProperties } from 'react'

import type { PetMotion } from './pet-settings'

// Opacity and tiny-scale loops survive "reduced"; travel, sway, hop and spin do not.
const SAFE = new Set([
  'pet-blink',
  'pet-talk',
  'pet-dot',
  'pet-pulse',
  'pet-px-blink-a',
  'pet-px-blink-b',
  'pet-px-a',
  'pet-px-b',
])

export function anim(motion: PetMotion, name: string, rest: string): CSSProperties {
  if (motion === 'off') return {}
  if (motion === 'reduced' && !SAFE.has(name)) return {}
  return { animation: `${name} ${rest}` }
}
