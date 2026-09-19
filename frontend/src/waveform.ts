/** One bar every this many pixels of seek bar, a bar and the gap after it. */
export const BAR_PITCH = 4
export const MIN_BARS = 24
/** Used until the bar has been measured. */
export const DEFAULT_BARS = 150
/** The share of a bar's slot that is drawn; the rest is the gap. */
export const BAR_FILL = 0.6
/** A silent stretch still draws a sliver, so the bar reads as one line rather than a gap. */
export const MIN_BAR_HEIGHT = 6
/** The drawing is 100 units tall and as many units wide as it has bars. */
export const VIEW_HEIGHT = 100

/** How many bars fit in `width` pixels, and never more than the server sent peaks for. */
export function barCountFor(width: number, available: number): number {
  const fitted = width > 0 ? Math.max(MIN_BARS, Math.round(width / BAR_PITCH)) : DEFAULT_BARS
  return Math.max(1, Math.min(fitted, available))
}

/** Folds `peaks` down to `count` bars, each the loudest of the peaks it covers. */
export function resamplePeaks(peaks: readonly number[], count: number): number[] {
  const bars = Math.max(1, Math.min(Math.floor(count), peaks.length))
  const folded: number[] = []
  for (let bar = 0; bar < bars; bar += 1) {
    const from = Math.floor((bar * peaks.length) / bars)
    const to = Math.max(from + 1, Math.floor(((bar + 1) * peaks.length) / bars))
    let loudest = 0
    for (let index = from; index < to; index += 1) loudest = Math.max(loudest, peaks[index] ?? 0)
    folded.push(loudest)
  }
  return folded
}

const round = (value: number) => Number(value.toFixed(2))

/**
 * One SVG path drawing every bar as a rectangle centred on the middle of the box. Bar `n` sits in
 * the slot from `n` to `n + 1` along the width, so a viewBox `bars.length` wide by `VIEW_HEIGHT`
 * tall, stretched to the box, gives bars that stay the same width whatever the box's.
 */
export function barsPath(bars: readonly number[]): string {
  const margin = (1 - BAR_FILL) / 2
  return bars
    .map((bar, index) => {
      const height = Math.max(MIN_BAR_HEIGHT, Math.min(1, Math.max(0, bar)) * VIEW_HEIGHT)
      const top = (VIEW_HEIGHT - height) / 2
      return `M${round(index + margin)} ${round(top)}h${BAR_FILL}v${round(height)}h-${BAR_FILL}z`
    })
    .join('')
}

/** How far along the track the playhead is, 0 to 100. */
export function playedPercent(position: number, length: number): number {
  if (!(length > 0) || !(position > 0)) return 0
  return Math.min(100, (position / length) * 100)
}
