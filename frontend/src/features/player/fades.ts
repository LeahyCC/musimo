const clamp01 = (value: number) => (Number.isNaN(value) ? 0 : Math.max(0, Math.min(1, value)))

/**
 * A straight ramp to silence: 1 while `over` seconds or more are left, 0 when none are. An unknown
 * time left (Infinity, a stream that has no length yet) is not a fade, so it stays at 1.
 */
export const rampDown = (secondsLeft: number, over: number): number => {
  if (secondsLeft === Infinity) return 1
  if (over <= 0) return secondsLeft > 0 ? 1 : 0
  return clamp01(secondsLeft / over)
}

/*
 * The pair for a crossfade. Two tracks are unrelated sounds, so their powers add: cos and sin
 * squared sum to 1 all the way through, and the join holds one steady loudness. A straight
 * fade of each would dip in the middle.
 */
/** The outgoing track's level `progress` (0 to 1) of the way through the overlap. */
export const fadeOutGain = (progress: number): number => Math.cos(clamp01(progress) * (Math.PI / 2))
/** The incoming track's level at the same point. */
export const fadeInGain = (progress: number): number => Math.sin(clamp01(progress) * (Math.PI / 2))
