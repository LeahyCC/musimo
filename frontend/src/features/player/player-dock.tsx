import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, PointerEvent as ReactPointerEvent } from 'react'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  ChevronDown,
  ChevronUp,
  CloudOff,
  Disc3,
  ListMusic,
  ListPlus,
  Maximize2,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  Save,
  Shuffle,
  SkipBack,
  SkipForward,
  ThumbsUp,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'

import { api, libraryPlaylistDetailSchema } from '../../api'
import { cx } from '../../lib/cx'
import { Button, ErrorBanner, Field, IconButton, iconButtonClassName, useToast } from '../../ui'
import { PetSpot } from '../music-bot/pet-host'
import { SleepTimerControl } from '../now-playing/sleep-timer-control'
import { SeekBar } from '../now-playing/waveform-seek'
import {
  artUrl,
  durationText,
  isPassiveNotice,
  QUEUE_REPLACED,
  QUEUE_SAVE_FAILED,
  queueEntryKey,
  songCount,
  usePlayer,
} from './player'

/* The Listening room's player. A wide window gets the dock: a column beside the page with the
   cover, the transport and Up next. Under the tablet edge the same parts lie down as a bar under
   the page, with Up next in a panel that opens above it. A phone gets the floating mini player.
   All three drive the one player in `player.tsx`, whose own footer stays hidden in this layout. */

const monoCaptionClassName = 'font-mono text-tiny tracking-[0.6px] text-faint'
/** The light disc the room draws its play button on: the text color, so a light theme inverts it. */
const playDiscClassName =
  'grid shrink-0 place-items-center rounded-pill border-0 bg-text p-0 text-canvas disabled:opacity-50'

/** What the player has loaded, library track or catalog preview, in the words the dock shows. */
function useNowPlaying() {
  const player = usePlayer()
  const { libraryTrack, track } = player
  return {
    player,
    isLibrary: Boolean(libraryTrack),
    title: libraryTrack?.title ?? track?.title,
    artist: libraryTrack?.artist ?? track?.artist,
    album: libraryTrack?.album ?? track?.album,
    art: libraryTrack ? artUrl(libraryTrack) : track?.art,
  }
}

function Cover({ art, className }: { art?: string; className: string }) {
  return art ? (
    <img className={cx('object-cover', className)} src={art} alt="" />
  ) : (
    <span className={cx('grid place-items-center bg-raised text-faint', className)}>
      <Disc3 size={28} />
    </span>
  )
}

/** The title and "artist — album" lines, each a link where the player knows where it goes. */
function TrackLines({ titleClassName }: { titleClassName: string }) {
  const { player, isLibrary, title, artist, album } = useNowPlaying()
  const { libraryTrack, track } = player
  const artistLink = libraryTrack?.artistId ? (
    <Link to="/library/artists/$artistId" params={{ artistId: libraryTrack.artistId }}>
      {artist}
    </Link>
  ) : track?.artist_id ? (
    <Link to="/artists/$artistId" params={{ artistId: String(track.artist_id) }}>
      {artist}
    </Link>
  ) : (
    artist
  )
  const albumLink = libraryTrack?.albumId ? (
    <Link to="/library/albums/$albumId" params={{ albumId: libraryTrack.albumId }}>
      {album}
    </Link>
  ) : track?.album_id ? (
    <Link to="/albums/$albumId" params={{ albumId: String(track.album_id) }}>
      {album}
    </Link>
  ) : (
    album
  )
  return (
    <div className="min-w-0 flex-1 [&_a:hover]:underline">
      <div className={cx('truncate font-semibold', titleClassName)}>
        {isLibrary ? <Link to="/now-playing">{title}</Link> : (title ?? 'Nothing playing')}
      </div>
      {artist && (
        <div className="mt-[3px] truncate text-small text-muted">
          {artistLink}
          {album && <> — {albumLink}</>}
        </div>
      )}
    </div>
  )
}

/** The player's own status line, for what is neither routine nor a queue save (Up next has those). */
function Notice({ className }: { className?: string }) {
  const { notice } = usePlayer()
  const quiet = isPassiveNotice(notice) || notice === QUEUE_SAVE_FAILED || notice === QUEUE_REPLACED
  return (
    <p className={cx('truncate text-tiny text-muted', quiet && 'sr-only', className)} role="status">
      {notice}
    </p>
  )
}

function LikeButton() {
  const { player, title } = useNowPlaying()
  const { liked } = player
  if (!player.libraryTrack) return null
  return (
    <IconButton
      size="compact"
      active={liked.isLiked}
      aria-pressed={undefined}
      aria-label={liked.isLiked ? `Remove ${title} from liked` : `Add ${title} to liked`}
      disabled={!liked.canToggle || liked.busy}
      onClick={liked.toggle}
    >
      <ThumbsUp size={16} fill={liked.isLiked ? 'currentColor' : 'none'} />
    </IconButton>
  )
}

/** Shuffle, previous, play, next and repeat. A preview has only restart and play. */
function Transport({ disc, className }: { disc: number; className?: string }) {
  const { player, isLibrary, title } = useNowPlaying()
  const { playing } = player
  const playLabel = isLibrary
    ? playing
      ? 'Pause'
      : 'Play'
    : playing
      ? 'Pause preview'
      : 'Play preview'
  return (
    <div className={cx('flex items-center', className)}>
      {isLibrary && (
        <IconButton
          size="compact"
          active={player.shuffle}
          aria-label="Shuffle"
          onClick={player.toggleShuffle}
        >
          <Shuffle size={16} />
        </IconButton>
      )}
      {isLibrary ? (
        <IconButton size="compact" aria-label="Previous track" onClick={player.previous}>
          <SkipBack size={18} />
        </IconButton>
      ) : (
        <IconButton
          size="compact"
          aria-label="Restart preview"
          disabled={!player.ready}
          onClick={() => {
            player.seek(0)
            if (!playing) player.toggle()
          }}
        >
          <RotateCcw size={16} />
        </IconButton>
      )}
      <button
        type="button"
        className={playDiscClassName}
        style={{ width: disc, height: disc }}
        aria-label={playLabel}
        disabled={!title}
        onClick={player.toggle}
      >
        {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
      </button>
      {isLibrary && (
        <IconButton size="compact" aria-label="Next track" onClick={player.next}>
          <SkipForward size={18} />
        </IconButton>
      )}
      {isLibrary && (
        <IconButton
          size="compact"
          className="relative"
          active={player.repeat !== 'off'}
          aria-label={`Repeat ${player.repeat}`}
          onClick={player.cycleRepeat}
        >
          <Repeat size={16} />
          {player.repeat === 'one' && (
            <small className="absolute right-[3px] bottom-[5px] text-micro text-accent">1</small>
          )}
        </IconButton>
      )}
    </div>
  )
}

/** The mini waveform with the time either side of it, or under it in the column. */
function Seek({ stacked }: { stacked: boolean }) {
  const { player, isLibrary } = useNowPlaying()
  const { libraryTrack, position, length, ready, seek } = player
  const seekMax = length || 30
  const bar =
    libraryTrack && length ? (
      <SeekBar
        trackId={libraryTrack.id}
        position={position}
        length={length}
        ready={ready}
        onSeek={seek}
      />
    ) : (
      <input
        className="w-full min-w-0 flex-1 accent-accent"
        aria-label={isLibrary ? 'Playback position' : 'Preview position'}
        type="range"
        min="0"
        max={seekMax}
        step="0.1"
        value={Math.min(position, seekMax)}
        disabled={!ready}
        onChange={(event) => seek(Number(event.target.value))}
      />
    )
  const times = [durationText(position), durationText(length)]
  if (stacked)
    return (
      <div className="mt-[10px]">
        <div className="flex h-[32px]">{bar}</div>
        <div className={cx(monoCaptionClassName, 'mt-[2px] flex justify-between tracking-normal')}>
          <span>{times[0]}</span>
          <span>{times[1]}</span>
        </div>
      </div>
    )
  return (
    <div className="flex min-w-[120px] flex-1 items-center gap-[10px]">
      <span className={cx(monoCaptionClassName, 'tracking-normal')}>{times[0]}</span>
      {bar}
      <span className={cx(monoCaptionClassName, 'tracking-normal')}>{times[1]}</span>
    </div>
  )
}

function MuteButton() {
  const { player, isLibrary } = useNowPlaying()
  const { muted, volume } = player
  return (
    <IconButton
      size="compact"
      aria-label={
        isLibrary ? (muted ? 'Unmute' : 'Mute') : muted ? 'Unmute preview' : 'Mute preview'
      }
      onClick={player.toggleMute}
    >
      {muted || volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
    </IconButton>
  )
}

/** Volume, the sleep timer and add to playlist: the dock's row under the transport. */
function Extras({ slider }: { slider: boolean }) {
  const { player, isLibrary, title } = useNowPlaying()
  return (
    <div className="flex items-center gap-[2px] text-muted">
      <MuteButton />
      {slider && (
        <input
          className="mr-[6px] min-w-0 flex-1 accent-accent"
          type="range"
          aria-label={isLibrary ? 'Volume' : 'Preview volume'}
          min="0"
          max="1"
          step="0.01"
          value={player.muted ? 0 : player.volume}
          onChange={(event) => player.setVolume(Number(event.target.value))}
        />
      )}
      {isLibrary && <SleepTimerControl />}
      {isLibrary && (
        <IconButton
          size="compact"
          aria-label={`Add ${title} to a playlist`}
          onClick={player.openPlaylistPicker}
        >
          <ListPlus size={16} />
        </IconButton>
      )}
    </div>
  )
}

function OpenStage() {
  const { isLibrary } = useNowPlaying()
  if (!isLibrary) return null
  return (
    <Link
      to="/now-playing"
      data-ui="icon-button"
      aria-label="Open Now Playing"
      className={iconButtonClassName(false, 'shrink-0 rounded-[8px] hover:bg-hover', 'compact')}
    >
      <Maximize2 size={15} />
    </Link>
  )
}

function ClosePlayer() {
  const { player, isLibrary, title } = useNowPlaying()
  if (!title) return null
  return (
    <IconButton
      size="compact"
      aria-label={isLibrary ? 'Close player' : 'Close preview'}
      onClick={player.stop}
    >
      <X size={15} />
    </IconButton>
  )
}

/**
 * Raises a toast when a queue save fails, as well as the strip in Up next, and takes it away again
 * once a retry lands. The shell calls it, so it works while the dock is out of sight on Now Playing.
 */
export function useQueueSaveToast() {
  const player = usePlayer()
  const toast = useToast()
  const latest = useRef(player)
  latest.current = player
  const { notice } = player
  useEffect(() => {
    if (notice === QUEUE_SAVE_FAILED)
      return toast.show({
        tone: 'warn',
        text: 'Queue not saved to the server.',
        action: { label: 'Retry', run: () => latest.current.retryQueueSave() },
      })
    if (notice === QUEUE_REPLACED)
      return toast.show({
        tone: 'warn',
        text: 'Another browser saved the queue. Reload to pick it up.',
        action: { label: 'Reload', run: () => location.reload() },
      })
    return undefined
  }, [notice, toast])
}

/** The inline version of the toast above, at the head of Up next. */
function QueueSaveStrip() {
  const player = usePlayer()
  const failed = player.notice === QUEUE_SAVE_FAILED
  if (!failed && player.notice !== QUEUE_REPLACED) return null
  return (
    <div className="mx-[12px] mt-[4px] mb-[6px] flex items-center gap-[8px] rounded-[10px] bg-warn-bg py-[6px] pr-[6px] pl-[10px] text-small text-warn">
      <CloudOff size={14} className="shrink-0" />
      <span className="flex-1 text-text">
        {failed ? 'Queue not saved to server' : 'Another browser saved the queue'}
      </span>
      <button
        type="button"
        className="h-[28px] shrink-0 rounded-[6px] border-0 bg-warn/15 px-[8px] text-small font-medium text-warn coarse:min-h-11"
        onClick={failed ? player.retryQueueSave : () => location.reload()}
      >
        {failed ? 'Retry' : 'Reload'}
      </button>
    </div>
  )
}

/** Where a dragged row would land: the gap before row `slot`, counted in the whole queue. */
type QueueDrag = { from: number; slot: number }
// A drag this close to the list's top or bottom edge scrolls it, so a long queue can be reached.
const DRAG_EDGE = 32
const DRAG_STEP = 12

/**
 * Up next: what follows the playing track. A row plays when pressed. It moves by its handle, by
 * Alt with an arrow key, or by its move buttons, and its cross removes it; the buttons cover the
 * duration on hover and focus where there is hover, and sit beside it where there is not. Each change is announced,
 * since a reordered list looks the same to a screen reader.
 */
function UpNext({ className }: { className?: string }) {
  const player = usePlayer()
  const client = useQueryClient()
  const list = useRef<HTMLDivElement>(null)
  const nameId = useId()
  const dragging = useRef<QueueDrag | null>(null)
  const [drag, setDrag] = useState<QueueDrag | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const following = player.currentIndex + 1
  const upcoming = player.queue.slice(following)
  const savePlaylist = useMutation({
    mutationFn: (playlistName: string) =>
      api('library/playlists', libraryPlaylistDetailSchema, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: playlistName, song_ids: player.queue.map((item) => item.id) }),
      }),
    onSuccess: (playlist) => {
      void client.invalidateQueries({ queryKey: ['library-playlists'] })
      setAnnouncement(`Saved ${songCount(player.queue.length)} as playlist ${playlist.name}.`)
      setNaming(false)
      setName('')
    },
  })

  useEffect(() => {
    if (!drag) return
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape') updateDrag(null)
    }
    window.addEventListener('keydown', cancel)
    return () => window.removeEventListener('keydown', cancel)
  }, [drag !== null])

  function updateDrag(next: QueueDrag | null) {
    dragging.current = next
    setDrag(next)
  }

  function moveTo(from: number, to: number) {
    const track = player.queue[from]
    if (!track || to < following || to >= player.queue.length || to === from) return
    player.moveInQueue(from, to)
    setAnnouncement(`Moved ${track.title} to position ${to - following + 1} of ${upcoming.length}.`)
  }

  function remove(index: number) {
    const track = player.queue[index]
    if (!track) return
    player.removeFromQueue(index)
    setAnnouncement(`Removed ${track.title}. ${songCount(upcoming.length - 1)} up next.`)
  }

  function clear() {
    player.clearQueue()
    setAnnouncement(`Cleared the queue. ${songCount(upcoming.length)} removed.`)
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = name.trim()
    if (trimmed) savePlaylist.mutate(trimmed)
  }

  // The gap the pointer is over: before the first row whose middle is below it, else the end.
  function slotAt(clientY: number) {
    const rows = Array.from(list.current?.querySelectorAll<HTMLElement>('[data-queue-index]') ?? [])
    const before = rows.find((row) => {
      const box = row.getBoundingClientRect()
      return clientY < box.top + box.height / 2
    })
    return before ? Number(before.dataset.queueIndex) : player.queue.length
  }

  function startDrag(event: ReactPointerEvent<HTMLElement>, index: number) {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    updateDrag({ from: index, slot: index })
  }

  function moveDrag(event: ReactPointerEvent<HTMLElement>) {
    const current = dragging.current
    const box = list.current?.getBoundingClientRect()
    if (!current || !box) return
    if (event.clientY < box.top + DRAG_EDGE) list.current?.scrollBy({ top: -DRAG_STEP })
    else if (event.clientY > box.bottom - DRAG_EDGE) list.current?.scrollBy({ top: DRAG_STEP })
    const slot = slotAt(event.clientY)
    if (slot !== current.slot) updateDrag({ ...current, slot })
  }

  function endDrag() {
    const current = dragging.current
    updateDrag(null)
    if (!current) return
    // Dropping into the gap after the row itself, or the gap before it, changes nothing. Past it,
    // the row's own removal shifts the gap up by one.
    moveTo(current.from, current.slot > current.from ? current.slot - 1 : current.slot)
  }

  return (
    <section aria-label="Up next" className={cx('flex min-h-0 flex-col', className)}>
      <div className="flex items-center gap-[8px] px-[16px] pt-[12px] pb-[6px]">
        <h2 className="text-body font-semibold">Up next</h2>
        <span className={cx(monoCaptionClassName, 'tracking-normal')}>{upcoming.length}</span>
        <span className="flex-1" />
        <IconButton
          size="compact"
          aria-label="Save queue as playlist"
          aria-expanded={naming}
          disabled={!player.queue.length}
          onClick={() => setNaming(!naming)}
        >
          <Save size={14} />
        </IconButton>
        <IconButton
          size="compact"
          aria-label="Clear queue"
          disabled={!upcoming.length}
          onClick={clear}
        >
          <Trash2 size={14} />
        </IconButton>
      </div>
      {naming && (
        <form className="mx-[12px] mb-[8px] grid gap-[8px]" onSubmit={submit}>
          <label className="sr-only" htmlFor={nameId}>
            Playlist name
          </label>
          <Field
            id={nameId}
            autoFocus
            value={name}
            maxLength={200}
            placeholder="Playlist name"
            onChange={(event) => setName(event.target.value)}
          />
          <div className="flex gap-[8px]">
            <Button
              type="submit"
              variant="primary"
              disabled={savePlaylist.isPending || !name.trim()}
            >
              {savePlaylist.isPending ? 'Saving…' : 'Save'}
            </Button>
            <Button type="button" onClick={() => setNaming(false)}>
              Cancel
            </Button>
          </div>
          {savePlaylist.isError && (
            <ErrorBanner className="m-0" role="alert">
              {savePlaylist.error.message}
            </ErrorBanner>
          )}
        </form>
      )}
      <QueueSaveStrip />
      <div
        ref={list}
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-[8px] pb-[10px]"
      >
        {upcoming.length ? (
          upcoming.map((track, position) => {
            const index = following + position
            const key = queueEntryKey(track)
            const last = index === player.queue.length - 1
            return (
              <div
                key={key}
                data-queue-index={index}
                className={cx(
                  'group/row relative flex items-center rounded-[10px] hover:bg-hover',
                  drag?.from === index && 'opacity-50',
                  drag?.slot === index && 'shadow-[inset_0_2px_0_0_var(--color-accent)]',
                  last &&
                    drag?.slot === player.queue.length &&
                    'shadow-[inset_0_-2px_0_0_var(--color-accent)]',
                )}
              >
                {/* Pointer only. The keyboard moves a row with the buttons or Alt and an arrow. */}
                <span
                  aria-hidden="true"
                  className="grid w-[16px] flex-none cursor-grab touch-none place-items-center self-stretch text-faint opacity-0 select-none group-hover/row:opacity-100 active:cursor-grabbing no-hover:opacity-100"
                  onPointerDown={(event) => startDrag(event, index)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={() => updateDrag(null)}
                >
                  ⠿
                </span>
                <button
                  type="button"
                  className="grid min-w-0 flex-1 grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-[10px] border-0 bg-transparent py-[5px] pr-[4px] text-left text-inherit coarse:min-h-11"
                  aria-label={`Play ${track.title}`}
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  onClick={() => player.playLibrary(player.queue, index, player.source)}
                  onKeyDown={(event) => {
                    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown'))
                      return
                    event.preventDefault()
                    moveTo(index, index + (event.key === 'ArrowUp' ? -1 : 1))
                  }}
                >
                  <Cover art={artUrl(track)} className="size-[36px] rounded-[6px]" />
                  <span className="min-w-0">
                    <span className="block truncate text-small font-medium">{track.title}</span>
                    <span className="block truncate text-tiny text-muted">{track.artist}</span>
                  </span>
                  <time className={cx(monoCaptionClassName, 'tracking-normal no-hover:hidden')}>
                    {durationText(track.duration)}
                  </time>
                </button>
                {/* Over the duration, see-through until the row is hovered or holds focus, so the
                    buttons stay in the accessibility tree and reachable by Tab. In the flow where
                    there is no hover. */}
                <span
                  className={cx(
                    'pointer-events-none absolute inset-y-0 right-0 flex items-center rounded-r-[10px] bg-hover pl-[4px] opacity-0 shadow-[-10px_0_10px_-2px_var(--color-hover)]',
                    'group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100',
                    'no-hover:pointer-events-auto no-hover:static no-hover:bg-transparent no-hover:opacity-100 no-hover:shadow-none',
                  )}
                >
                  <IconButton
                    size="compact"
                    className="min-w-[26px] p-[4px]"
                    aria-label={`Move ${track.title} up`}
                    disabled={position === 0}
                    onClick={() => moveTo(index, index - 1)}
                  >
                    <ChevronUp size={15} />
                  </IconButton>
                  <IconButton
                    size="compact"
                    className="min-w-[26px] p-[4px]"
                    aria-label={`Move ${track.title} down`}
                    disabled={last}
                    onClick={() => moveTo(index, index + 1)}
                  >
                    <ChevronDown size={15} />
                  </IconButton>
                  <IconButton
                    size="compact"
                    className="min-w-[26px] p-[4px]"
                    aria-label={`Remove ${track.title} from the queue`}
                    onClick={() => remove(index)}
                  >
                    <X size={15} />
                  </IconButton>
                </span>
              </div>
            )
          })
        ) : (
          <p className="px-[8px] py-[10px] text-small text-muted">Nothing else is queued.</p>
        )}
      </div>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </section>
  )
}

const dockClassName = 'rounded-[18px] bg-sunken text-text'

/** The wide window's dock: a column to the right of the page. */
function DockColumn() {
  const { art, isLibrary } = useNowPlaying()
  const cover = (
    <Cover
      art={art}
      className="mx-auto block aspect-square w-full max-w-[34dvh] rounded-[14px] shadow-[0_24px_50px_-24px_color-mix(in_oklab,var(--color-shadow)_80%,transparent)]"
    />
  )
  return (
    <aside
      aria-label="Player"
      className={cx(dockClassName, 'flex min-h-0 flex-col overflow-hidden')}
    >
      <div className="px-[16px] pt-[12px]">
        <div className="mb-[8px] flex items-center gap-[4px]">
          <span className={cx(monoCaptionClassName, 'flex-1')}>NOW PLAYING</span>
          <PetSpot size={28} />
          <ClosePlayer />
          <OpenStage />
        </div>
        {isLibrary ? (
          <Link to="/now-playing" aria-label="Open Now Playing" tabIndex={-1} className="block">
            {cover}
          </Link>
        ) : (
          cover
        )}
        <div className="mt-[14px] flex items-start gap-[8px]">
          <TrackLines titleClassName="text-strong tracking-[-0.3px]" />
          <LikeButton />
        </div>
        <Notice className="mt-[4px]" />
        <Seek stacked />
        <Transport disc={48} className="mt-[4px] justify-between" />
        <div className="mt-[4px] mb-[10px]">
          <Extras slider />
        </div>
      </div>
      <UpNext className="flex-1 border-t border-line" />
    </aside>
  )
}

/** Under the tablet edge: one bar under the page, with Up next in a panel above it. */
function DockBar() {
  const { player, art, isLibrary } = useNowPlaying()
  const [queueOpen, setQueueOpen] = useState(false)
  const root = useRef<HTMLElement>(null)
  const panelId = useId()
  const upcoming = Math.max(0, player.queue.length - player.currentIndex - 1)

  useEffect(() => {
    if (!queueOpen) return
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !root.current?.contains(event.target))
        setQueueOpen(false)
    }

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setQueueOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [queueOpen])

  const cover = <Cover art={art} className="size-[52px] rounded-[10px]" />
  return (
    <aside
      ref={root}
      aria-label="Player"
      className={cx(dockClassName, 'relative flex h-[76px] items-center gap-[10px] px-[12px]')}
    >
      {isLibrary ? (
        <Link to="/now-playing" aria-label="Open Now Playing" tabIndex={-1} className="shrink-0">
          {cover}
        </Link>
      ) : (
        cover
      )}
      <div className="flex w-[clamp(120px,22vw,240px)] min-w-0 items-center gap-[4px]">
        <div className="min-w-0 flex-1">
          <TrackLines titleClassName="text-body" />
          <Notice />
        </div>
        <LikeButton />
      </div>
      <Transport disc={40} />
      <Seek stacked={false} />
      <Extras slider={false} />
      <PetSpot size={26} />
      {isLibrary && (
        <IconButton
          size="compact"
          active={queueOpen}
          aria-pressed={undefined}
          aria-label={`Up next, ${songCount(upcoming)}`}
          aria-expanded={queueOpen}
          aria-controls={panelId}
          onClick={() => setQueueOpen(!queueOpen)}
        >
          <ListMusic size={17} />
        </IconButton>
      )}
      <ClosePlayer />
      {queueOpen && (
        <div
          id={panelId}
          className={cx(
            dockClassName,
            'absolute right-0 bottom-[calc(100%+8px)] z-overlay flex h-[min(60vh,520px)] w-[min(360px,100%)] flex-col border border-line shadow-[0_20px_50px_color-mix(in_oklab,var(--color-shadow)_55%,transparent)]',
          )}
        >
          <UpNext className="flex-1" />
        </div>
      )}
    </aside>
  )
}

export function PlayerDock({ bar }: { bar: boolean }) {
  return bar ? <DockBar /> : <DockColumn />
}

/**
 * The phone's floating mini player, above the tab bar. The cover and title open Now Playing, which
 * has every other control. `data-room-mini` is what style.css reads to make room for it.
 */
export function RoomMiniPlayer() {
  const { player, isLibrary, title, artist, art } = useNowPlaying()
  if (!title) return null
  const cover = <Cover art={art} className="size-[44px] rounded-[10px]" />
  return (
    <section
      aria-label="Player"
      data-room-mini=""
      className="fixed right-[calc(10px+var(--safe-right))] bottom-[calc(var(--nav-height)+var(--safe-bottom)+8px)] left-[calc(10px+var(--safe-left))] z-bar flex h-[58px] items-center gap-[10px] rounded-[16px] bg-raised p-[7px] shadow-[0_12px_30px_color-mix(in_oklab,var(--color-shadow)_50%,transparent)] ring-1 ring-line-strong"
    >
      {isLibrary ? (
        <Link to="/now-playing" aria-label="Open Now Playing" className="shrink-0">
          {cover}
        </Link>
      ) : (
        cover
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-body font-semibold">
          {isLibrary ? <Link to="/now-playing">{title}</Link> : title}
        </div>
        {artist && <div className="truncate text-small text-muted">{artist}</div>}
      </div>
      <button
        type="button"
        className={cx(playDiscClassName, 'size-[44px]')}
        aria-label={player.playing ? 'Pause' : 'Play'}
        onClick={player.toggle}
      >
        {player.playing ? (
          <Pause size={18} fill="currentColor" />
        ) : (
          <Play size={18} fill="currentColor" />
        )}
      </button>
    </section>
  )
}
