import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'

import { createPortal } from 'react-dom'

import { useQuery } from '@tanstack/react-query'
import { Maximize2, Pause, Play, SkipBack, SkipForward, X } from 'lucide-react'
import type { z } from 'zod'

import { api, lyricsSchema } from './api'
import type { LibraryTrack } from './api'
import { cx } from './cx'
import { pageKeyIsFree } from './now-playing-shortcuts'
import { artUrl, durationText, remember, stored, usePlayer } from './player'
import { Button, IconButton } from './ui'
import { SeekBar } from './waveform-seek'

type LyricLine = z.infer<typeof lyricsSchema>['items'][number]['line'][number]

export const OFFSET_KEY = 'musimo.lyrics-offset'
export const OFFSET_LIMIT = 200
export const OFFSET_STEP = 0.5
// How long a hand scroll keeps the list where the person left it.
const HOLD_MS = 4000
// The player reports its clock a few times a second, so a line that starts a hair after a seek
// target still counts as reached.
const SEEK_SLACK = 0.05
const scrollKeys = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'])

/** Saved timing nudges, track id to seconds. Anything unreadable is treated as nothing saved. */
export function parseOffsets(raw: string): Map<string, number> {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return new Map()
    return new Map(
      Object.entries(value).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === 'number' && Number.isFinite(entry[1]),
      ),
    )
  } catch {
    return new Map()
  }
}

/**
 * The map with one track's nudge set. The newest write goes last and the oldest entries drop
 * first once the map passes `limit`; zero is the default, so it is not stored at all.
 */
export function withOffset(
  saved: ReadonlyMap<string, number>,
  id: string,
  seconds: number,
  limit = OFFSET_LIMIT,
): Map<string, number> {
  const next = new Map(saved)
  next.delete(id)
  if (seconds !== 0) next.set(id, seconds)
  for (const key of next.keys()) {
    if (next.size <= limit) break
    next.delete(key)
  }
  return next
}

/** The last line that has started by `seconds`, or -1 before the first. Lines without a time are skipped. */
export function currentLineIndex(starts: readonly (number | undefined)[], seconds: number): number {
  let found = -1
  starts.forEach((start, index) => {
    if (start !== undefined && start <= seconds) found = index
  })

  return found
}

export function formatOffset(seconds: number) {
  const sign = seconds > 0 ? '+' : seconds < 0 ? '-' : ''
  return `${sign}${Math.abs(seconds).toFixed(1)} s`
}

const savedOffset = (id: string) => parseOffsets(stored(OFFSET_KEY, '')).get(id) ?? 0
const saveOffset = (id: string, seconds: number) => {
  const saved = withOffset(parseOffsets(stored(OFFSET_KEY, '')), id, seconds)
  remember(OFFSET_KEY, JSON.stringify(Object.fromEntries(saved)))
}

// The nudge for one track, kept in the browser so it survives a reload. The panel is keyed by
// track, so the starting value is read once per track.
function useOffset(id: string) {
  const [offset, setOffset] = useState(() => savedOffset(id))
  const change = (seconds: number) => {
    setOffset(seconds)
    saveOffset(id, seconds)
  }
  return [offset, change] as const
}

const scrollBehavior = (): ScrollBehavior =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'

// The same lines are drawn in two places: the tab beside the stage, and the view that takes over
// the page's content area (`LyricsView`), where they are large, centred and in a wide column.
type Variant = 'panel' | 'view'

const regionClassName = (variant: Variant) =>
  variant === 'view'
    ? 'relative mx-auto min-h-0 w-full max-w-[1200px] flex-1 overflow-auto overscroll-contain'
    : 'relative min-h-0 flex-1 overflow-auto overscroll-contain max-phone:max-h-[60dvh] max-phone:flex-none'
const lineSizeClassName = (variant: Variant) =>
  variant === 'view'
    ? 'text-center text-[clamp(1.75rem,3.2vw,3rem)] leading-tight'
    : 'text-left text-section'

type LineProps = {
  text: string
  /** Where the line starts in the track, in seconds, nudge included. */
  time: number | undefined
  active: boolean
  variant: Variant
  onSeek: (seconds: number) => void
}

// Memoised so a tick that keeps the current line redraws nothing but the list around it.
const SyncedLine = memo(function SyncedLine({ text, time, active, variant, onSeek }: LineProps) {
  if (time === undefined)
    return (
      <p className={cx('px-[8px] py-[6px] text-muted', lineSizeClassName(variant))}>
        {text || '♪'}
      </p>
    )
  const at = Math.max(0, time)
  return (
    <button
      type="button"
      aria-current={active ? 'true' : undefined}
      aria-label={text ? undefined : `Instrumental break at ${durationText(at)}`}
      className={cx(
        'block w-full rounded-md border-0 bg-transparent px-[8px] py-[6px] transition-colors motion-reduce:transition-none',
        lineSizeClassName(variant),
        active ? 'font-semibold text-text' : 'text-muted hover:text-text',
      )}
      onClick={() => onSeek(at)}
    >
      {text || '♪'}
    </button>
  )
})

// Puts keyboard focus in the lines box when it mounts, for the view, so the arrow keys scroll it.
function useFocusOnMount(box: { current: HTMLElement | null }, focus: boolean) {
  useEffect(() => {
    if (focus) box.current?.focus({ preventScroll: true })
  }, [box, focus])
}

/**
 * The timed lines. This is the one part of the tab that follows the player's clock, so it is
 * separate from the panel around it: a tick redraws this list's cheap wrapper and, at most, the
 * two lines whose highlight changed.
 */
function SyncedLines({
  lines,
  offset,
  visible,
  variant,
  focus = false,
}: {
  lines: readonly LyricLine[]
  offset: number
  visible: boolean
  variant: Variant
  /** Take keyboard focus on mount. */
  focus?: boolean
}) {
  const player = usePlayer()
  const region = useRef<HTMLDivElement>(null)
  useFocusOnMount(region, focus)
  const holding = useRef<number | undefined>(undefined)
  const placed = useRef(false)
  const seekRef = useRef(player.seek)
  seekRef.current = player.seek
  const seekTo = useCallback((seconds: number) => seekRef.current(seconds), [])

  const starts = useMemo(
    () => lines.map((line) => (line.start === undefined ? undefined : line.start / 1000 + offset)),
    [lines, offset],
  )
  const active = currentLineIndex(starts, player.position + SEEK_SLACK)

  // Puts the current line about a third of the way down the box, where the next few lines are
  // still in view.
  const scrollToActive = useCallback((behavior: ScrollBehavior) => {
    const box = region.current
    const line = box?.querySelector<HTMLElement>('[aria-current="true"]')
    // A hidden tab has no height to measure.
    if (!box || !line || box.clientHeight === 0) return
    const top =
      line.getBoundingClientRect().top -
      box.getBoundingClientRect().top +
      box.scrollTop -
      box.clientHeight / 3
    box.scrollTo({ top: Math.max(0, top), behavior })
  }, [])

  // A scroll event cannot tell a hand from our own scrollTo, so the hand is caught at its source:
  // the wheel, a touch, the scrollbar and the keys that scroll.
  const hold = useCallback(() => {
    window.clearTimeout(holding.current)
    holding.current = window.setTimeout(() => {
      holding.current = undefined
      scrollToActive(scrollBehavior())
    }, HOLD_MS)
  }, [scrollToActive])
  const release = useCallback(() => {
    window.clearTimeout(holding.current)
    holding.current = undefined
  }, [])
  useEffect(() => release, [release])

  useEffect(() => {
    if (!visible || holding.current !== undefined) return
    // The first placement is a jump, so opening the tab does not scroll the list past the eye.
    scrollToActive(placed.current ? scrollBehavior() : 'auto')
    placed.current = true
  }, [active, visible, scrollToActive])

  const seek = useCallback(
    (seconds: number) => {
      // Asking for a line is not a scroll, and the list should follow it straight away.
      release()
      seekTo(seconds)
    },
    [release, seekTo],
  )

  return (
    <div
      ref={region}
      role="region"
      aria-label="Lyrics"
      tabIndex={0}
      className={regionClassName(variant)}
      onWheel={hold}
      onTouchMove={hold}
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        // Only the scrollbar is the box itself; a line is a button inside it.
        if (event.target === event.currentTarget) hold()
      }}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (
          scrollKeys.has(event.key) ||
          (event.key === ' ' && event.target === event.currentTarget)
        )
          hold()
      }}
    >
      {lines.map((line, index) => (
        <SyncedLine
          // Lines repeat (a chorus), and the list never reorders, so the position is the identity.
          key={index}
          text={line.value}
          time={starts[index]}
          active={index === active}
          variant={variant}
          onSeek={seek}
        />
      ))}
      {/* Room below the last line, so it can reach the same spot the others do. */}
      <div aria-hidden="true" className="h-[50dvh]" />
    </div>
  )
}

function PlainLines({
  lines,
  variant,
  focus = false,
}: {
  lines: readonly LyricLine[]
  variant: Variant
  focus?: boolean
}) {
  const region = useRef<HTMLDivElement>(null)
  useFocusOnMount(region, focus)
  return (
    <div
      ref={region}
      role="region"
      aria-label="Lyrics"
      tabIndex={0}
      className={regionClassName(variant)}
    >
      {lines.map((line, index) => (
        <p key={index} className={cx('px-[8px] py-[6px] text-text', lineSizeClassName(variant))}>
          {line.value || '♪'}
        </p>
      ))}
    </div>
  )
}

function Timing({ offset, onChange }: { offset: number; onChange: (seconds: number) => void }) {
  return (
    <div role="group" aria-label="Lyrics timing" className="flex items-center gap-[6px]">
      <Button
        className="min-h-[32px] px-[10px] py-[4px]"
        onClick={() => onChange(offset - OFFSET_STEP)}
      >
        Earlier {OFFSET_STEP} s
      </Button>
      <span className="min-w-[5ch] text-center text-small text-muted">
        <span className="sr-only">Timing </span>
        <output>{formatOffset(offset)}</output>
      </span>
      <Button
        className="min-h-[32px] px-[10px] py-[4px]"
        onClick={() => onChange(offset + OFFSET_STEP)}
      >
        Later {OFFSET_STEP} s
      </Button>
    </div>
  )
}

// Previous, play or pause and next. It reads the player for `playing` and so redraws on a tick,
// but it is three buttons.
function StripTransport() {
  const player = usePlayer()
  return (
    <div className="flex items-center gap-[4px]">
      <IconButton size="compact" aria-label="Previous track" onClick={player.previous}>
        <SkipBack size={17} />
      </IconButton>
      <IconButton
        variant="play"
        aria-label={player.playing ? 'Pause' : 'Play'}
        onClick={player.toggle}
      >
        {player.playing ? <Pause size={19} /> : <Play size={19} />}
      </IconButton>
      <IconButton size="compact" aria-label="Next track" onClick={player.next}>
        <SkipForward size={17} />
      </IconButton>
    </div>
  )
}

// The seek bar and the two times: the strip's other reader of the player's position.
function StripSeek({ trackId }: { trackId: string }) {
  const player = usePlayer()
  return (
    <div className="flex min-w-0 items-center gap-[10px] text-tiny text-muted tabular-nums max-phone:order-last max-phone:col-span-4">
      <span>{durationText(player.position)}</span>
      <SeekBar
        trackId={trackId}
        position={player.position}
        length={player.length || 30}
        ready={player.ready}
        onSeek={player.seek}
      />
      <span>{durationText(player.length)}</span>
    </div>
  )
}

type LyricsViewProps = {
  track: LibraryTrack
  lines: readonly LyricLine[]
  synced: boolean
  offset: number
  onOffset: (seconds: number) => void
  onClose: () => void
}

/**
 * The lyrics view: the page's content area handed over to the lines, large and centred in a wide
 * column, with a strip along the bottom for the track and its transport. It is drawn in the body,
 * fixed over the content area (under the top bar, beside the sidebar, above the phone's bottom
 * bar), so the wash the page keeps behind it shows through. The page hides what is underneath,
 * which takes it out of the tab order too. Nothing here reads the player except the lines and the two strip pieces above, so a
 * tick redraws those and not the view.
 */
function LyricsView({ track, lines, synced, offset, onOffset, onClose }: LyricsViewProps) {
  // Escape leaves, unless it is closing a dialog (the shortcuts sheet) or leaving a field. L is the
  // tabs' own key and toggles the same state.
  useEffect(() => {
    const onKey = (event: WindowEventMap['keydown']) => {
      if (event.key !== 'Escape' || event.repeat || !pageKeyIsFree(event)) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const art = artUrl(track)
  return createPortal(
    <div
      data-lyrics-view=""
      role="dialog"
      aria-label="Lyrics view"
      className="fixed top-[calc(var(--topbar-height)+var(--safe-top))] right-0 bottom-0 left-[calc(var(--sidebar-width)+var(--safe-left))] z-overlay flex flex-col gap-[12px] pt-[16px] pr-[calc(24px+var(--safe-right))] pb-[16px] pl-[24px] max-phone:bottom-[calc(var(--nav-height)+var(--safe-bottom))] max-phone:left-0 max-phone:gap-[8px] max-phone:pt-[8px] max-phone:pr-[calc(16px+var(--safe-right))] max-phone:pb-[8px] max-phone:pl-[calc(16px+var(--safe-left))]"
    >
      <div className="mx-auto flex w-full max-w-[1200px] shrink-0 items-center justify-center">
        {synced ? (
          <Timing offset={offset} onChange={onOffset} />
        ) : (
          <small className="text-small text-muted">Not timed</small>
        )}
      </div>
      {synced ? (
        <SyncedLines lines={lines} offset={offset} visible variant="view" focus />
      ) : (
        <PlainLines lines={lines} variant="view" focus />
      )}
      <div className="mx-auto grid w-full max-w-[1200px] shrink-0 grid-cols-[auto_minmax(0,16rem)_auto_minmax(0,1fr)_auto] items-center gap-x-[14px] gap-y-[8px] rounded-lg border border-line bg-raised px-[14px] py-[10px] max-phone:grid-cols-[auto_minmax(0,1fr)_auto_auto]">
        {art ? (
          <img src={art} alt="" className="size-[44px] rounded-md object-cover" />
        ) : (
          <div aria-hidden="true" className="size-[44px] rounded-md bg-canvas" />
        )}
        <div className="min-w-0">
          <strong className="block truncate" title={track.title}>
            {track.title}
          </strong>
          <small className="block truncate text-small text-muted">{track.artist}</small>
        </div>
        <StripTransport />
        <StripSeek trackId={track.id} />
        <IconButton size="compact" aria-label="Close lyrics view" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </div>
    </div>,
    document.body,
  )
}

type LyricsPanelProps = {
  track: LibraryTrack
  /** False while the other tab is showing, when the list has no height to scroll. */
  visible: boolean
  /** Whether the lyrics view is open. The page owns it, since it hides the page under the view. */
  large: boolean
  onToggleLarge: () => void
}

/**
 * The Lyrics tab: the lines, the timing nudge and the button that opens the lyrics view, which this
 * draws too while `large` is on (it owns the lines and the nudge, and the view needs both). Give it
 * `key={track.id}`.
 */
export const LyricsPanel = memo(function LyricsPanel({
  track,
  visible,
  large,
  onToggleLarge,
}: LyricsPanelProps) {
  const lyrics = useQuery({
    queryKey: ['lyrics', track.id],
    queryFn: ({ signal }) =>
      api(`player/lyrics/${encodeURIComponent(track.id)}`, lyricsSchema, { signal }),
    retry: false,
  })
  const [offset, setOffset] = useOffset(track.id)
  const item = lyrics.data?.items[0]
  const lines = useMemo(() => item?.line ?? [], [item])
  // A list flagged as synced with no times in it has nothing to follow.
  const synced = item?.synced === true && lines.some((line) => line.start !== undefined)

  // Leaving the view puts focus back on the button that opens it, wherever the leaving came from
  // (the close button, Escape or L).
  const largeButton = useRef<HTMLButtonElement>(null)
  const wasLarge = useRef(large)
  useEffect(() => {
    if (wasLarge.current && !large) largeButton.current?.focus()
    wasLarge.current = large
  }, [large])

  if (lyrics.isLoading) return <p className="py-[8px] text-section text-text">Loading lyrics…</p>
  if (!lines.length)
    return (
      <div className="flex flex-col items-start gap-[12px]">
        <p role="status" className="py-[8px] text-section text-text">
          {lyrics.isFetching
            ? 'Searching for lyrics…'
            : lyrics.isError
              ? 'Lyrics could not be loaded.'
              : 'No lyrics found for this track.'}
        </p>
        <Button onClick={() => void lyrics.refetch()} disabled={lyrics.isFetching}>
          Search again
        </Button>
      </div>
    )

  // The view has the lines while it is open, so the tab draws none of its own: two lists would
  // both follow the clock.
  if (large && visible)
    return (
      <LyricsView
        track={track}
        lines={lines}
        synced={synced}
        offset={offset}
        onOffset={setOffset}
        onClose={onToggleLarge}
      />
    )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-[10px] flex shrink-0 flex-wrap items-center justify-between gap-x-[12px] gap-y-[6px]">
        {synced ? (
          <Timing offset={offset} onChange={setOffset} />
        ) : (
          <small className="text-small text-muted">Not timed</small>
        )}
        <IconButton
          ref={largeButton}
          aria-label="Large type"
          title="Large type (L)"
          onClick={onToggleLarge}
        >
          <Maximize2 size={17} />
        </IconButton>
      </div>
      {synced ? (
        <SyncedLines lines={lines} offset={offset} visible={visible} variant="panel" />
      ) : (
        <PlainLines lines={lines} variant="panel" />
      )}
    </div>
  )
})
