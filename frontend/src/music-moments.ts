// Decides when the visualizer moves to a new preset by itself, from how loud the bass is.
//
//   bass level ──► fast average (≈0.5 s)
//              └─► slow average (≈6 s)
//
// A drop after a quieter stretch pushes the fast average well above the slow one, and that is a
// moment worth a new picture. The analyser reports the bass on a decibel scale squeezed into 0 to 1,
// where real music sits between about 0.5 and 0.95, so the test is how far the fast average rises
// above the slow one, not how many times louder it is. Steady music never makes one, so after a long wait the preset moves
// on anyway. Neither happens sooner than `minGapMs` after the last change, so it never flickers.

export type Moment = 'drop' | 'drift'

export type MomentOptions = {
  /** No change sooner than this after the last one, whatever the music does. */
  minGapMs: number
  /** Steady music moves on after this long without a drop. */
  maxGapMs: number
  /** How far, on the 0 to 1 scale, the fast average must rise above the slow one for a drop. */
  rise: number
  /** Below this the music is too quiet to count, so silence never triggers anything. */
  floor: number
}

export const MOMENT_DEFAULTS: MomentOptions = {
  minGapMs: 20_000,
  maxGapMs: 90_000,
  // Tuned on a real track: 0.12 caught its two drops and nothing else; 0.1 also caught a small
  // lift, and 0.15 missed the second drop.
  rise: 0.12,
  floor: 0.08,
}

const FAST_MS = 500
const SLOW_MS = 6000
// A long frame (a stalled tab) is counted as this at most, so one gap cannot swing the averages.
const LONGEST_STEP_MS = 100

export function createMomentDetector(options: MomentOptions = MOMENT_DEFAULTS) {
  let fast = 0
  let slow = 0
  let previous: number | undefined
  let last: number | undefined

  return {
    /** Starts the gap again, as a change made by hand does. */
    restart(now: number) {
      last = now
    },
    /**
     * Feeds one bass level, 0 to 1, taken at `now` in milliseconds. Returns the kind of moment
     * this is, or undefined for none.
     */
    sample(level: number, now: number): Moment | undefined {
      const step = previous === undefined ? 16 : Math.min(now - previous, LONGEST_STEP_MS)
      previous = now
      last ??= now
      fast += (level - fast) * (1 - Math.exp(-step / FAST_MS))
      slow += (level - slow) * (1 - Math.exp(-step / SLOW_MS))
      const since = now - last
      if (since < options.minGapMs || fast < options.floor) return undefined
      if (fast - slow > options.rise) {
        last = now
        return 'drop'
      }

      if (since >= options.maxGapMs) {
        last = now
        return 'drift'
      }
      return undefined
    },
  }
}
