// Every native study manifest, keyed by the id the engine's `studies` table uses.
// Adding a study here and giving it a `renderer: 'native'` entry in engine.ts is
// all the wiring a new study needs.
import type { StudyManifest } from '../study-manifest.ts'
import { tunnelStudy } from './tunnel.ts'

export const nativeStudies: Record<string, StudyManifest> = {
  [tunnelStudy.id]: tunnelStudy,
}

export { tunnelStudy } from './tunnel.ts'
