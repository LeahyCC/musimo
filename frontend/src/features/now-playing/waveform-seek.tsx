import { memo, type RefObject, useEffect, useMemo, useRef, useState } from 'react'

import { useQuery } from '@tanstack/react-query'

import { api, waveformSchema } from '../../api'
import { cx } from '../../lib/cx'
import {
  type Band,
  bandColor,
  barCountFor,
  barPath,
  barsPath,
  playedPercent,
  resampleBands,
  resamplePeaks,
  VIEW_HEIGHT,
} from './waveform'

/**
 * The track's peaks, or undefined while they load and whenever the server has none (a file it could
 * not decode, a wait that ran out, no ffmpeg). Any of those leaves the plain bar, which is what the
 * page had before, so none of them is worth an error on screen.
 */
function useWaveform(
  trackId: string,
): { peaks: readonly number[]; bands?: readonly Band[] } | undefined {
  const query = useQuery({
    queryKey: ['player-waveform', trackId],
    queryFn: ({ signal }) =>
      api(`player/waveform/${encodeURIComponent(trackId)}`, waveformSchema, { signal }),
    // The server caches until the file changes, so the browser has no reason to ask again.
    staleTime: Infinity,
    retry: false,
  })
  return query.data
}

function useWidth(box: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const element = box.current
    if (!element) return undefined
    // Observing reports the first size too, so there is nothing to read up front.
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [box])

  return width
}

/** The bars that mix to one colour, drawn as one path. */
type ColoredBar = { d: string; fill: string }

// One layer of bars. It only changes with the peaks and the bar's width, so the position ticking
// four times a second moves the clip around it and never redraws it. With bands there is one path
// per colour the bars mix to, and the unplayed layer is the same colours faded.
const Bars = memo(function Bars({
  path,
  colored,
  count,
  className,
}: {
  path: string
  colored: readonly ColoredBar[] | undefined
  count: number
  className: string
}) {
  return (
    <svg
      className="absolute inset-0 h-full w-full"
      viewBox={`0 0 ${count} ${VIEW_HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      {colored ? (
        <g className={className} data-seek-colored="">
          {colored.map((group) => (
            <path key={group.fill} d={group.d} style={{ fill: group.fill }} />
          ))}
        </g>
      ) : (
        <path className={className} d={path} />
      )}
    </svg>
  )
})

type SeekBarProps = {
  trackId: string
  /** Seconds played, and the track's length, the way the range below them counts. */
  position: number
  length: number
  ready: boolean
  onSeek: (seconds: number) => void
  /** Classic plays in the accent over the strong line color; the Listening room in the text color
      over a faint copy of it, as its card is tinted by the cover. */
  tone?: 'classic' | 'room'
  /** The box's height, which the bars fill. */
  className?: string
}

const TONES = {
  classic: {
    rest: 'fill-line-strong',
    played: 'fill-accent',
    head: 'bg-accent',
    plain: 'accent-accent',
  },
  room: { rest: 'fill-text/22', played: 'fill-text', head: 'bg-text', plain: 'accent-text' },
} as const

/** Coloured bars keep their colour in both layers; what is still to play is faded. */
const COLORED_LAYERS = { rest: 'opacity-45', played: '' } as const

/**
 * Now Playing's seek bar. The range input is the whole of the control, as it always was: the
 * keyboard, the pointer, the screen reader and the disabled state are all its own. When the track's
 * peaks arrive they are drawn behind it and the input is made invisible over them, so nothing
 * about how it is used changes. It is the same element throughout, so a focus in progress
 * survives the peaks arriving. The played and unplayed parts are theme tokens (see `TONES`), so a
 * theme reaches it with no drawing code. The box keeps its height in both states, so the
 * controls below it do not move.
 */
export function SeekBar({
  trackId,
  position,
  length,
  ready,
  onSeek,
  tone = 'classic',
  className = 'h-[36px]',
}: SeekBarProps) {
  const colors = TONES[tone]
  const waveform = useWaveform(trackId)
  const box = useRef<HTMLDivElement>(null)
  const width = useWidth(box)
  const count = waveform ? barCountFor(width, waveform.peaks.length) : 0
  const bars = useMemo(
    () => (waveform ? resamplePeaks(waveform.peaks, count) : []),
    [waveform, count],
  )
  const path = useMemo(() => barsPath(bars), [bars])
  const colored = useMemo(() => {
    if (!waveform?.bands) return undefined
    const bands = resampleBands(waveform.bands, count)
    // `bandColor` steps in 5%, so bars that share a colour share a path: a few dozen paths for
    // the layer rather than one for every bar.
    const groups = new Map<string, string>()
    bars.forEach((bar, index) => {
      const fill = bandColor(bands[index] ?? [0, 0, 0])
      groups.set(fill, (groups.get(fill) ?? '') + barPath(bar, index))
    })

    return [...groups].map(([fill, d]) => ({ fill, d }))
  }, [waveform, count, bars])
  const layers = colored ? COLORED_LAYERS : colors
  const drawn = waveform !== undefined
  const played = playedPercent(position, length)
  return (
    <div
      ref={box}
      data-seek-bar={drawn ? 'waveform' : 'plain'}
      className={cx(
        'relative flex min-w-0 flex-1 items-center',
        className,
        // The invisible input cannot show its own focus ring, so the box shows it.
        drawn &&
          'has-[:disabled]:opacity-50 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-4 has-[:focus-visible]:outline-accent',
      )}
    >
      {drawn && (
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <Bars path={path} colored={colored} count={bars.length} className={layers.rest} />
          <div
            className="absolute inset-0"
            data-seek-played=""
            style={{ clipPath: `inset(0 ${100 - played}% 0 0)` }}
          >
            <Bars path={path} colored={colored} count={bars.length} className={layers.played} />
          </div>
          <div
            className={cx(
              'absolute top-0 bottom-0 w-[2px] -translate-x-1/2 rounded-pill',
              colors.head,
            )}
            style={{ left: `${played}%` }}
          />
        </div>
      )}
      {/* A thumb with no width makes the input's travel the whole box, so a click lands where the
          playhead is drawn and not half a thumb off it at either end. */}
      <input
        className={
          drawn
            ? 'absolute inset-0 h-full w-full cursor-pointer opacity-0 [&::-moz-range-thumb]:h-0 [&::-moz-range-thumb]:w-0 [&::-moz-range-thumb]:border-0 [&::-webkit-slider-thumb]:h-0 [&::-webkit-slider-thumb]:w-0 [&::-webkit-slider-thumb]:appearance-none'
            : cx('w-full', colors.plain)
        }
        aria-label="Playback position"
        type="range"
        min="0"
        max={length}
        step="0.1"
        value={Math.min(position, length)}
        disabled={!ready}
        onChange={(event) => onSeek(Number(event.target.value))}
      />
    </div>
  )
}
