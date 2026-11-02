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

/** Folds `peaks` down to `count` bars, each the average of the points it covers. The loudest
 * would hide a breakdown behind the loud seconds either side of it. */
export function resamplePeaks(peaks: readonly number[], count: number): number[] {
  const bars = Math.max(1, Math.min(Math.floor(count), peaks.length))
  const folded: number[] = []
  for (let bar = 0; bar < bars; bar += 1) {
    const from = Math.floor((bar * peaks.length) / bars)
    const to = Math.max(from + 1, Math.floor(((bar + 1) * peaks.length) / bars))
    let total = 0
    for (let index = from; index < to; index += 1) total += peaks[index] ?? 0
    folded.push(total / (to - from))
  }
  return folded
}

export type Band = readonly [bass: number, mids: number, highs: number]

/** Folds `bands` down to `count` bars the same way `resamplePeaks` folds the peaks. */
export function resampleBands(bands: readonly Band[], count: number): Band[] {
  const [bass, mids, highs] = [0, 1, 2].map((band) =>
    resamplePeaks(
      bands.map((point) => point[band] ?? 0),
      count,
    ),
  )
  return (bass ?? []).map((value, index) => [value, mids?.[index] ?? 0, highs?.[index] ?? 0])
}

/** How hard the mix leans to the band that leads. Bands a tenth above the others still read. */
export const BAND_CONTRAST = 6

// Shares go in steps of 5%, too fine to see, so neighbouring bars land on the same colour and the
// seek bar can draw each colour as one path.
const percent = (share: number) => `${Math.round(share * 20) * 5}%`

/**
 * A bar's colour, the three band tokens mixed by how much of each band the bar has. The server
 * sends each band against its own average over the song, since most songs keep all three busy and
 * raw levels mix to grey, so the band above its usual level leads. The shares
 * are raised to `BAND_CONTRAST` first, so the band that leads is the one you see: a drop goes the
 * bass colour, a breakdown with only hats left the highs colour, and a bar where all three are
 * level an even mix. It is a CSS value over theme tokens, so a theme recolours it, and it goes in
 * `style`, since an SVG presentation attribute cannot read a custom property.
 */
export function bandColor(band: Band): string {
  const [bass = 0, mids = 0, highs = 0] = band.map((value) => Math.max(0, value) ** BAND_CONTRAST)
  const total = bass + mids + highs
  if (!total) return 'var(--color-faint)'
  const low = bass + mids
  const lowMix = low
    ? `color-mix(in oklab, var(--color-wave-bass) ${percent(bass / low)}, var(--color-wave-mids))`
    : 'var(--color-wave-mids)'
  return `color-mix(in oklab, ${lowMix} ${percent(low / total)}, var(--color-wave-highs))`
}

const round = (value: number) => Number(value.toFixed(2))

/**
 * One SVG path drawing every bar as a rectangle centred on the middle of the box. Bar `n` sits in
 * the slot from `n` to `n + 1` along the width, so a viewBox `bars.length` wide by `VIEW_HEIGHT`
 * tall, stretched to the box, gives bars that stay the same width whatever the box's.
 */
export function barsPath(bars: readonly number[]): string {
  return bars.map(barPath).join('')
}

/** One bar of `barsPath`, for drawing each bar in its own colour. */
export function barPath(bar: number, index: number): string {
  const margin = (1 - BAR_FILL) / 2
  const height = Math.max(MIN_BAR_HEIGHT, Math.min(1, Math.max(0, bar)) * VIEW_HEIGHT)
  const top = (VIEW_HEIGHT - height) / 2
  return `M${round(index + margin)} ${round(top)}h${BAR_FILL}v${round(height)}h-${BAR_FILL}z`
}

/** How far along the track the playhead is, 0 to 100. */
export function playedPercent(position: number, length: number): number {
  if (!(length > 0) || !(position > 0)) return 0
  return Math.min(100, (position / length) * 100)
}
