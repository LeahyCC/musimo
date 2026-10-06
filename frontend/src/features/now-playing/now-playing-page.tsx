import {
  type Dispatch,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronDown, ChevronUp, Disc3, ListMusic, Trash2, X } from 'lucide-react'

import {
  api,
  libraryAlbumDetailSchema,
  libraryArtistDetailSchema,
  libraryPlaylistDetailSchema,
  libraryPlaylistsSchema,
} from '../../api'
import type { LibraryTrack } from '../../api'
import { RowMenu } from '../../components/row-menu'
import { cx } from '../../lib/cx'
import { relativeTime } from '../../lib/relative-time'
import {
  Button,
  buttonClassName,
  EmptyPanel,
  ErrorBanner,
  Field,
  IconButton,
  Panel,
  sectionCaptionClassName,
  tabId,
  TabList,
  tabPanelId,
} from '../../ui'
import { historyTrack } from '../player/play-history'
import {
  artUrl,
  durationText,
  queueEntryKey,
  remember,
  songCount,
  stored,
  usePlayer,
} from '../player/player'
import { queueActions } from '../player/queue-actions'
import { AboutPanel } from './about-track'
import { LyricsPanel } from './lyrics'
import { NowPlayingControls } from './now-playing-controls'
import { NowPlayingStage, useNowPlayingPopout } from './now-playing-popout'
import { pageKeyIsFree, ShortcutsDialog, usePageShortcuts } from './now-playing-shortcuts'
import { NowPlayingWash } from './now-playing-wash'

const lyricLineClassName = 'py-[8px] text-section text-text'

/* Up next, Lyrics, About and History share one panel, so none starts below the fold and Lyrics is
   a tap away however long the queue is. */
const PANEL_TABS = [
  { id: 'up-next', label: 'Up next' },
  { id: 'lyrics', label: 'Lyrics' },
  { id: 'about', label: 'About' },
  { id: 'history', label: 'History' },
] as const
type PanelTab = (typeof PANEL_TABS)[number]['id']
const PANEL_TAB_KEY = 'musimo.now-playing-tab'
/** Where a history row starts its track, so Up next can say what the queue came from. */
const HISTORY_SOURCE = 'history'
/* The panel scrolls inside itself beside the stage. On a phone the page is what scrolls, so the
   panel just grows. */
const tabPanelClassName =
  'min-h-0 flex-1 overflow-auto overscroll-contain max-phone:overflow-visible'

/**
 * What the queue was started from, worded for after "Playing from", or an empty string where the
 * player does not know (a restored queue) or the name has not arrived yet. The player keeps only
 * an id such as `playlist:abc`, so the name comes from the reads the library pages already make
 * and share through the query cache. A queue changed by hand since it began still says what it
 * began as, with "edited" after it.
 */
function usePlayingFrom(source: string, edited: boolean) {
  const split = source.indexOf(':')
  const kind = split < 0 ? source : source.slice(0, split)
  const id = split < 0 ? '' : source.slice(split + 1)
  const playlists = useQuery({
    queryKey: ['library-playlists'],
    queryFn: ({ signal }) => api('library/playlists', libraryPlaylistsSchema, { signal }),
    enabled: kind === 'playlist',
  })
  const album = useQuery({
    queryKey: ['library-album', id],
    queryFn: ({ signal }) =>
      api(`library/albums/${encodeURIComponent(id)}`, libraryAlbumDetailSchema, { signal }),
    enabled: kind === 'album',
  })
  const artist = useQuery({
    queryKey: ['library-artist', id],
    queryFn: ({ signal }) =>
      api(`library/artists/${encodeURIComponent(id)}`, libraryArtistDetailSchema, { signal }),
    enabled: kind === 'artist',
  })
  const describe = () => {
    if (kind === 'playlist') {
      const name = playlists.data?.items.find((item) => item.id === id)?.name
      return name ? `playlist ${name}` : ''
    }
    if (kind === 'queue') return 'your queue'
    if (kind === HISTORY_SOURCE) return 'your history'
    if (kind === 'album') return album.data ? `album ${album.data.name}` : ''
    if (kind === 'artist') return artist.data ? `artist ${artist.data.name}` : ''
    if (kind === 'tracks') {
      // The rest of the id is the Tracks view's own query string; only the search is worth saying.
      const search = new URLSearchParams(id).get('q')
      return search ? `tracks matching "${search}"` : 'your tracks'
    }
    return ''
  }
  const from = describe()
  // "Your queue" is already the edited one, so it needs no second word for it.
  return from && edited && kind !== 'queue' ? `${from}, edited` : from
}

/** Where a dragged Up next row would land: the gap before row `slot`, counted in the whole queue. */
type QueueDrag = { from: number; slot: number }

// A drag this close to the panel's top or bottom edge scrolls it, so a long queue can be reached.
const DRAG_EDGE = 36
const DRAG_STEP = 14

/**
 * Up next: what follows the playing track, and the ways to change it. A row is dragged by its
 * handle, and the same move is on the keyboard as Alt with an arrow key on the row, or as the
 * move buttons. Each change is announced, since a reordered list looks the same to a screen reader.
 */
function UpNext() {
  const player = usePlayer()
  const client = useQueryClient()
  const list = useRef<HTMLDivElement>(null)
  const focusAfter = useRef<{ key: string; control: string } | null>(null)
  const dragging = useRef<QueueDrag | null>(null)
  const [drag, setDrag] = useState<QueueDrag | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const playingFrom = usePlayingFrom(player.source, player.edited)
  // Up next is what comes after the playing track, so the track itself is never its first row.
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

  // A change can move the row that had focus, or remove it. Put focus back on that control, or on
  // the panel when there is nothing left to hold it, so the keyboard never starts again from the top.
  useEffect(() => {
    const target = focusAfter.current
    if (!target) return
    focusAfter.current = null
    const row = list.current?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(target.key)}"]`)
    const control =
      row?.querySelector<HTMLElement>(`[data-control="${target.control}"]:not(:disabled)`) ??
      row?.querySelector<HTMLElement>('[data-control="play"]')
    const panel = list.current?.closest<HTMLElement>('[role="tabpanel"]')
    ;(control ?? panel)?.focus()
  }, [player.queue])

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

  /** `control` is the button to hand focus back to; a drag by pointer leaves focus alone. */
  function moveTo(from: number, to: number, control?: string) {
    const track = player.queue[from]
    if (!track || to < following || to >= player.queue.length || to === from) return
    if (control) focusAfter.current = { key: queueEntryKey(track), control }
    player.moveInQueue(from, to)
    setAnnouncement(`Moved ${track.title} to position ${to - following + 1} of ${upcoming.length}.`)
  }

  function remove(index: number) {
    const track = player.queue[index]
    if (!track) return
    const neighbour =
      player.queue[index + 1] ?? (index > following ? player.queue[index - 1] : undefined)
    focusAfter.current = { key: neighbour ? queueEntryKey(neighbour) : '', control: 'remove' }
    player.removeFromQueue(index)
    setAnnouncement(`Removed ${track.title}. ${songCount(upcoming.length - 1)} up next.`)
  }

  function clear() {
    focusAfter.current = { key: '', control: '' }
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
    if (!current) return
    const panel = list.current?.closest<HTMLElement>('[role="tabpanel"]')
    if (panel) {
      const box = panel.getBoundingClientRect()
      if (event.clientY < box.top + DRAG_EDGE) panel.scrollBy({ top: -DRAG_STEP })
      else if (event.clientY > box.bottom - DRAG_EDGE) panel.scrollBy({ top: DRAG_STEP })
    }
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
    <>
      <div className="mb-[8px] flex items-baseline justify-between gap-[12px]">
        <p className="min-w-0 truncate text-small">
          {playingFrom && (
            <>
              Playing from <span className="text-text">{playingFrom}</span>
            </>
          )}
        </p>
        <span className={cx(sectionCaptionClassName, 'shrink-0')}>
          {player.queue.length} {player.queue.length === 1 ? 'TRACK' : 'TRACKS'}
        </span>
      </div>
      <div className="mb-[8px] flex flex-wrap items-center gap-[8px]">
        <Button onClick={clear} disabled={!upcoming.length}>
          <Trash2 size={15} /> Clear queue
        </Button>
        <Button
          aria-expanded={naming}
          disabled={!player.queue.length}
          onClick={() => setNaming(!naming)}
        >
          <ListMusic size={15} /> Save as playlist
        </Button>
      </div>
      {naming && (
        <form
          className="mb-[10px] flex flex-wrap items-end gap-[10px] rounded-[9px] border border-line bg-sunken p-[12px]"
          onSubmit={submit}
        >
          <label className="grid min-w-[min(200px,100%)] flex-1 gap-[6px] text-small text-muted">
            Playlist name
            <Field
              autoFocus
              value={name}
              maxLength={200}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <Button type="submit" variant="primary" disabled={savePlaylist.isPending || !name.trim()}>
            {savePlaylist.isPending ? 'Saving…' : 'Save'}
          </Button>
          <Button type="button" onClick={() => setNaming(false)}>
            Cancel
          </Button>
          {savePlaylist.isError && (
            <ErrorBanner className="m-0 w-full" role="alert">
              {savePlaylist.error.message}
            </ErrorBanner>
          )}
        </form>
      )}
      <div ref={list}>
        {upcoming.length ? (
          upcoming.map((track, position) => {
            const index = following + position
            const key = queueEntryKey(track)
            const last = index === player.queue.length - 1
            return (
              <div
                key={key}
                data-entry={key}
                data-queue-index={index}
                className={cx(
                  'flex items-center gap-[2px] border-b border-line',
                  drag?.from === index && 'opacity-50',
                  // A line where the row would land: above this row, or below the last one.
                  drag?.slot === index && 'shadow-[inset_0_2px_0_0_var(--color-accent)]',
                  last &&
                    drag?.slot === player.queue.length &&
                    'shadow-[inset_0_-2px_0_0_var(--color-accent)]',
                )}
              >
                {/* Pointer only. The keyboard moves a row with the buttons or Alt and an arrow. */}
                <span
                  aria-hidden="true"
                  className="grid w-[22px] flex-none cursor-grab touch-none place-items-center self-stretch text-faint select-none hover:text-muted active:cursor-grabbing coarse:w-[28px]"
                  onPointerDown={(event) => startDrag(event, index)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={() => updateDrag(null)}
                >
                  ⠿
                </span>
                <button
                  type="button"
                  data-control="play"
                  className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-[12px] rounded-md border-0 bg-transparent px-[8px] py-[10px] text-left text-inherit hover:bg-hover coarse:min-h-11"
                  aria-label={`Play ${track.title}`}
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  onClick={() => player.playLibrary(player.queue, index, player.source)}
                  onKeyDown={(event) => {
                    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown'))
                      return
                    event.preventDefault()
                    moveTo(index, index + (event.key === 'ArrowUp' ? -1 : 1), 'play')
                  }}
                >
                  <span className="grid min-w-0 gap-[3px]">
                    <strong className="truncate">{track.title}</strong>
                    <small className="truncate text-small text-muted">{track.artist}</small>
                  </span>
                  <time className="text-small text-muted max-phone:hidden">
                    {durationText(track.duration)}
                  </time>
                </button>
                <IconButton
                  data-control="up"
                  size="compact"
                  aria-label={`Move ${track.title} up`}
                  disabled={position === 0}
                  onClick={() => moveTo(index, index - 1, 'up')}
                >
                  <ChevronUp size={16} />
                </IconButton>
                <IconButton
                  data-control="down"
                  size="compact"
                  aria-label={`Move ${track.title} down`}
                  disabled={last}
                  onClick={() => moveTo(index, index + 1, 'down')}
                >
                  <ChevronDown size={16} />
                </IconButton>
                <IconButton
                  data-control="remove"
                  size="compact"
                  aria-label={`Remove ${track.title} from the queue`}
                  onClick={() => remove(index)}
                >
                  <X size={16} />
                </IconButton>
              </div>
            )
          })
        ) : (
          <p className={lyricLineClassName}>Nothing else is queued.</p>
        )}
      </div>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </>
  )
}

// The times are relative, so they are worked out again each minute the panel is on show.
const HISTORY_TICK = 60_000

/** What this browser has played, newest first. A row plays the track again. */
function History({ visible }: { visible: boolean }) {
  const player = usePlayer()
  const [now, setNow] = useState(() => Date.now())
  // Clearing asks in place, where the button was, rather than in the browser's own dialog.
  const [confirming, setConfirming] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const questionId = useId()
  const bar = useRef<HTMLDivElement>(null)
  const clearButton = useRef<HTMLButtonElement>(null)
  const keepButton = useRef<HTMLButtonElement>(null)
  // Set when the question is dismissed, so focus goes back to the button that asked it.
  const returnFocus = useRef(false)
  const count = player.history.length
  // An empty history has nothing left to ask about, so the question goes with the last entry.
  const asking = confirming && count > 0
  const tracksText = `${count} ${count === 1 ? 'track' : 'tracks'}`

  useEffect(() => {
    if (!visible) {
      setConfirming(false)
      return
    }
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), HISTORY_TICK)
    return () => window.clearInterval(timer)
  }, [visible])

  // Keep is where focus starts, so an Enter pressed by habit does not clear anything.
  useEffect(() => {
    if (asking) keepButton.current?.focus()
    else if (returnFocus.current) {
      returnFocus.current = false
      clearButton.current?.focus()
    }
  }, [asking])

  function ask() {
    setAnnouncement(`Clear ${tracksText} from your play history? This cannot be undone.`)
    setConfirming(true)
  }

  function keep() {
    returnFocus.current = true
    setAnnouncement('History kept.')
    setConfirming(false)
  }

  function clear() {
    player.clearHistory()
    setAnnouncement('History cleared.')
    setConfirming(false)
    // The button that was here is disabled now, so the bar holds focus instead of losing it.
    bar.current?.focus()
  }

  return (
    <>
      <div
        ref={bar}
        tabIndex={-1}
        className="mb-[8px] flex flex-wrap items-center justify-between gap-[8px] outline-none"
        onKeyDown={(event) => {
          if (asking && event.key === 'Escape') {
            event.stopPropagation()
            keep()
          }
        }}
      >
        {asking ? (
          <div
            role="group"
            aria-labelledby={questionId}
            className="flex flex-wrap items-center gap-[8px]"
          >
            <span id={questionId} className="text-small">
              Clear {tracksText}?
            </span>
            <Button variant="danger" onClick={clear}>
              Clear
            </Button>
            <Button ref={keepButton} onClick={keep}>
              Keep
            </Button>
          </div>
        ) : (
          <Button ref={clearButton} onClick={ask} disabled={!count}>
            <Trash2 size={15} /> Clear history
          </Button>
        )}
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </p>
        <span className={cx(sectionCaptionClassName, 'shrink-0')}>
          {player.history.length} {player.history.length === 1 ? 'TRACK' : 'TRACKS'}
        </span>
      </div>
      {player.history.length ? (
        player.history.map((entry) => {
          const track = historyTrack(entry)
          return (
            <div
              key={`${entry.playedAt}-${entry.id}`}
              className="flex items-center gap-[2px] border-b border-line"
            >
              <button
                type="button"
                className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-[12px] rounded-md border-0 bg-transparent px-[8px] py-[10px] text-left text-inherit hover:bg-hover coarse:min-h-11"
                aria-label={`Play ${entry.title}`}
                onClick={() => {
                  // With a queue loaded, the song slots in after the playing one and plays, so
                  // looking back three songs does not throw away everything that was lined up.
                  if (player.libraryTrack) {
                    player.playNext([track])
                    player.next()
                  } else player.playLibrary([track], 0, HISTORY_SOURCE)
                }}
              >
                <span className="grid min-w-0 gap-[3px]">
                  <strong className="truncate">{entry.title}</strong>
                  <small className="truncate text-small text-muted">{entry.artist}</small>
                </span>
                <time
                  className="text-small text-muted"
                  dateTime={new Date(entry.playedAt).toISOString()}
                >
                  {relativeTime(entry.playedAt, now)}
                </time>
              </button>
              <RowMenu
                className="mr-[5px]"
                label={`More actions for ${entry.title}`}
                actions={queueActions(
                  () => player.playNext([track]),
                  () => player.addToQueue([track]),
                )}
              />
            </div>
          )
        })
      ) : (
        <p className={lyricLineClassName}>Nothing played yet.</p>
      )}
    </>
  )
}

// Up next, Lyrics, About and History in one panel that fills the column beside the stage, or a
// screen's height of its own under a large stage. `className` sets which.
function NowPlayingTabs({
  track,
  className,
  lyricsView,
  onLyricsView,
}: {
  track: LibraryTrack
  className?: string
  /** Whether the lyrics view (large type) is open. The page owns it, to hide itself beneath it. */
  lyricsView: boolean
  onLyricsView: Dispatch<SetStateAction<boolean>>
}) {
  const idBase = useId()
  const [tab, setTab] = useState<PanelTab>(() => {
    const saved = stored(PANEL_TAB_KEY, 'up-next')
    return PANEL_TABS.find((item) => item.id === saved)?.id ?? 'up-next'
  })
  const choose = (next: PanelTab) => {
    setTab(next)
    remember(PANEL_TAB_KEY, next)
  }
  const toggleLarge = useCallback(() => onLyricsView((on) => !on), [onLyricsView])

  // L opens the lyrics view, and closes it. From the other tab it opens Lyrics and the view, so the
  // key always shows something; the view's own Escape is in `lyrics.tsx`. Q goes to Up next, and
  // closes the view. Typing in a field keeps its own letters, and so does an open dialog, the
  // command palette included. A full screen stage has the whole screen, so L leaves it alone.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const letter = event.key.toLowerCase()
      if ((letter !== 'l' && letter !== 'q') || event.repeat) return
      if (document.fullscreenElement || !pageKeyIsFree(event)) return
      if (letter === 'q') {
        if (tab === 'up-next') return
        setTab('up-next')
        remember(PANEL_TAB_KEY, 'up-next')
        onLyricsView(false)
      } else if (tab === 'lyrics') onLyricsView((on) => !on)
      else {
        setTab('lyrics')
        remember(PANEL_TAB_KEY, 'lyrics')
        onLyricsView(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tab, onLyricsView])

  return (
    <Panel className={cx('flex min-w-0 flex-col', className)}>
      <TabList
        label="Now Playing panel"
        idBase={idBase}
        tabs={PANEL_TABS}
        value={tab}
        onChange={choose}
        className="mb-[14px]"
      />
      {/* Both panels stay in the document, so every tab's `aria-controls` names something that
          exists; the one not chosen is hidden. */}
      <div
        role="tabpanel"
        id={tabPanelId(idBase, 'up-next')}
        aria-labelledby={tabId(idBase, 'up-next')}
        // A box that scrolls has to be reachable from the keyboard.
        tabIndex={0}
        hidden={tab !== 'up-next'}
        className={tabPanelClassName}
      >
        <UpNext />
      </div>
      <div
        role="tabpanel"
        id={tabPanelId(idBase, 'lyrics')}
        aria-labelledby={tabId(idBase, 'lyrics')}
        hidden={tab !== 'lyrics'}
        className="min-h-0 flex-1"
      >
        {/* The lines scroll in a box of their own inside the panel, so the timing controls stay in
            view; the box is what takes focus. */}
        <LyricsPanel
          key={track.id}
          track={track}
          visible={tab === 'lyrics'}
          large={lyricsView}
          onToggleLarge={toggleLarge}
        />
      </div>
      <div
        role="tabpanel"
        id={tabPanelId(idBase, 'about')}
        aria-labelledby={tabId(idBase, 'about')}
        tabIndex={0}
        hidden={tab !== 'about'}
        className={tabPanelClassName}
      >
        <AboutPanel key={track.id} track={track} visible={tab === 'about'} />
      </div>
      <div
        role="tabpanel"
        id={tabPanelId(idBase, 'history')}
        aria-labelledby={tabId(idBase, 'history')}
        tabIndex={0}
        hidden={tab !== 'history'}
        className={tabPanelClassName}
      >
        <History visible={tab === 'history'} />
      </div>
    </Panel>
  )
}

// What the window leaves under the top bar and the page's own padding (see `--page-pad` below).
const nowPlayingScreenClassName =
  'h-[calc(100dvh_-_var(--topbar-height)_-_var(--safe-top)_-_var(--page-pad))]'

export function NowPlayingPage() {
  const player = usePlayer()
  const popout = useNowPlayingPopout()
  const track = player.libraryTrack
  const [help, setHelp] = useState(false)
  const openHelp = useCallback(() => setHelp(true), [])
  const closeHelp = useCallback(() => setHelp(false), [])
  // The lyrics view takes over the content area. It lives here because the page hides its two
  // columns under it. Not remembered, and gone with the track.
  const [lyricsView, setLyricsView] = useState(false)
  const hasTrack = Boolean(track)
  useEffect(() => {
    if (!hasTrack) setLyricsView(false)
  }, [hasTrack])
  // A phone has one layout, so the choice is kept but not applied there, and S is not offered.
  const large = popout.size === 'large' && !popout.phone
  usePageShortcuts({
    enabled: Boolean(track),
    stage: popout.dockedStage,
    onHelp: openHelp,
    onSize: popout.phone ? undefined : popout.toggleSize,
  })
  if (!track)
    return (
      <EmptyPanel tall>
        <Disc3 size={40} />
        {/* A catalog preview can never reach the stage: its audio has no CORS headers, so the
            visualizer cannot read it. Say so rather than claim nothing is playing. */}
        {player.track ? (
          <>
            <h1>A preview is playing.</h1>
            <p className="text-muted">
              {popout.canVisualize
                ? 'Now Playing and its visuals play with tracks from your library.'
                : 'Now Playing plays with tracks from your library.'}
            </p>
          </>
        ) : (
          <h1>Nothing playing yet.</h1>
        )}
        <Link data-ui="button" className={buttonClassName('primary', 'mx-auto')} to="/library">
          Open your library
        </Link>
      </EmptyPanel>
    )

  // Two columns that together fit the window under the top bar: the stage and its controls on
  // the left, one tabbed panel on the right that scrolls inside itself. `main` pads its bottom by
  // 130px to clear the footer player, which this page hides, so the columns take back all but
  // 24px of it. A phone stacks them and lets the page scroll.
  //
  // A large stage stacks them too, but keeps a window's height for the stage and its controls, so
  // the stage takes what is left above them, and the panel gets a window's height of its own to
  // scroll in. The page scrolls to reach it. Only classes differ from the small layout, so the
  // stage is not remounted and its visualizer keeps running through the switch.
  return (
    <div
      className={cx(
        '-mb-[106px] grid gap-x-[40px] gap-y-[24px] [--page-pad:60px] wide:[--page-pad:72px] max-phone:mb-0 max-phone:h-auto max-phone:grid-cols-1 max-phone:grid-rows-none',
        large
          ? 'grid-cols-1'
          : cx(
              nowPlayingScreenClassName,
              'grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] grid-rows-[minmax(0,1fr)]',
            ),
      )}
    >
      <NowPlayingWash art={artUrl(track)} />
      {/* Under the lyrics view the columns stay laid out, so the page is where it was on return,
          but `invisible` takes them out of sight, the tab order, the pointer and the accessibility
          tree. The wash is left showing through the view. */}
      <div
        className={cx(
          'flex min-w-0 flex-col gap-[16px]',
          large ? cx(nowPlayingScreenClassName, 'min-h-[520px]') : 'min-h-0',
          lyricsView && 'invisible',
        )}
      >
        <NowPlayingStage />
        <NowPlayingControls track={track} />
      </div>
      <NowPlayingTabs
        track={track}
        lyricsView={lyricsView}
        onLyricsView={setLyricsView}
        className={cx(
          large ? cx(nowPlayingScreenClassName, 'min-h-[420px]') : 'min-h-0',
          lyricsView && 'invisible',
        )}
      />
      <ShortcutsDialog open={help} onClose={closeHelp} />
    </div>
  )
}
