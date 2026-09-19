import { useSyncExternalStore } from 'react'

import {
  DEFAULT_PREAMP_DB,
  DEFAULT_REPLAY_GAIN_MODE,
  parsePreamp,
  parseReplayGainMode,
} from './replay-gain'
import type { ReplayGainMode } from './replay-gain'

export const REPLAY_GAIN_KEY = 'musimo.replay-gain'
export const PREAMP_KEY = 'musimo.replay-gain-preamp'

export type ReplayGainSettings = { mode: ReplayGainMode; preampDb: number }

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const load = (): ReplayGainSettings => ({
  mode: parseReplayGainMode(read(REPLAY_GAIN_KEY)),
  preampDb: parsePreamp(read(PREAMP_KEY)),
})

// The player and the settings page both read this, so a change on the page reaches a track that
// is already playing. The snapshot is replaced only when something changes, which is what
// useSyncExternalStore needs to avoid re-rendering on every read.
let settings: ReplayGainSettings = {
  mode: DEFAULT_REPLAY_GAIN_MODE,
  preampDb: DEFAULT_PREAMP_DB,
}
let loaded = false
const listeners = new Set<() => void>()

function refresh() {
  const next = load()
  if (next.mode === settings.mode && next.preampDb === settings.preampDb) return
  settings = next
  for (const listener of listeners) listener()
}

function snapshot(): ReplayGainSettings {
  if (!loaded) {
    loaded = true
    settings = load()
  }
  return settings
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  // Another tab changing the setting fires `storage` here.
  window.addEventListener('storage', refresh)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', refresh)
  }
}

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* Browser storage is optional. The change still holds until the page closes. */
  }
}

export function setReplayGainMode(mode: ReplayGainMode) {
  save(REPLAY_GAIN_KEY, mode)
  settings = { ...snapshot(), mode }
  for (const listener of listeners) listener()
}

export function setReplayGainPreamp(preampDb: number) {
  save(PREAMP_KEY, String(preampDb))
  settings = { ...snapshot(), preampDb }
  for (const listener of listeners) listener()
}

export const useReplayGainSettings = () => useSyncExternalStore(subscribe, snapshot, snapshot)
