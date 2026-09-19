import { useSyncExternalStore } from 'react'

import { DEFAULT_CROSSFADE_SECONDS, parseCrossfade } from './crossfade'

export const CROSSFADE_KEY = 'musimo.crossfade'

const read = (): string | null => {
  try {
    return localStorage.getItem(CROSSFADE_KEY)
  } catch {
    return null
  }
}

// The player and the settings page both read this, so a change on the page reaches a track that is
// already playing. Same shape as the ReplayGain settings.
let seconds = DEFAULT_CROSSFADE_SECONDS
let loaded = false
const listeners = new Set<() => void>()

function refresh() {
  const next = parseCrossfade(read())
  if (next === seconds) return
  seconds = next
  for (const listener of listeners) listener()
}

function snapshot(): number {
  if (!loaded) {
    loaded = true
    seconds = parseCrossfade(read())
  }
  return seconds
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

export function setCrossfadeSeconds(next: number) {
  try {
    localStorage.setItem(CROSSFADE_KEY, String(next))
  } catch {
    /* Browser storage is optional. The change still holds until the page closes. */
  }
  snapshot()
  seconds = next
  for (const listener of listeners) listener()
}

export const useCrossfadeSeconds = () => useSyncExternalStore(subscribe, snapshot, snapshot)
