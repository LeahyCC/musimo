import { readStored, writeStored } from '../../lib/storage'
import { storedValue } from '../../lib/stored-value'
import { parseCrossfade } from './crossfade'

export const CROSSFADE_KEY = 'musimo.crossfade'

// The player and the settings page both read this, so a change on the page reaches a track that is
// already playing. Same shape as the ReplayGain settings.
const crossfade = storedValue(() => parseCrossfade(readStored(CROSSFADE_KEY)))

export function setCrossfadeSeconds(next: number) {
  writeStored(CROSSFADE_KEY, String(next))
  crossfade.set(next)
}

export const useCrossfadeSeconds = crossfade.use
