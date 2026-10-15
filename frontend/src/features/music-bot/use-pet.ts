import { useEffect, useState, useSyncExternalStore } from 'react'

import { useTheme } from '../../theme/store'
import { usePlayer } from '../player/player'
import { useBotChat } from './bot-chat'
import { petMood } from './pet-mood'
import type { PetState } from './pet-mood'
import { petMotion, petPaint, usePetSettings } from './pet-settings'
import type { PetMotion, PetPaint, PetSettings } from './pet-settings'

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)'
const subscribeReduced = (notify: () => void) => {
  const query = window.matchMedia(REDUCED_QUERY)
  query.addEventListener('change', notify)
  return () => query.removeEventListener('change', notify)
}

/** Whether the device asks for reduced motion, following the setting as it changes. */
export const useDeviceReducedMotion = () =>
  useSyncExternalStore(
    subscribeReduced,
    () => window.matchMedia(REDUCED_QUERY).matches,
    () => false,
  )

export type PetLook = {
  settings: PetSettings
  motion: PetMotion
  paint: PetPaint | null
  pixel: boolean
}

/** How the pet is drawn here: the person's settings, the device's motion setting and the skin. */
export function usePetLook(): PetLook {
  const settings = usePetSettings()
  const theme = useTheme()
  const reduced = useDeviceReducedMotion()
  return {
    settings,
    motion: petMotion(settings.motion, reduced),
    paint: petPaint(settings.colour, theme.scheme),
    pixel: theme.skin === 'win95',
  }
}

/**
 * The pet's pose, from what is really going on: playback, the chat request, a library scan and
 * whether the model server answers. Wakes itself up only when a timed pose is due to end.
 */
export function usePetState(): PetState {
  const player = usePlayer()
  const chat = useBotChat()
  const loaded = Boolean(player.libraryTrack || player.track)
  const [, setTick] = useState(0)

  const mood = petMood({
    now: Date.now(),
    thinking: chat.thinking,
    scanning: chat.locked === 'busy',
    offline: chat.locked === 'offline' || chat.locked === 'nomodel',
    outcome: chat.outcome,
    unread: chat.unread,
    loaded,
    playing: player.playing,
    pausedAt: chat.pausedAt,
    trackChangedAt: chat.trackChangedAt,
    sleepTimer: player.sleep !== null,
  })

  useEffect(() => {
    if (mood.until === null) return
    const wait = Math.max(0, mood.until - Date.now()) + 50
    const timer = setTimeout(() => setTick((tick) => tick + 1), wait)
    return () => clearTimeout(timer)
  }, [mood.until])

  return mood.state
}
