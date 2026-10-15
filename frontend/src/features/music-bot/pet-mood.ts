/* What the pet is doing, decided from things that really happened: playback, the chat request,
   a library scan and whether the model server answers. It never reacts to the sound itself,
   because nothing here can hear it, so there is no beat and no "this song is lively". */

export const PET_STATES = [
  'idle',
  'listening',
  'sleeping',
  'thinking',
  'talking',
  'happy',
  'confused',
  'sorry',
  'busy',
  'offline',
] as const
export type PetState = (typeof PET_STATES)[number]

/** A finished chat request leaves its pose up this long, then playback takes over again. */
export const OUTCOME_MS = 6_000
/** A skip or a new track gets a quick perk-up before listening resumes. */
export const PERK_MS = 1_500
/** Paused this long, the pet nods off. */
export const DOZE_MS = 3 * 60_000

export type ChatOutcome = 'talking' | 'happy' | 'confused' | 'sorry'

export type PetInputs = {
  now: number
  /** A chat request is in flight. */
  thinking: boolean
  /** `GET /api/library` reports a scan running, so the chat cannot search yet. */
  scanning: boolean
  /** The model server did not answer, or no installed model is chosen. */
  offline: boolean
  outcome: { mood: ChatOutcome; at: number } | null
  /** A reply arrived while the chat was closed and has not been seen. */
  unread: boolean
  /** Something is loaded in the player. */
  loaded: boolean
  playing: boolean
  pausedAt: number | null
  trackChangedAt: number | null
  sleepTimer: boolean
}

export type PetMood = {
  state: PetState
  /** When the answer can change with nothing else happening, so a caller knows when to look again. */
  until: number | null
}

/**
 * The order is what the person most needs to know first. Work in progress beats everything; a
 * chat that cannot work comes next, since tapping the pet would only show that; then a fresh
 * reply; then playback.
 */
export function petMood(input: PetInputs): PetMood {
  const { now } = input
  if (input.thinking) return { state: 'thinking', until: null }
  if (input.scanning) return { state: 'busy', until: null }
  if (input.offline) return { state: 'offline', until: null }
  if (input.outcome && now - input.outcome.at < OUTCOME_MS)
    return { state: input.outcome.mood, until: input.outcome.at + OUTCOME_MS }
  if (input.unread) return { state: 'talking', until: null }
  if (input.playing && input.trackChangedAt !== null && now - input.trackChangedAt < PERK_MS)
    return { state: 'happy', until: input.trackChangedAt + PERK_MS }
  if (input.loaded && input.sleepTimer) return { state: 'sleeping', until: null }
  if (input.playing) return { state: 'listening', until: null }
  if (input.loaded && input.pausedAt !== null) {
    const dozes = input.pausedAt + DOZE_MS
    return now >= dozes ? { state: 'sleeping', until: null } : { state: 'idle', until: dozes }
  }
  return { state: 'idle', until: null }
}
