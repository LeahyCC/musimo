// Decides when the visualizer moves to a new preset, and which kind of picture fits.
//
//   bass level ──► fast average (≈0.5 s)
//              └─► slow average (≈6 s)
//   bass flux  ──► a kick, once the rise is sharper than the recent ones
//
// A kick is a beat. How far through the song decides how many beats to wait before the next
// picture: only a big hit at the start, then every 8 beats, then every 4. The melt is shorter
// than that wait, so one change finishes before the next. A big hit is the fast average rising
// well above the slow one. Silence never starts a change.
import type { Scene } from './visualizer-scenes'

export type { Scene } from './visualizer-scenes'

export type Moment = {
  scene: Scene
  /** How long this change should melt, in seconds. */
  blend: number
}

export type MomentOptions = {
  /** Below this the music is too quiet to count, so silence never triggers anything. */
  floor: number
  /** How far, on the 0 to 1 scale, the fast average must rise above the slow one for a drop. */
  rise: number
  /** A stretch counts as quiet when the fast average is under the slow one by this much. */
  quiet: number
  /** Scheduled changes start once the song is this far through, 0 to 1. */
  middleAt: number
  /** Changes get closer once the song is this far through. */
  lateAt: number
  /** Beats between pictures in the middle of the song. */
  middleBeats: number
  /** Beats between pictures near the end. */
  lateBeats: number
  /** Kicks closer than this are the same beat. */
  minBeatMs: number
  /** A drop with no kick to land on still cuts, after this long. */
  dropWaitMs: number
  blendEarly: number
  blendMiddle: number
  blendLate: number
  /** The least time from one change to the next, whatever the beat says. */
  minGapMs: number
}

export const MOMENT_DEFAULTS: MomentOptions = {
  floor: 0.08,
  // Tuned on a real track: 0.12 caught its two drops and nothing else; 0.1 also caught a small
  // lift, and 0.15 missed the second drop.
  rise: 0.12,
  quiet: 0.85,
  middleAt: 1 / 3,
  lateAt: 2 / 3,
  middleBeats: 8,
  lateBeats: 4,
  minBeatMs: 280,
  dropWaitMs: 180,
  blendEarly: 2.7,
  blendMiddle: 0.9,
  blendLate: 0.35,
  minGapMs: 0,
}

/**
 * For someone who asked for less motion. Late in a song the defaults change the whole picture
 * about once a second with a quick melt, which can flash. Here every change waits at least 8 s
 * and melts as slowly as one chosen by hand.
 */
export const CALM_MOMENTS: MomentOptions = {
  ...MOMENT_DEFAULTS,
  blendEarly: 2.7,
  blendMiddle: 2.7,
  blendLate: 2.7,
  minGapMs: 8000,
}

/** Whether the system asks for reduced motion. False where there is no way to ask. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * Whether "Change with the music" is on, from what was stored ('on', 'off', or nothing yet). A
 * choice made in settings stands; with none, it starts off for someone who asked for less motion.
 */
export function autoPresetsOn(stored: string, reducedMotion: boolean): boolean {
  if (stored === 'on') return true
  if (stored === 'off') return false
  return !reducedMotion
}

const FAST_MS = 500
const SLOW_MS = 6000
const FLUX_MS = 350
// A long frame (a stalled tab) is counted as this at most, so one gap cannot swing the averages.
const LONGEST_STEP_MS = 100
// A kick has to jump by this much, and stand out from the recent flux, or noise would be a beat.
const FLUX_FLOOR = 0.03
const FLUX_RATIO = 1.5
// A couple of seconds of silence clears the phrase, so the next song does not inherit a count.
const QUIET_RESET_MS = 2000

export function createMomentDetector(options: MomentOptions = MOMENT_DEFAULTS) {
  let fast = 0
  let slow = 0
  let fluxAvg = 0
  let previous: number | undefined
  let lastBeat: number | undefined
  let beats = 0
  let dropArmed = true
  let dropSince: number | undefined
  let holdUntil = 0
  let quietSince: number | undefined

  const blendFor = (progress: number) => {
    if (progress < options.middleAt) return options.blendEarly
    if (progress < options.lateAt) return options.blendMiddle
    return options.blendLate
  }

  const beatsNeeded = (progress: number) => {
    if (progress < options.middleAt) return null
    if (progress < options.lateAt) return options.middleBeats
    return options.lateBeats
  }

  return {
    /**
     * Starts the phrase again, as a change made by hand does. `blendSeconds` is how long that
     * change melts, so the next one waits until this one has finished.
     */
    restart(now: number, blendSeconds = 0) {
      beats = 0
      dropSince = undefined
      dropArmed = false
      lastBeat = now
      holdUntil = now + Math.max(blendSeconds * 1000, options.minGapMs)
    },
    /**
     * Feeds one bass reading, taken at `now` in milliseconds. `progress` is 0 at the start of the
     * song and 1 at the end. `flux` is how hard the bass just rose, 0 to 1. Returns the change to
     * make, or undefined for none.
     */
    sample(level: number, now: number, progress = 0, flux = 0): Moment | undefined {
      const step =
        previous === undefined ? 16 : Math.min(Math.max(0, now - previous), LONGEST_STEP_MS)
      previous = now
      const along = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0
      fast += (level - fast) * (1 - Math.exp(-step / FAST_MS))
      slow += (level - slow) * (1 - Math.exp(-step / SLOW_MS))

      if (level < options.floor) {
        quietSince ??= now
        if (now - quietSince > QUIET_RESET_MS) beats = 0
        dropSince = undefined
        fluxAvg += (flux - fluxAvg) * (1 - Math.exp(-step / FLUX_MS))
        return undefined
      }
      quietSince = undefined

      // Compare against the average from before this spike, or the spike raises its own bar.
      const beat =
        flux > FLUX_FLOOR &&
        flux > fluxAvg * FLUX_RATIO &&
        (lastBeat === undefined || now - lastBeat >= options.minBeatMs)
      fluxAvg += (flux - fluxAvg) * (1 - Math.exp(-step / FLUX_MS))
      if (beat) {
        lastBeat = now
        beats += 1
      }

      const dropReady = dropArmed && fast - slow > options.rise
      if (dropReady) dropSince ??= now
      // Re-arm once the rise has settled, including while a melt is still finishing.
      if (fast - slow < options.rise * 0.5) dropArmed = true

      const dropDue = dropSince !== undefined && (beat || now - dropSince >= options.dropWaitMs)
      const needed = beatsNeeded(along)
      const phraseDue = beat && needed !== null && beats >= needed
      if (now < holdUntil || !(dropDue || phraseDue)) return undefined

      const scene: Scene = dropDue ? 'hard' : fast < slow * options.quiet ? 'soft' : 'pulse'
      const blend = blendFor(along)
      beats = 0
      dropSince = undefined
      if (dropDue) dropArmed = false
      holdUntil = now + Math.max(blend * 1000, options.minGapMs)
      return { scene, blend }
    },
  }
}
