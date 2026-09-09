// Every native study manifest, keyed by the id the engine's `studies` table uses.
// Adding a study here and giving it a `renderer: 'native'` entry in engine.ts is
// all the wiring a new study needs.
import type { StudyManifest } from '../study-manifest.ts'
import { contoursStudy } from './contours.ts'
import { diveStudy } from './dive.ts'
import { juliaStudy } from './julia.ts'
import { kaleidoscopeStudy } from './kaleidoscope.ts'
import { tunnelStudy } from './tunnel.ts'

export const nativeStudies: Record<string, StudyManifest> = {
  [diveStudy.id]: diveStudy,
  [tunnelStudy.id]: tunnelStudy,
  [kaleidoscopeStudy.id]: kaleidoscopeStudy,
  [juliaStudy.id]: juliaStudy,
  [contoursStudy.id]: contoursStudy,
}

export { diveStudy } from './dive.ts'
export { tunnelStudy } from './tunnel.ts'
export { kaleidoscopeStudy } from './kaleidoscope.ts'
export { juliaStudy } from './julia.ts'
export { contoursStudy } from './contours.ts'
