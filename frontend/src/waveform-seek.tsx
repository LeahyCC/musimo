import { memo, type RefObject, useEffect, useMemo, useRef, useState } from 'react'

import { useQuery } from '@tanstack/react-query'

import { api, waveformSchema } from './api'
import { cx } from './cx'
import { barCountFor, barsPath, playedPercent, resamplePeaks, VIEW_HEIGHT } from './waveform'

/**
 * The track's peaks, or undefined while they load and whenever the server has none (a file it could
 * not decode, a wait that ran out, no ffmpeg). Any of those leaves the plain bar, which is what the
 * page had before, so none of them is worth an error on screen.
 */
function useWaveform(trackId: string): readonly number[] | undefined {
  const query = useQuery({
    queryKey: ['player-waveform', trackId],
    queryFn: ({ signal }) =>
      api(`player/waveform/${encodeURIComponent(trackId)}`, waveformSchema, { signal }),
    // The server caches until the file changes, so the browser has no reason to ask again.
    staleTime: Infinity,
    retry: false,
  })
  return query.data?.peaks
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

// One layer of bars. It only changes with the peaks and the bar's width, so the position ticking
// four times a second moves the clip around it and never redraws it.
const Bars = memo(function Bars({
  path,
  count,
  className,
}: {
  path: string
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
      <path className={className} d={path} />
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
}

/**
 * Now Playing's seek bar. The range input is the whole of the control, as it always was: the
 * keyboard, the pointer, the screen reader and the disabled state are all its own. When the track's
 * peaks arrive they are drawn behind it and the input is made invisible over them, so nothing
 * about how it is used changes. It is the same element throughout, so a focus in progress
 * survives the peaks arriving. The played part is the accent and the rest the muted token, so a
 * theme reaches it with no drawing code. The box keeps its height in both states, so the
 * controls below it do not move.
 */
export function SeekBar({ trackId, position, length, ready, onSeek }: SeekBarProps) {
  const peaks = useWaveform(trackId)
  const box = useRef<HTMLDivElement>(null)
  const width = useWidth(box)
  const bars = useMemo(
    () => (peaks ? resamplePeaks(peaks, barCountFor(width, peaks.length)) : []),
    [peaks, width],
  )
  const path = useMemo(() => barsPath(bars), [bars])
  const drawn = peaks !== undefined
  const played = playedPercent(position, length)
  return (
    <div
      ref={box}
      data-seek-bar={drawn ? 'waveform' : 'plain'}
      className={cx(
        'relative flex h-[32px] min-w-0 flex-1 items-center',
        // The invisible input cannot show its own focus ring, so the box shows it.
        drawn &&
          'has-[:disabled]:opacity-50 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-4 has-[:focus-visible]:outline-accent',
      )}
    >
      {drawn && (
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <Bars path={path} count={bars.length} className="fill-muted/60" />
          <div
            className="absolute inset-0"
            data-seek-played=""
            style={{ clipPath: `inset(0 ${100 - played}% 0 0)` }}
          >
            <Bars path={path} count={bars.length} className="fill-accent" />
          </div>
          <div
            className="absolute top-0 bottom-0 w-[2px] -translate-x-1/2 rounded-pill bg-accent"
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
            : 'w-full accent-accent'
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
