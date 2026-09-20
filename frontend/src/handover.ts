// The next track starts this long before the current one ends: about what a buffered element
// takes to put sound out. Later leaves a gap, earlier an overlap.
export const HANDOVER_LEAD_MS = 40
// Inside this window the handover is timed. Outside it the `ended` event does it, which is the safe
// route and a few milliseconds slower.
export const HANDOVER_WINDOW_SECONDS = 1
// A stream's own length can differ from the library's. Past this the timed handover would cut a
// track short, so `ended` decides instead.
export const LENGTH_TOLERANCE_SECONDS = 2

/**
 * Milliseconds of real time until the standby element should start, or null while the playing track
 * is still more than `HANDOVER_WINDOW_SECONDS` from its end. `left` is media seconds, which pass
 * faster or slower than the clock at a playback rate other than 1.
 */
export function handoverDelay(left: number, rate: number): number | null {
  if (!Number.isFinite(left) || left > HANDOVER_WINDOW_SECONDS) return null
  if (!Number.isFinite(rate) || rate <= 0) return null
  return Math.max(0, (left / rate) * 1000 - HANDOVER_LEAD_MS)
}

/** Whether the stream is as long as the library says, so a timed handover cannot cut it short. */
export const lengthsAgree = (stream: number, library: number) =>
  !(library > 0 && Math.abs(stream - library) > LENGTH_TOLERANCE_SECONDS)
