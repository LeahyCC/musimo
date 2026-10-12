import { readStored, writeStored } from '../../lib/storage'
import { storedValue } from '../../lib/stored-value'
import { parsePreamp, parseReplayGainMode } from './replay-gain'
import type { ReplayGainMode } from './replay-gain'

export const REPLAY_GAIN_KEY = 'musimo.replay-gain'
export const PREAMP_KEY = 'musimo.replay-gain-preamp'

export type ReplayGainSettings = { mode: ReplayGainMode; preampDb: number }

// The player and the settings page both read this, so a change on the page reaches a track that
// is already playing.
const replayGain = storedValue<ReplayGainSettings>(
  () => ({
    mode: parseReplayGainMode(readStored(REPLAY_GAIN_KEY)),
    preampDb: parsePreamp(readStored(PREAMP_KEY)),
  }),
  (a, b) => a.mode === b.mode && a.preampDb === b.preampDb,
)

export function setReplayGainMode(mode: ReplayGainMode) {
  writeStored(REPLAY_GAIN_KEY, mode)
  replayGain.set({ ...replayGain.get(), mode })
}

export function setReplayGainPreamp(preampDb: number) {
  writeStored(PREAMP_KEY, String(preampDb))
  replayGain.set({ ...replayGain.get(), preampDb })
}

export const useReplayGainSettings = replayGain.use
