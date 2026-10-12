/** What the last stretch of a sleep timer sounds like: a fade to silence, then a pause. */
export const SLEEP_FADE_SECONDS = 5
export const SLEEP_MINUTES: readonly number[] = [15, 30, 45, 60]

/**
 * What a listener asked for. `track` stops after the track that is playing; `queue` after the last
 * track of the queue, which for an album is the end of the album; `minutes` after that long.
 */
export type SleepChoice =
  { kind: 'track' } | { kind: 'queue' } | { kind: 'minutes'; minutes: number }

/** A timer that is running, and how long it has left, for the control to show. */
export type SleepStatus = { choice: SleepChoice; remaining: number }

/** The value of a menu choice: `track`, `queue` or the number of minutes. */
export const sleepChoiceValue = (choice: SleepChoice): string =>
  choice.kind === 'minutes' ? String(choice.minutes) : choice.kind

/** The choice a menu value stands for, or null for Off and for anything that is not offered. */
export function parseSleepChoice(value: string): SleepChoice | null {
  if (value === 'track' || value === 'queue') return { kind: value }
  const minutes = SLEEP_MINUTES.find((option) => String(option) === value)
  return minutes === undefined ? null : { kind: 'minutes', minutes }
}

export const sleepChoiceLabel = (choice: SleepChoice): string => {
  if (choice.kind === 'track') return 'the end of this track'
  if (choice.kind === 'queue') return 'the end of the album or queue'
  return `${choice.minutes} minutes`
}
