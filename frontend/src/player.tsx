import {
  createContext,
  type FormEvent,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { CSSProperties, ReactNode, SyntheticEvent } from 'react'

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useRouterState } from '@tanstack/react-router'
import {
  Check,
  ChevronDown,
  Disc3,
  Maximize2,
  Pause,
  Play,
  Plus,
  Repeat,
  RotateCcw,
  Shuffle,
  SkipBack,
  SkipForward,
  ThumbsUp,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'

import {
  api,
  libraryPlaylistDetailSchema,
  libraryPlaylistsSchema,
  playerQueueSchema,
  previewSchema,
} from './api'
import type { LibraryPlaylist, LibraryTrack, MusicResult } from './api'
import { cx } from './cx'
import {
  addToHistory,
  HISTORY_LISTEN_SECONDS,
  type HistoryEntry,
  readHistory,
  writeHistory,
} from './play-history'
import { levelledVolume, playsAlbumInOrder, replayGainMultiplier } from './replay-gain'
import { useReplayGainSettings } from './replay-gain-settings'
import { Button, ErrorBanner, Field, IconButton, iconButtonClassName } from './ui'

export type RepeatMode = 'off' | 'all' | 'one'
export type PreviewState = 'finding' | 'none' | 'ready'
export type LikedControl = {
  isLiked: boolean
  canToggle: boolean
  busy: boolean
  toggle: () => void
}
type Playback = {
  track: MusicResult | null
  libraryTrack: LibraryTrack | null
  queue: LibraryTrack[]
  /** Which collection filled the queue, so its own play button can show pause. */
  source: string
  currentIndex: number
  playing: boolean
  position: number
  length: number
  shuffle: boolean
  repeat: RepeatMode
  play: (track: MusicResult) => void
  playLibrary: (tracks: LibraryTrack[], index?: number, source?: string) => void
  shuffleLibrary: (tracks: LibraryTrack[], source?: string) => void
  /**
   * Queue edits. Each one saves the queue. The two that add say what happened in `notice`, and
   * refuse, adding nothing, when the queue would pass the 500 songs Navidrome keeps. Up next
   * announces the other three itself, where the listener made them.
   */
  playNext: (tracks: LibraryTrack[]) => void
  addToQueue: (tracks: LibraryTrack[]) => void
  removeFromQueue: (index: number) => void
  moveInQueue: (from: number, to: number) => void
  /** Empties the queue but for the track that is playing. */
  clearQueue: () => void
  /** Library tracks that played, newest first. Kept in this browser only. */
  history: readonly HistoryEntry[]
  clearHistory: () => void
  toggle: () => void
  next: () => void
  previous: () => void
  // Transport for the Now Playing popout. It reads the element's clock and
  // drives it through these; the element itself stays here.
  ready: boolean
  volume: number
  muted: boolean
  audio: () => HTMLAudioElement | null
  seek: (seconds: number) => void
  setVolume: (value: number) => void
  toggleMute: () => void
  toggleShuffle: () => void
  cycleRepeat: () => void
  liked: LikedControl
  previewState: (trackId: number) => PreviewState | undefined
  /** Opens the add-to-playlist sheet; a phone's mini player has no button of its own for it. */
  openPlaylistPicker: () => void
  /** The footer's status line. Now Playing hides the footer, so the page repeats it. */
  notice: string
  /** Empties the player, the footer's close button. Now Playing has one of its own. */
  stop: () => void
}
const PlayerContext = createContext<Playback>({
  track: null,
  libraryTrack: null,
  queue: [],
  source: '',
  currentIndex: -1,
  playing: false,
  position: 0,
  length: 0,
  shuffle: false,
  repeat: 'off',
  play: () => undefined,
  playLibrary: () => undefined,
  shuffleLibrary: () => undefined,
  playNext: () => undefined,
  addToQueue: () => undefined,
  removeFromQueue: () => undefined,
  moveInQueue: () => undefined,
  clearQueue: () => undefined,
  history: [],
  clearHistory: () => undefined,
  toggle: () => undefined,
  next: () => undefined,
  previous: () => undefined,
  ready: false,
  volume: 0.7,
  muted: false,
  audio: () => null,
  seek: () => undefined,
  setVolume: () => undefined,
  toggleMute: () => undefined,
  toggleShuffle: () => undefined,
  cycleRepeat: () => undefined,
  liked: { isLiked: false, canToggle: false, busy: false, toggle: () => undefined },
  previewState: () => undefined,
  openPlaylistPicker: () => undefined,
  notice: '',
  stop: () => undefined,
})
export const usePlayer = () => useContext(PlayerContext)

const LIBRARY_NOTICE = 'Your Navidrome library'
const RESTORED_NOTICE = 'Queue restored. Press play to continue.'
const QUEUE_SAVE_FAILED = 'The queue changed here but could not be saved.'

/** What Navidrome keeps in one saved play queue. The backend refuses more. */
export const QUEUE_LIMIT = 500
/** The queue's source once a listener has edited it: it is no longer any one collection. */
export const EDITED_SOURCE = 'queue'

/** Empty when `adding` more songs fit beside `size` already queued, else the reason they do not. */
export function queueOverflow(size: number, adding: number) {
  if (size + adding <= QUEUE_LIMIT) return ''
  return `The queue is full. Navidrome saves ${QUEUE_LIMIT} songs and this would make ${size + adding}. Nothing was added.`
}

/** Where the playing track sits after `from` moves to `to`, so a reorder never loses its place. */
export function indexAfterMove(current: number, from: number, to: number) {
  if (current === from) return to
  if (from < current && to >= current) return current - 1
  if (from > current && to <= current) return current + 1
  return current
}

/**
 * Where a Play next goes: straight after the playing track, but behind any songs already queued
 * that way, so two Play nexts play in the order they were chosen.
 */
export function playNextPosition(
  queue: readonly LibraryTrack[],
  current: number,
  chosen: ReadonlySet<LibraryTrack>,
) {
  let at = current + 1
  for (let item = queue[at]; item && chosen.has(item); item = queue[at]) at += 1
  return at
}

/**
 * The song shuffle plays next when one was chosen by hand: the nearest chosen song after the
 * playing one, else the first chosen song anywhere. -1 leaves it to chance.
 */
export function chosenIndex(
  queue: readonly LibraryTrack[],
  current: number,
  chosen: ReadonlySet<LibraryTrack>,
) {
  const at = queue.findIndex((item, index) => index > current && chosen.has(item))
  return at >= 0 ? at : queue.findIndex((item) => chosen.has(item))
}

// A queue entry is its own object, so a song queued twice is two rows with two keys. The key
// stays with the entry when it moves, which keeps focus and drag state on the right row.
const entryKeys = new WeakMap<LibraryTrack, number>()
let entryCount = 0
export function queueEntryKey(track: LibraryTrack) {
  let key = entryKeys.get(track)
  if (key === undefined) {
    entryCount += 1
    key = entryCount
    entryKeys.set(track, key)
  }
  return `${track.id}-${key}`
}

/**
 * The status lines that only say where the sound comes from or how the player woke up. The
 * footer shows them; Now Playing has the title, the source and a play button on screen already,
 * so it repeats only what is left: errors and confirmations.
 */
export const isPassiveNotice = (text: string) => text === LIBRARY_NOTICE || text === RESTORED_NOTICE

/** True while this exact collection owns the queue, so Play can become Pause. */
export function useCollectionPlayback(source: string) {
  const player = usePlayer()
  const active = Boolean(source) && player.source === source && Boolean(player.libraryTrack)
  return { active, playing: active && player.playing, toggle: player.toggle }
}

/** The same derived state for a catalog preview, which has no collection behind it. */
export function usePreviewPlayback(id: number) {
  const player = usePlayer()
  const active = !player.libraryTrack && player.track?.id === id
  return { active, playing: active && player.playing }
}

export type PlaylistSongChange = { playlistId: string; songId?: string; index?: number }

/**
 * Adding and removing playlist songs, shared by the footer picker and the playlist page so
 * the cache writes that keep them in step cannot drift apart.
 *
 * Removal is positional, so a control must stay disabled while any change to its playlist is
 * in flight: a second click would send an index measured against the pre-change list and
 * delete the wrong song. One mutation serves every row, and its own `variables` only ever
 * describe the newest call, so in-flight playlists are counted here instead.
 */
export function usePlaylistSongs() {
  const client = useQueryClient()
  const [inFlight, setInFlight] = useState<Record<string, number>>({})
  const count = (playlistId: string, delta: number) =>
    setInFlight((counts) => ({
      ...counts,
      [playlistId]: Math.max(0, (counts[playlistId] ?? 0) + delta),
    }))
  const mutation = useMutation({
    mutationFn: ({ playlistId, songId, index }: PlaylistSongChange) =>
      api(
        `library/playlists/${encodeURIComponent(playlistId)}/songs`,
        libraryPlaylistDetailSchema,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            songId === undefined ? { song_index_to_remove: index } : { song_id_to_add: songId },
          ),
        },
      ),
    onMutate: (change) => count(change.playlistId, 1),
    onSettled: (_playlist, _error, change) => count(change.playlistId, -1),
    onSuccess: (playlist) => {
      client.setQueryData(['library-playlist', playlist.id], playlist)
      // The liked playlist is also read under its own key. Write both, or the thumbs up
      // re-enables against a stale list and its next click removes a different song.
      if (client.getQueryData<LibraryPlaylist>(['library-playlist-liked'])?.id === playlist.id)
        client.setQueryData(['library-playlist-liked'], playlist)
      void client.invalidateQueries({ queryKey: ['library-playlists'] })
      void client.invalidateQueries({ queryKey: ['library-playlist-liked'] })
    },
  })
  return { mutation, busy: (playlistId: string) => (inFlight[playlistId] ?? 0) > 0 }
}

export const durationText = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

// One request per row is fine for a picker; filter the list to reach the rest.
const PICKER_ROWS = 25

/* `live-player` carries no styling of its own. It is the hook the player, playlist and popout
   specs use, and the one the leftover seek-bar rules in style.css hang off. The idle footer is
   hidden on a phone where it is rendered, not here. */
const footerClassName = cx(
  'live-player fixed right-[var(--safe-right)] bottom-0 left-[calc(var(--sidebar-width)+var(--safe-left))] z-bar flex h-[75px] items-center justify-between gap-[20px] border-t border-line-strong bg-raised px-[33px]',
  'max-tablet:gap-[10px] max-tablet:px-[16px]',
  'max-phone:right-0 max-phone:bottom-[calc(var(--nav-height)+var(--safe-bottom))] max-phone:left-0 max-phone:h-auto max-phone:min-h-[60px] max-phone:gap-[6px] max-phone:pt-[10px] max-phone:pr-[calc(12px+var(--safe-right))] max-phone:pb-[8px] max-phone:pl-[calc(12px+var(--safe-left))]',
)

export const songCount = (count: number) => `${count} ${count === 1 ? 'song' : 'songs'}`

export const artUrl = (track: LibraryTrack) =>
  track.coverArt ? `/api/player/art/${encodeURIComponent(track.coverArt)}` : ''

// The visualizer tree loads on demand so the main bundle stays as it is.
const audioGraph = () => import('visimo/audio')

// Elements whose sound already reaches the analyser. A media element can be given to
// `createMediaElementSource` once only, so each is remembered for good.
const routed = new WeakSet<HTMLMediaElement>()

/**
 * Sends a library element's sound through the visualizer's analyser. Call it from the element's
 * `play` event. visimo's `attachAudio` builds the graph and wires up the first element it is given,
 * and refuses any other, because it was written for one element. Gapless playback has two that
 * swap roles, so the second is connected here, to the same analyser, the first time it plays.
 * Without this the stage goes flat on every other track while the music carries on. Only ever
 * called for the library pair: a preview's cross-origin audio would be silenced for good.
 */
async function routeToAnalyser(element: HTMLMediaElement) {
  const module = await audioGraph()
  const wasAttached = module.audioGraph()?.attached ?? false
  const graph = await module.attachAudio(element)
  if (!graph || routed.has(element)) return
  if (!wasAttached && graph.attached) {
    // visimo took this one itself.
    routed.add(element)
    return
  }
  // Nothing is wired up until the context runs, and visimo goes first so its own state stays
  // true. The next play tries again.
  if (!graph.attached || graph.context.state !== 'running') return
  routed.add(element)
  graph.context.createMediaElementSource(element).connect(graph.analyser)
}

/** How long before a track ends the next one starts loading. A shorter track loads it at once. */
export const PRELOAD_LEAD_SECONDS = 15
/** Tracks that may fail one after another before playback stops, rather than racing the queue. */
export const MAX_FAILURES = 3
// The next track starts this long before the current one ends: about what a buffered element
// takes to put sound out. Later leaves a gap, earlier an overlap.
const HANDOVER_LEAD_MS = 40
// Inside this window the handover is timed. Outside it, or where a timer runs late, the `ended`
// event does it, which is the safe route and a few milliseconds slower.
const HANDOVER_WINDOW_SECONDS = 1
// A stream's own length can differ from the library's. Past this the timed handover would cut a
// track short, so `ended` decides instead.
const LENGTH_TOLERANCE_SECONDS = 2

/** True once the next track should be loading: the last seconds of a track, all of a short one. */
export const preloadDue = (length: number, time: number) =>
  length > 0 && length - time <= PRELOAD_LEAD_SECONDS

export const skippedNotice = (title: string) => `Skipped ${title}, it could not be played`
export const failureLimitNotice = `Stopped after ${MAX_FAILURES} tracks in a row could not be played. Check the connection to Navidrome.`

const streamUrl = (track: LibraryTrack) => `/api/player/stream/${encodeURIComponent(track.id)}`

const secondsLeft = (element: HTMLAudioElement) =>
  Number.isFinite(element.duration) ? element.duration - element.currentTime : Infinity

// Not in every browser's Navigator type. A true `saveData` is the listener asking not to spend
// data on things they have not asked for.
const dataSaverOn = () =>
  (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true

/** Which of the two library elements. One plays while the other holds the next track. */
type Slot = 0 | 1
type Preload = { index: number; item: LibraryTrack; slot: Slot; failed: boolean }

export function stored(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

export function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* Browser storage is optional. */
  }
}

const pickerNoteClassName = 'mt-[6px] mb-[2px] text-muted'

function PlaylistPickerRow({
  playlist,
  songs,
  failed,
  onRetry,
  trackId,
  trackTitle,
  busy,
  blocked,
  expanded,
  onExpand,
  onToggleTrack,
  onRemoveSong,
}: {
  playlist: LibraryPlaylist
  songs?: LibraryTrack[]
  failed: boolean
  onRetry: () => void
  trackId: string
  trackTitle: string
  busy: boolean
  blocked: boolean
  expanded: boolean
  onExpand: (open: boolean) => void
  onToggleTrack: () => void
  onRemoveSong: (index: number) => void
}) {
  const known = songs !== undefined
  const index = (songs ?? []).findIndex((item) => item.id === trackId)
  const member = index >= 0
  const label = busy ? 'Saving…' : !known ? 'Loading…' : member ? 'Remove' : 'Add'
  return (
    <div className="playlist-picker-row rounded-[8px] border border-line bg-raised px-[10px] py-[8px]">
      <div className="flex items-center justify-between gap-[10px]">
        <IconButton
          size="compact"
          aria-label={`${expanded ? 'Hide' : 'Show'} songs in ${playlist.name}`}
          aria-expanded={expanded}
          onClick={() => onExpand(!expanded)}
        >
          <ChevronDown
            size={16}
            className={cx(
              'transition-transform duration-[140ms] ease-[ease]',
              expanded && 'rotate-180',
            )}
          />
        </IconButton>
        {/* Blocks, not grids: text-overflow only cuts text that sits directly in a block box. */}
        <span className="block min-w-0 flex-1 truncate">
          {playlist.name}
          <small className="mt-[2px] block text-tiny text-muted">
            {songCount((known ? songs.length : playlist.songCount) ?? 0)}
          </small>
        </span>
        {failed ? (
          <Button className="shrink-0" onClick={onRetry}>
            Retry
          </Button>
        ) : (
          <Button
            className="shrink-0"
            variant={member ? 'default' : 'primary'}
            // Membership decides the action, so the label has to wait for the song list.
            aria-label={
              known
                ? `${member ? 'Remove' : 'Add'} ${trackTitle} ${member ? 'from' : 'to'} ${playlist.name}`
                : `Loading songs in ${playlist.name}`
            }
            disabled={busy || blocked || !known}
            onClick={onToggleTrack}
          >
            {member && known && !busy && <Check size={14} />}
            {!member && known && !busy && <Plus size={14} />} {label}
          </Button>
        )}
      </div>
      {expanded && (
        <div className="playlist-picker-songs mt-[8px] grid max-h-[190px] grid-cols-[minmax(0,1fr)] gap-[4px] overflow-y-auto overscroll-contain border-t border-line pt-[8px]">
          {(songs ?? []).map((song, songIndex) => (
            <div
              key={`${song.id}-${songIndex}`}
              className="flex items-center justify-between gap-[8px] px-[2px] py-[4px] text-small"
            >
              <span className="block min-w-0 truncate">
                {song.title}
                <small className="mt-[5px] block text-tiny text-muted">{song.artist}</small>
              </span>
              <IconButton
                size="compact"
                aria-label={`Remove ${song.title} from ${playlist.name}`}
                disabled={busy}
                onClick={() => onRemoveSong(songIndex)}
              >
                <X size={14} />
              </IconButton>
            </div>
          ))}
          {known && !songs.length && <p className={pickerNoteClassName}>This playlist is empty.</p>}
          {failed && <ErrorBanner>That playlist could not be read.</ErrorBanner>}
          {!known && !failed && <p role="status">Loading songs…</p>}
        </div>
      )}
    </div>
  )
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  // One element for previews and two for the library. Previews stream from the provider's CDN
  // without CORS headers, and the Web Audio analyser the visualizer needs would silence such media
  // for good, so only the library elements ever feed it. The library pair swap roles: one plays
  // while the other loads the next track, so a track can start the moment the last one ends.
  const previewAudio = useRef<HTMLAudioElement>(null)
  const libraryA = useRef<HTMLAudioElement>(null)
  const libraryB = useRef<HTMLAudioElement>(null)
  const activeSlot = useRef<Slot>(0)
  // What the standby element is loading, and whether that failed.
  const preload = useRef<Preload | null>(null)
  const handoverTimer = useRef<number | undefined>(undefined)
  // Library tracks in a row that failed to load. Any track that starts playing clears it.
  const failures = useRef(0)
  // Whether the loaded track was meant to start, so a skip past a broken one on a restored queue
  // does not begin playing when the page opens.
  const wantPlay = useRef(true)
  // Set when the browser refuses to start the standby element from a script (iOS does, until an
  // element has been started by a tap). The player then loads each track into one element as before.
  const standbyBlocked = useRef(false)
  const request = useRef<AbortController | null>(null)
  const previewCurrent = useRef<MusicResult | null>(null)
  const libraryCurrent = useRef<LibraryTrack | null>(null)
  const queueRef = useRef<LibraryTrack[]>([])
  const indexRef = useRef(-1)
  const sourceRef = useRef('')
  // Entries the listener queued by hand, which shuffle plays before the rest. Each entry is its
  // own copy of the song, so the set can tell a song queued twice apart.
  const chosen = useRef(new Set<LibraryTrack>())
  const mode = useRef<'preview' | 'library'>('preview')
  const slots = () => [libraryA.current, libraryB.current] as const
  const library = () => slots()[activeSlot.current]
  const standby = () => slots()[activeSlot.current === 0 ? 1 : 0]
  const current = () => (mode.current === 'library' ? library() : previewAudio.current)
  const elements = () => [previewAudio.current, libraryA.current, libraryB.current]

  // Marks which element is which, for the e2e specs and for anyone inspecting the page.
  function activate(slot: Slot) {
    activeSlot.current = slot
    slots().forEach((element, at) => {
      if (element) element.dataset.role = at === slot ? 'active' : 'standby'
    })
  }

  // What an element's `volume` should be: the person's setting times the ReplayGain of the track it
  // holds, so the slider keeps reading what they set. The standby element is levelled for the
  // track it has preloaded. Null is "leave it": a standby element with nothing loaded may be the
  // one finishing its last moments, and changing its volume then would be heard.
  function outputVolume(element: HTMLAudioElement | null): number | null {
    const { volume: set, shuffle: shuffled, replay } = levelling.current
    const base = Number.isFinite(set) ? Math.max(0, Math.min(1, set)) : 0.7
    if (!element || element === previewAudio.current) return base
    const slot: Slot = element === libraryA.current ? 0 : 1
    let target: { item: LibraryTrack | null; index: number } | null = null
    if (slot === activeSlot.current) {
      target = { item: libraryCurrent.current, index: indexRef.current }
    } else if (preload.current?.slot === slot) {
      target = preload.current
    }
    if (!target) return null
    if (!target.item) return base
    const inOrder = playsAlbumInOrder(queueRef.current, target.index, shuffled)
    const multiplier = replayGainMultiplier(
      target.item.replayGain,
      replay.mode,
      inOrder,
      replay.preampDb,
    )
    return levelledVolume(base, multiplier)
  }

  function applyVolume() {
    for (const element of elements()) {
      if (!element) continue
      const level = outputVolume(element)
      if (level !== null) element.volume = level
      element.muted = levelling.current.muted
    }
  }

  const previewStage = useRef(0)
  const pendingSeek = useRef(0)
  const lastSavedSecond = useRef(-1)
  // Whether the loaded library track has been written to the history yet.
  const recorded = useRef(false)
  const historyRef = useRef<readonly HistoryEntry[]>(readHistory())
  const footerRef = useRef<HTMLElement>(null)
  const [track, setTrack] = useState<MusicResult | null>(null)
  const [libraryTrack, setLibraryTrack] = useState<LibraryTrack | null>(null)
  const [queue, setQueue] = useState<LibraryTrack[]>([])
  const [history, setHistory] = useState(historyRef.current)
  const [source, setSource] = useState('')
  const [currentIndex, setCurrentIndex] = useState(-1)
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [length, setLength] = useState(30)
  const [ready, setReady] = useState(false)
  const [volume, setVolume] = useState(() => Number(stored('musimo.player-volume', '0.7')))
  const [muted, setMuted] = useState(false)
  const [shuffle, setShuffle] = useState(() => stored('musimo.player-shuffle', 'false') === 'true')
  const [repeat, setRepeat] = useState<RepeatMode>(() => {
    const value = stored('musimo.player-repeat', 'off')
    return value === 'all' || value === 'one' ? value : 'off'
  })
  const [notice, setNotice] = useState('Choose a track to start listening.')
  const replaySettings = useReplayGainSettings()
  // What the volume needs, kept where the functions below (some run from timers and one-off
  // effects) read the latest of it rather than the render they were made in.
  const levelling = useRef({ volume, muted, shuffle, replay: replaySettings })
  levelling.current = { volume, muted, shuffle, replay: replaySettings }
  const [playlistSearch, setPlaylistSearch] = useState('')
  const [newPlaylistName, setNewPlaylistName] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [expandedPlaylist, setExpandedPlaylist] = useState('')
  const [previewStates, setPreviewStates] = useState<Map<number, PreviewState>>(new Map())
  const playlistDialog = useRef<HTMLDialogElement>(null)
  const queryClient = useQueryClient()

  const isLibraryTrack = Boolean(libraryTrack)
  const likedPlaylist = useQuery({
    queryKey: ['library-playlist-liked'],
    queryFn: ({ signal }) =>
      api('library/playlists/liked', libraryPlaylistDetailSchema, { signal }),
    enabled: isLibraryTrack,
  })
  const allPlaylists = useQuery({
    queryKey: ['library-playlists'],
    queryFn: ({ signal }) => api('library/playlists', libraryPlaylistsSchema, { signal }),
    enabled: isLibraryTrack,
  })
  const playlistSearchTerms = playlistSearch.trim().toLocaleLowerCase()
  // The list response carries the liked id, so the thumbs-up playlist never flashes into the
  // picker while its own query is still loading.
  const likedId = allPlaylists.data?.liked_id || likedPlaylist.data?.id
  const matchingPlaylists = (allPlaylists.data?.items ?? [])
    .filter((playlist) => playlist.id !== likedId)
    .filter((playlist) =>
      playlistSearchTerms ? playlist.name.toLocaleLowerCase().includes(playlistSearchTerms) : true,
    )
  const availablePlaylists = matchingPlaylists.slice(0, PICKER_ROWS)
  // Membership decides whether a row offers Add or Remove, so the picker needs each
  // playlist's songs. Only the rows actually on show are fetched, and only while the
  // picker is open. They share the playlist page's cache key, so a change here shows
  // there without a reload.
  const playlistDetails = useQueries({
    queries: availablePlaylists.map((playlist) => ({
      queryKey: ['library-playlist', playlist.id],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api(`library/playlists/${encodeURIComponent(playlist.id)}`, libraryPlaylistDetailSchema, {
          signal,
        }),
      enabled: pickerOpen,
    })),
  })
  const songsByPlaylist = new Map(
    playlistDetails.flatMap((result) =>
      result.data ? [[result.data.id, result.data.entry] as const] : [],
    ),
  )
  const failedPlaylists = new Set(
    availablePlaylists.flatMap((playlist, at) =>
      playlistDetails[at]?.isError ? [playlist.id] : [],
    ),
  )
  const likedIndex = isLibraryTrack
    ? (likedPlaylist.data?.entry ?? []).findIndex((item) => item.id === libraryTrack?.id)
    : -1
  const isLiked = likedIndex >= 0
  const playlistSongs = usePlaylistSongs()
  const createPlaylist = useMutation({
    mutationFn: (name: string) =>
      api('library/playlists', libraryPlaylistDetailSchema, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          song_ids: libraryTrack ? [libraryTrack.id] : [],
        }),
      }),
    onSuccess: (playlist) => {
      void queryClient.invalidateQueries({ queryKey: ['library-playlists'] })
      if (playlist.id) setNotice(`Created playlist ${playlist.name}.`)
      setNewPlaylistName('')
      closePlaylistDialog()
    },
  })

  async function loadPreview(item: MusicResult, fallback: boolean) {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setNotice('Finding preview…')
    setPreviewStates((prev) => new Map(prev).set(item.id, 'finding'))
    try {
      const clip = await api(`preview/${item.id}?fallback=${fallback}`, previewSchema, {
        signal: controller.signal,
      })
      if (controller.signal.aborted || previewCurrent.current?.id !== item.id) return
      if (!clip.url) {
        setNotice('No preview available for this track.')
        setPreviewStates((prev) => new Map(prev).set(item.id, 'none'))
        return
      }
      setNotice(`${clip.source} preview`)
      setPreviewStates((prev) => new Map(prev).set(item.id, 'ready'))
      startAudio(clip.url)
    } catch (error) {
      if (!controller.signal.aborted) {
        setNotice(error instanceof Error ? error.message : 'Preview unavailable')
      }
    }
  }

  function startAudio(url: string, autoplay = true) {
    const element = current()
    if (!element) return
    element.src = url
    setReady(false)
    if (!autoplay) return
    element.play().catch((error: unknown) => {
      // Only a refusal to start is the listener's to act on. A source that would not load rejects
      // too, after its error event has already skipped the song and said so, and a newer load
      // aborts the old one's play; saying "press play" over either would bury the real message.
      if (element.src !== new URL(url, location.href).href) return
      if (error instanceof DOMException && error.name !== 'NotAllowedError') return
      setNotice('Press play when you are ready.')
    })
  }

  // `announce` is for an edit the listener just made: it is the one save whose failure they need
  // to hear about, since the queue on screen would then differ from the one that restores.
  function saveQueue(announce = false) {
    if (mode.current !== 'library' || !libraryCurrent.current) return
    fetch('/api/player/queue', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: queueRef.current.map((item) => item.id),
        current: libraryCurrent.current.id,
        position: Math.round((library()?.currentTime ?? 0) * 1000),
      }),
    })
      .then((response) => {
        if (announce && !response.ok) setNotice(QUEUE_SAVE_FAILED)
      })
      .catch(() => {
        if (announce) setNotice(QUEUE_SAVE_FAILED)
      })
  }

  function scrobble(submission: boolean) {
    const item = libraryCurrent.current
    if (!item) return
    void fetch('/api/player/scrobble', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, submission }),
    })
  }

  // Called once a track has been heard: past HISTORY_LISTEN_SECONDS, or through to its end when it
  // is shorter than that. Once per load, so timeupdate can call it freely.
  function recordPlay() {
    const item = libraryCurrent.current
    if (!item || recorded.current) return
    recorded.current = true
    const next = addToHistory(historyRef.current, item, Date.now())
    if (next === historyRef.current) return
    historyRef.current = next
    setHistory(next)
    writeHistory(next)
  }

  function clearHistory() {
    historyRef.current = []
    setHistory([])
    writeHistory([])
  }

  // The browser's Media Session shows a position for the lock screen and media keys. A browser
  // that rejects the numbers keeps the last it had, which is fine for a hint.
  function publishPosition(element: HTMLAudioElement) {
    if (!('mediaSession' in navigator) || !Number.isFinite(element.duration)) return
    try {
      navigator.mediaSession.setPositionState({
        duration: element.duration,
        position: Math.min(element.currentTime, element.duration),
        playbackRate: element.playbackRate,
      })
    } catch {
      /* A hint only. */
    }
  }

  // Which queue index plays after the playing one, or -1 at the end of the queue. Shuffle plays
  // the songs queued by hand first, in order, then chooses at random.
  function nextIndex() {
    const queue = queueRef.current
    if (shuffle && queue.length > 1) {
      const chosenAt = chosenIndex(queue, indexRef.current, chosen.current)
      if (chosenAt >= 0) return chosenAt
      let index: number
      do index = Math.floor(Math.random() * queue.length)
      while (index === indexRef.current)
      return index
    }
    const index = indexRef.current + 1
    if (index >= queue.length && repeat === 'all') return 0
    return index < queue.length ? index : -1
  }

  // Forgets what the standby element was loading and stops it downloading. Anything that changes
  // what plays next (an edit, shuffle, repeat) calls this; the next timeupdate loads the new pick.
  function discardPreload() {
    window.clearTimeout(handoverTimer.current)
    if (!preload.current) return
    preload.current = null
    const element = standby()
    element?.removeAttribute('src')
    element?.load()
  }

  // Runs on the playing element's timeupdate. Once the end is close, decides what plays next and
  // loads it into the standby element. That decision is kept, because shuffle's pick is random
  // and the handover has to play the song that was loaded.
  function ensurePreload(active: HTMLAudioElement) {
    const item = libraryCurrent.current
    const element = standby()
    if (!item || !element || standbyBlocked.current) return
    const length = Number.isFinite(active.duration) ? active.duration : item.duration || 0
    if (!preloadDue(length, active.currentTime)) return
    const held = preload.current
    if (held && held.item === queueRef.current[held.index]) return
    discardPreload()
    // Repeat one plays the same song again, and loading it early makes that gapless too.
    const index = repeat === 'one' ? indexRef.current : nextIndex()
    const upcoming = queueRef.current[index]
    if (!upcoming) return
    const slot: Slot = activeSlot.current === 0 ? 1 : 0
    preload.current = { index, item: upcoming, slot, failed: false }
    // A metered connection gets the metadata only. The song then starts as it always did.
    element.preload = dataSaverOn() ? 'metadata' : 'auto'
    element.src = streamUrl(upcoming)
    applyVolume()
  }

  // Starts the standby element just before the playing one ends. Called on every timeupdate, so a
  // seek or a pause cancels it by the next one.
  function scheduleHandover(active: HTMLAudioElement) {
    window.clearTimeout(handoverTimer.current)
    const item = libraryCurrent.current
    const held = preload.current
    if (!item || !held || held.failed || active.paused) return
    const left = secondsLeft(active)
    if (left > HANDOVER_WINDOW_SECONDS) return
    if (item.duration > 0 && Math.abs(active.duration - item.duration) > LENGTH_TOLERANCE_SECONDS)
      return
    handoverTimer.current = window.setTimeout(
      () => {
        if (libraryCurrent.current === item && library() === active) finishTrack(active)
      },
      Math.max(0, left * 1000 - HANDOVER_LEAD_MS),
    )
  }

  // A track has played to its end, or is about to. Its listen is reported and the next one starts.
  function finishTrack(finished: HTMLAudioElement) {
    window.clearTimeout(handoverTimer.current)
    // A track shorter than the listening threshold never reaches it, so its end counts. A
    // longer one that was scrubbed to its end without playing does not.
    if (finished.duration <= HISTORY_LISTEN_SECONDS) recordPlay()
    scrobble(true)
    if (repeat === 'one') loadLibrary(indexRef.current)
    else next()
  }

  // A library track would not load or play. Skips to the next and says which, until too many in a
  // row have failed, which more likely means Navidrome is out of reach than that every song is bad.
  function skipUnplayable() {
    const failed = libraryCurrent.current
    if (!failed) return
    failures.current += 1
    if (failures.current >= MAX_FAILURES) {
      failures.current = 0
      setNotice(failureLimitNotice)
      return
    }
    next(wantPlay.current)
    setNotice(skippedNotice(failed.title))
  }

  function loadLibrary(index: number, autoplay = true, seek = 0) {
    const item = queueRef.current[index]
    if (!item) return
    request.current?.abort()
    window.clearTimeout(handoverTimer.current)
    // The standby element already holds this song: hand over to it instead of loading it again.
    const held = preload.current
    const handOverTo: Slot | null =
      held && autoplay && seek === 0 && !held.failed && held.index === index && held.item === item
        ? held.slot
        : null
    const handOver = handOverTo !== null
    const outgoingSlot = activeSlot.current
    const outgoing = library()
    if (handOverTo !== null) activate(handOverTo)
    // Only one of the two plays at a time. The other element's pause event is
    // ignored once the mode has changed, so the state is set here instead. A track handed over
    // at its very end is left to finish its last moments rather than cut off.
    const finishing = handOver && outgoing && secondsLeft(outgoing) <= HANDOVER_WINDOW_SECONDS / 2
    for (const element of elements()) {
      if (handOver && element === library()) continue
      if (finishing && element === outgoing) continue
      element?.pause()
    }
    setPlaying(false)
    mode.current = 'library'
    previewCurrent.current = null
    libraryCurrent.current = item
    wantPlay.current = autoplay
    chosen.current.delete(item)
    indexRef.current = index
    pendingSeek.current = seek
    lastSavedSecond.current = -1
    recorded.current = false
    setTrack(null)
    setLibraryTrack(item)
    setCurrentIndex(index)
    setPosition(seek)
    setLength(item.duration || 0)
    setNotice(LIBRARY_NOTICE)
    if (!handOver) {
      discardPreload()
      applyVolume()
      startAudio(streamUrl(item), autoplay)
      return
    }
    const incoming = library()
    if (!incoming) return
    preload.current = null
    applyVolume()
    // Its metadata and length arrived while it was standby, and those events were not ours to act
    // on then.
    setReady(incoming.readyState >= HTMLMediaElement.HAVE_METADATA)
    if (Number.isFinite(incoming.duration)) setLength(incoming.duration)
    publishPosition(incoming)
    incoming.play().catch((error: unknown) => {
      if (library() !== incoming) return
      // A pause or another load cut this start short. That is not a refusal.
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        // The browser will not start this element from a script. Go back to the one that will.
        standbyBlocked.current = true
        activate(outgoingSlot)
        incoming.removeAttribute('src')
        incoming.load()
        applyVolume()
        startAudio(streamUrl(item))
        return
      }
      setNotice('Press play when you are ready.')
    })
  }

  function playLibrary(items: LibraryTrack[], index = 0, origin = '') {
    if (!items.length) return
    failures.current = 0
    // Playing a row of the queue itself keeps the queue, and what was chosen by hand in it.
    if (items !== queueRef.current) chosen.current.clear()
    queueRef.current = items
    sourceRef.current = origin
    setQueue(items)
    setSource(origin)
    loadLibrary(Math.max(0, Math.min(index, items.length - 1)))
  }

  // Every edit lands here: the new order, where the playing track now sits, and the save. An
  // edited queue is no longer the album or playlist it began as, so it stops claiming to be one.
  function editQueue(items: LibraryTrack[], index: number) {
    queueRef.current = items
    indexRef.current = index
    sourceRef.current = EDITED_SOURCE
    // What plays next may have changed, so what the standby element loaded may be wrong.
    discardPreload()
    setQueue(items)
    setCurrentIndex(index)
    setSource(EDITED_SOURCE)
    saveQueue(true)
  }

  function enqueue(tracks: LibraryTrack[], upNext: boolean) {
    if (!tracks.length) return
    const inQueue = libraryCurrent.current ? queueRef.current.length : 0
    const refusal = queueOverflow(inQueue, tracks.length)
    if (refusal) {
      setNotice(refusal)
      return
    }
    const entries = tracks.map((track) => ({ ...track }))
    // With nothing loaded there is no queue to join, so these songs become it.
    if (!libraryCurrent.current) {
      playLibrary(entries, 0, EDITED_SOURCE)
      return
    }
    for (const entry of entries) chosen.current.add(entry)
    const queue = queueRef.current
    const at = upNext ? playNextPosition(queue, indexRef.current, chosen.current) : queue.length
    editQueue([...queue.slice(0, at), ...entries, ...queue.slice(at)], indexRef.current)
    const what = entries.length === 1 ? (entries[0]?.title ?? 'song') : songCount(entries.length)
    setNotice(upNext ? `Playing ${what} next.` : `Added ${what} to the queue.`)
  }

  const playNext = (tracks: LibraryTrack[]) => enqueue(tracks, true)
  const addToQueue = (tracks: LibraryTrack[]) => enqueue(tracks, false)

  function removeFromQueue(index: number) {
    const queue = queueRef.current
    const removed = queue[index]
    // The playing track is not Up next's to remove; skipping it is the way past it.
    if (!libraryCurrent.current || !removed || index === indexRef.current) return
    chosen.current.delete(removed)
    editQueue(
      queue.filter((_, at) => at !== index),
      index < indexRef.current ? indexRef.current - 1 : indexRef.current,
    )
  }

  function moveInQueue(from: number, to: number) {
    const queue = queueRef.current
    const moved = queue[from]
    if (!libraryCurrent.current || !moved || from === to || to < 0 || to >= queue.length) return
    const items = queue.filter((_, at) => at !== from)
    items.splice(to, 0, moved)
    editQueue(items, indexAfterMove(indexRef.current, from, to))
  }

  function clearQueue() {
    const playing = libraryCurrent.current
    if (!playing) return
    chosen.current.clear()
    editQueue([playing], 0)
  }

  function shuffleLibrary(items: LibraryTrack[], origin = '') {
    if (!items.length) return
    setShuffle(true)
    playLibrary(items, Math.floor(Math.random() * items.length), origin)
  }

  function toggle() {
    const element = current()
    const hasItem = mode.current === 'library' ? libraryCurrent.current : previewCurrent.current
    if (!element || !hasItem) return
    if (!element.paused) element.pause()
    else if (element.getAttribute('src'))
      void element.play().catch(() => setNotice('Cannot play this track.'))
    else if (previewCurrent.current) {
      previewStage.current = 1
      void loadPreview(previewCurrent.current, false)
    }
  }

  function play(item: MusicResult) {
    if (
      mode.current === 'preview' &&
      previewCurrent.current?.id === item.id &&
      previewAudio.current?.src
    ) {
      toggle()
      return
    }
    request.current?.abort()
    for (const element of elements()) element?.pause()
    discardPreload()
    setPlaying(false)
    mode.current = 'preview'
    libraryCurrent.current = null
    previewCurrent.current = item
    setLibraryTrack(null)
    setTrack(item)
    setPosition(0)
    setLength(30)
    previewStage.current = item.preview ? 0 : 1
    if (item.preview) {
      setNotice('Deezer preview')
      setPreviewStates((prev) => new Map(prev).set(item.id, 'ready'))
      startAudio(item.preview)
    } else void loadPreview(item, false)
  }

  function next(autoplay = true) {
    if (mode.current !== 'library' || !queueRef.current.length) return
    // The standby element may already hold the pick. Repeat one preloads the same song again,
    // which is not where a skip goes, so it chooses afresh.
    const held = repeat === 'one' ? null : preload.current
    const index = held && held.item === queueRef.current[held.index] ? held.index : nextIndex()
    if (index >= 0) loadLibrary(index, autoplay)
    else setPlaying(false)
  }

  function previous() {
    if (mode.current !== 'library') return
    const playing = library()
    if (playing && playing.currentTime > 4) {
      playing.currentTime = 0
      return
    }
    loadLibrary(Math.max(0, indexRef.current - 1))
  }

  const audioElement = useCallback(() => current(), [])

  function seek(seconds: number) {
    const element = current()
    if (element) element.currentTime = seconds
    setPosition(seconds)
  }

  function changeVolume(value: number) {
    setVolume(value)
    setMuted(false)
  }

  function toggleMute() {
    setMuted(!muted)
  }

  function toggleShuffle() {
    setShuffle(!shuffle)
  }

  function cycleRepeat() {
    setRepeat(repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off')
  }

  function stop() {
    request.current?.abort()
    saveQueue()
    window.clearTimeout(handoverTimer.current)
    preload.current = null
    failures.current = 0
    previewCurrent.current = null
    libraryCurrent.current = null
    sourceRef.current = ''
    setSource('')
    for (const element of elements()) {
      element?.pause()
      element?.removeAttribute('src')
      element?.load()
    }
    setTrack(null)
    setLibraryTrack(null)
    setPlaying(false)
    setReady(false)
    setPosition(0)
    setNotice('Choose a track to start listening.')
  }

  useEffect(() => {
    void api('player/queue', playerQueueSchema)
      .then((saved) => {
        if (!saved.entry.length) return
        const index = Math.max(
          0,
          saved.entry.findIndex((item) => item.id === saved.current),
        )
        queueRef.current = saved.entry
        setQueue(saved.entry)
        sourceRef.current = 'restored'
        setSource('restored')
        loadLibrary(index, false, saved.position / 1000)
        setNotice(RESTORED_NOTICE)
      })
      .catch(() => undefined)
  }, [])

  // Also re-runs when what the gain depends on changes: the setting, shuffle (album gain needs the
  // album in order), and the queue or position in it.
  useEffect(() => {
    applyVolume()
    const value = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.7
    remember('musimo.player-volume', String(value))
  }, [volume, muted, replaySettings, shuffle, queue, currentIndex, libraryTrack])

  // Browsers suspend the audio context while a tab is hidden for a while, or on
  // iOS when another app takes the output. Wake it when the tab comes back.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || mode.current !== 'library') return
      if (library() && !library()?.paused) void audioGraph().then((module) => module.resumeAudio())
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  useEffect(() => activate(0), [])

  useEffect(() => {
    remember('musimo.player-shuffle', String(shuffle))
    remember('musimo.player-repeat', repeat)
    // What plays next depends on both, so a song loaded for the old choice is dropped.
    discardPreload()
  }, [shuffle, repeat])

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.ctrlKey || event.metaKey || event.altKey) return
      if (
        event.target instanceof HTMLElement &&
        (event.target.matches('input,textarea,select,button,a') || event.target.isContentEditable)
      )
        return
      if (previewCurrent.current || libraryCurrent.current) {
        event.preventDefault()
        toggle()
      }
    }
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('keydown', key)
      request.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (!libraryTrack || !('mediaSession' in navigator)) return
    navigator.mediaSession.metadata = new MediaMetadata({
      title: libraryTrack.title,
      artist: libraryTrack.artist,
      album: libraryTrack.album,
      artwork: artUrl(libraryTrack) ? [{ src: artUrl(libraryTrack) }] : [],
    })
    navigator.mediaSession.setActionHandler('play', toggle)
    navigator.mediaSession.setActionHandler('pause', toggle)
    navigator.mediaSession.setActionHandler('nexttrack', () => next())
    navigator.mediaSession.setActionHandler('previoustrack', previous)
  }, [libraryTrack, shuffle, repeat])

  const activeTitle = libraryTrack?.title ?? track?.title
  const activeArtist = libraryTrack?.artist ?? track?.artist
  const activeAlbum = libraryTrack?.album ?? track?.album
  const activeArt = libraryTrack ? artUrl(libraryTrack) : track?.art
  const isLibrary = Boolean(libraryTrack)
  const seekMax = length || 30
  // The phone mini player draws the seek bar's played portion from this, since WebKit has no
  // pseudo-element for a range's progress.
  const seekStyle = {
    '--progress': `${Math.min(100, (Math.min(position, seekMax) / seekMax) * 100).toFixed(2)}%`,
  } as CSSProperties

  // The Now Playing page has every control the footer has (like, add to playlist, seek, the
  // transport, shuffle, repeat, volume and close) and shows the title, so the footer stands down
  // beside it at every width. Without a library track the page is empty, and a preview's only
  // controls are the footer's, so it stays.
  const onStage = useRouterState({ select: (state) => state.location.pathname === '/now-playing' })
  const hidden = onStage && isLibrary

  useEffect(() => {
    const footer = footerRef.current
    if (!footer) return
    const publish = () => {
      document.documentElement.style.setProperty(
        '--player-height',
        `${footer.getBoundingClientRect().height}px`,
      )
    }
    // A hidden footer (a phone with nothing playing, or Now Playing) gets no first observation,
    // so the height is published now, as 0 while it is hidden, and again whenever it shows or
    // hides.
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(footer)
    return () => observer.disconnect()
  }, [activeTitle, hidden])

  const cover = activeArt ? (
    <img className="size-[45px] rounded-md max-phone:size-[40px]" src={activeArt} alt="" />
  ) : (
    <Disc3 size={30} className="text-faint" />
  )

  function openPlaylistDialog() {
    setPlaylistSearch('')
    setNewPlaylistName('')
    setExpandedPlaylist('')
    setPickerOpen(true)
    playlistDialog.current?.showModal()
  }

  function closePlaylistDialog() {
    setPickerOpen(false)
    playlistDialog.current?.close()
  }

  const canToggleLiked = likedPlaylist.data && libraryTrack ? true : false
  const createBusy = createPlaylist.isPending

  function toggleLikedTrack() {
    const trackId = libraryTrack?.id
    const liked = likedPlaylist.data
    if (!trackId || !liked) return
    playlistSongs.mutation.mutate(
      isLiked
        ? { playlistId: liked.id, index: likedIndex }
        : { playlistId: liked.id, songId: trackId },
    )
  }

  function togglePlaylistTrack(playlist: LibraryPlaylist) {
    const trackId = libraryTrack?.id
    if (!trackId) return
    const index = (songsByPlaylist.get(playlist.id) ?? []).findIndex((item) => item.id === trackId)
    playlistSongs.mutation.mutate(
      index >= 0
        ? { playlistId: playlist.id, index }
        : { playlistId: playlist.id, songId: trackId },
    )
  }

  // All three elements share these. Each ignores events unless it is the one in play: a preview
  // pausing as a library track starts cannot mark that track paused, a stale timeupdate cannot move
  // the seek bar, and the standby library element, which is loading the next track, is not heard
  // from at all until a handover makes it the active one.
  function mediaHandlers(which: 'preview' | Slot) {
    type MediaEvent = SyntheticEvent<HTMLAudioElement>
    const forLibrary = which !== 'preview'
    const inPlay = () =>
      forLibrary
        ? mode.current === 'library' && activeSlot.current === which
        : mode.current === 'preview'
    return {
      onLoadedMetadata: (event: MediaEvent) => {
        if (!inPlay()) return
        setReady(true)
        if (pendingSeek.current) {
          event.currentTarget.currentTime = pendingSeek.current
          pendingSeek.current = 0
        }
        if (forLibrary) publishPosition(event.currentTarget)
      },
      onPlay: (event: MediaEvent) => {
        if (!inPlay()) return
        setPlaying(true)
        if (!forLibrary) return
        scrobble(false)
        const element = event.currentTarget
        publishPosition(element)
        void routeToAnalyser(element)
      },
      // A track that has started playing ends a run of failures.
      onPlaying: () => {
        if (inPlay() && forLibrary) failures.current = 0
      },
      onPause: (event: MediaEvent) => {
        if (!inPlay()) return
        window.clearTimeout(handoverTimer.current)
        setPlaying(false)
        saveQueue()
        if (forLibrary) publishPosition(event.currentTarget)
      },
      onSeeked: (event: MediaEvent) => {
        if (inPlay() && forLibrary) publishPosition(event.currentTarget)
      },
      onEnded: (event: MediaEvent) => {
        if (!inPlay()) return
        if (!forLibrary) {
          setPlaying(false)
          return
        }
        finishTrack(event.currentTarget)
      },
      onTimeUpdate: (event: MediaEvent) => {
        if (!inPlay()) return
        const element = event.currentTarget
        const seconds = element.currentTime
        setPosition(seconds)
        if (!forLibrary) return
        // Not while paused: restoring a saved queue seeks a paused element past the threshold.
        if (!element.paused && seconds >= HISTORY_LISTEN_SECONDS) recordPlay()
        if (Math.floor(seconds / 10) !== lastSavedSecond.current) {
          lastSavedSecond.current = Math.floor(seconds / 10)
          saveQueue()
        }
        if (!element.paused) ensurePreload(element)
        scheduleHandover(element)
      },
      onDurationChange: (event: MediaEvent) => {
        if (!inPlay()) return
        const { duration } = event.currentTarget
        if (Number.isFinite(duration)) setLength(duration)
        if (forLibrary) publishPosition(event.currentTarget)
      },
      onError: () => {
        if (forLibrary && !inPlay()) {
          // The standby element could not load what it was given. Nothing is skipped for that: the
          // song is loaded the ordinary way when its turn comes, and skipped then if it still fails.
          const held = preload.current
          if (held?.slot === which) preload.current = { ...held, failed: true }
          return
        }
        if (!inPlay()) return
        setPlaying(false)
        setReady(false)
        if (forLibrary) {
          skipUnplayable()
          return
        }
        const item = previewCurrent.current
        if (!item) return
        if (previewStage.current < 2) {
          previewStage.current += 1
          void loadPreview(item, previewStage.current === 2)
        } else setNotice('No playable preview available.')
      },
    }
  }

  function submitNewPlaylist(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!libraryTrack) return
    const name = newPlaylistName.trim()
    if (name.length < 1) return
    if (name.length > 200) return
    createPlaylist.mutate(name)
  }

  return (
    <PlayerContext.Provider
      value={{
        track,
        libraryTrack,
        queue,
        source,
        currentIndex,
        playing,
        position,
        length,
        shuffle,
        repeat,
        play,
        playLibrary,
        shuffleLibrary,
        playNext,
        addToQueue,
        removeFromQueue,
        moveInQueue,
        clearQueue,
        history,
        clearHistory,
        toggle,
        next: () => next(),
        previous,
        ready,
        volume,
        muted,
        audio: audioElement,
        seek,
        setVolume: changeVolume,
        toggleMute,
        toggleShuffle,
        cycleRepeat,
        liked: {
          isLiked,
          canToggle: canToggleLiked,
          busy: playlistSongs.busy(likedId ?? ''),
          toggle: toggleLikedTrack,
        },
        previewState: (trackId: number) => previewStates.get(trackId),
        openPlaylistPicker: openPlaylistDialog,
        notice,
        stop,
      }}
    >
      {children}
      <footer
        ref={footerRef}
        // The attribute rather than a `hidden` utility: Tailwind's base layer gives it
        // `display: none !important`, so it wins over the footer's own `flex` in any order.
        hidden={hidden}
        className={cx(footerClassName, !activeTitle && 'max-phone:hidden')}
      >
        <div className="flex min-w-0 flex-1 items-center gap-[13px] text-small max-phone:gap-[10px] [&_a:hover]:underline">
          {/* Now Playing is for library tracks only, so a preview's thumbnail stays a picture.
              On a phone this is the mini player's way in besides the title. */}
          {isLibrary ? (
            <Link
              to="/now-playing"
              aria-label="Open Now Playing"
              className="cover-link shrink-0"
              data-playing={playing}
            >
              {cover}
            </Link>
          ) : (
            cover
          )}
          <span className="min-w-0">
            <strong className="block truncate text-small font-medium max-phone:text-body">
              {isLibrary ? (
                <Link to="/now-playing">{activeTitle}</Link>
              ) : track?.album_id ? (
                <Link
                  to="/albums/$albumId"
                  params={{ albumId: String(track.album_id) }}
                  search={{ track: track.id }}
                >
                  {track.title}
                </Link>
              ) : (
                (activeTitle ?? 'A little listening goes a long way.')
              )}
            </strong>
            {activeArtist && (
              <small className="mt-[5px] block truncate text-caption text-muted max-phone:mt-[2px] max-phone:max-w-full max-phone:text-tiny max-phone:leading-[1.3]">
                {libraryTrack?.artistId ? (
                  <Link
                    to="/library/artists/$artistId"
                    params={{ artistId: libraryTrack.artistId }}
                  >
                    {activeArtist}
                  </Link>
                ) : track?.artist_id ? (
                  <Link to="/artists/$artistId" params={{ artistId: String(track.artist_id) }}>
                    {activeArtist}
                  </Link>
                ) : (
                  activeArtist
                )}
                {activeAlbum && (
                  <>
                    {' · '}
                    {libraryTrack?.albumId ? (
                      <Link
                        to="/library/albums/$albumId"
                        params={{ albumId: libraryTrack.albumId }}
                      >
                        {activeAlbum}
                      </Link>
                    ) : track?.album_id ? (
                      <Link to="/albums/$albumId" params={{ albumId: String(track.album_id) }}>
                        {activeAlbum}
                      </Link>
                    ) : (
                      activeAlbum
                    )}
                  </>
                )}
              </small>
            )}
            <small
              className="mt-[2px] block truncate text-caption text-muted max-phone:mt-[2px] max-phone:max-w-full max-phone:text-tiny max-phone:leading-[1.3]"
              role="status"
            >
              {notice}
            </small>
          </span>
        </div>
        {isLibrary && (
          <div className="flex items-center gap-[13px] text-small max-phone:hidden">
            <IconButton
              active={isLiked}
              // The label already says which way the press goes, so a pressed state on top of it
              // would be read out twice.
              aria-pressed={undefined}
              aria-label={
                isLiked ? `Remove ${activeTitle} from liked` : `Add ${activeTitle} to liked`
              }
              disabled={!canToggleLiked || playlistSongs.busy(likedPlaylist.data?.id ?? '')}
              size="compact"
              onClick={() => toggleLikedTrack()}
            >
              <ThumbsUp size={16} fill={isLiked ? 'currentColor' : 'none'} />
            </IconButton>
            <IconButton
              aria-label={`Add ${activeTitle} to a playlist`}
              disabled={!isLibrary}
              size="compact"
              onClick={() => openPlaylistDialog()}
            >
              <Plus size={16} />
            </IconButton>
            <Link
              data-ui="icon-button"
              className={iconButtonClassName(false, 'shrink-0', 'compact')}
              aria-label="Open Now Playing"
              to="/now-playing"
            >
              <Maximize2 size={17} />
            </Link>
          </div>
        )}
        <div className="playback-controls flex items-center gap-[12px] text-tiny text-muted max-phone:gap-[2px]">
          {isLibrary ? (
            <IconButton
              size="compact"
              className="max-phone:hidden"
              aria-label="Previous track"
              onClick={previous}
            >
              <SkipBack size={17} />
            </IconButton>
          ) : (
            <IconButton
              size="compact"
              className="max-phone:hidden"
              aria-label="Restart preview"
              disabled={!ready}
              onClick={() => {
                const element = previewAudio.current
                if (element) {
                  element.currentTime = 0
                  void element.play().catch(() => setNotice('Press play when you are ready.'))
                }
              }}
            >
              <RotateCcw size={16} />
            </IconButton>
          )}
          <IconButton
            variant="play"
            aria-label={
              isLibrary ? (playing ? 'Pause' : 'Play') : playing ? 'Pause preview' : 'Play preview'
            }
            disabled={!activeTitle}
            onClick={toggle}
          >
            {playing ? <Pause size={19} /> : <Play size={19} />}
          </IconButton>
          {isLibrary && (
            <IconButton size="compact" aria-label="Next track" onClick={() => next()}>
              <SkipForward size={17} />
            </IconButton>
          )}
          <span className="max-phone:hidden">{durationText(position)}</span>
          {/* On a phone the seek bar leaves the row and runs along the player's top edge, where
              the handwritten rules in style.css draw its track from --progress. */}
          <input
            className={cx(
              'w-[140px] accent-accent max-tablet:w-[90px]',
              'max-phone:absolute max-phone:top-[-6px] max-phone:left-0 max-phone:m-0 max-phone:block max-phone:h-[13px] max-phone:w-full max-phone:appearance-none max-phone:bg-transparent max-phone:disabled:opacity-60',
            )}
            aria-label={isLibrary ? 'Playback position' : 'Preview position'}
            type="range"
            min="0"
            max={seekMax}
            step="0.1"
            value={Math.min(position, seekMax)}
            disabled={!ready}
            style={seekStyle}
            onChange={(event) => seek(Number(event.target.value))}
          />
          <span className="max-phone:hidden">{durationText(length)}</span>
        </div>
        <div className="flex items-center gap-[4px] text-small max-phone:hidden">
          {isLibrary && (
            <>
              <IconButton
                active={shuffle}
                size="compact"
                aria-label="Shuffle"
                onClick={toggleShuffle}
              >
                <Shuffle size={17} />
              </IconButton>
              <IconButton
                active={repeat !== 'off'}
                size="compact"
                aria-label={`Repeat ${repeat}`}
                onClick={cycleRepeat}
              >
                <Repeat size={17} />
                {repeat === 'one' && (
                  <small className="absolute mt-[5px] block translate-x-[7px] translate-y-[7px] text-micro text-accent">
                    1
                  </small>
                )}
              </IconButton>
            </>
          )}
          <IconButton
            size="compact"
            aria-label={
              isLibrary ? (muted ? 'Unmute' : 'Mute') : muted ? 'Unmute preview' : 'Mute preview'
            }
            onClick={toggleMute}
          >
            {muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </IconButton>
          <input
            className="w-[80px] accent-accent max-tablet:w-[64px]"
            type="range"
            aria-label={isLibrary ? 'Volume' : 'Preview volume'}
            min="0"
            max="1"
            step="0.01"
            value={muted ? 0 : volume}
            onChange={(event) => changeVolume(Number(event.target.value))}
          />
        </div>
        {(track || libraryTrack) && (
          <IconButton
            size="compact"
            aria-label={isLibrary ? 'Close player' : 'Close preview'}
            onClick={stop}
          >
            <X size={16} />
          </IconButton>
        )}
        <audio
          ref={previewAudio}
          className="preview-audio"
          preload="metadata"
          {...mediaHandlers('preview')}
        />
        {/* Two, swapping roles: `data-role` says which plays and which holds the next track. */}
        <audio ref={libraryA} className="library-audio" preload="metadata" {...mediaHandlers(0)} />
        <audio ref={libraryB} className="library-audio" preload="metadata" {...mediaHandlers(1)} />
      </footer>
      {/* Outside the footer, which Now Playing hides: `display: none` on an ancestor would take the
          open dialog with it, and the page's Add to playlist button opens this one. */}
      {isLibrary && (
        <dialog
          ref={playlistDialog}
          // `playlist-picker-sheet` carries the handwritten ::backdrop rule. Centered at every
          // width, so on a phone the name field is never trapped under the keyboard.
          className="playlist-picker-sheet fixed inset-0 m-auto h-fit max-h-[78dvh] w-[min(520px,calc(100%-32px))] overflow-auto overscroll-contain rounded-[16px] border border-line-strong bg-raised p-[18px] text-text max-phone:max-h-[calc(100dvh-32px)] max-phone:w-[calc(100%-16px)] max-phone:p-[14px]"
          aria-label="Add track to playlist"
          onClose={() => setPickerOpen(false)}
          onClick={(event) => {
            if (event.target === playlistDialog.current) closePlaylistDialog()
          }}
        >
          <header className="mb-[12px] flex items-center gap-[14px]">
            <h2 className="flex-1">Add to playlist</h2>
            <IconButton
              size="compact"
              aria-label="Close playlist picker"
              onClick={() => closePlaylistDialog()}
            >
              <X size={16} />
            </IconButton>
          </header>
          <label className="flex rounded-[8px] border border-line bg-sunken px-[11px] text-muted">
            <input
              className="w-full border-0 bg-transparent px-[2px] py-[10px] text-inherit"
              aria-label="Filter playlists"
              value={playlistSearch}
              placeholder="Filter playlists"
              onChange={(event) => setPlaylistSearch(event.target.value)}
            />
          </label>
          {allPlaylists.isLoading && <p role="status">Loading playlists…</p>}
          {allPlaylists.isError && <ErrorBanner>{allPlaylists.error.message}</ErrorBanner>}
          <div className="mt-[8px] mb-[10px] grid grid-cols-[minmax(0,1fr)] gap-[8px]">
            {availablePlaylists.map((playlist, at) => (
              <PlaylistPickerRow
                key={playlist.id}
                playlist={playlist}
                songs={songsByPlaylist.get(playlist.id)}
                failed={failedPlaylists.has(playlist.id)}
                onRetry={() => void playlistDetails[at]?.refetch()}
                trackId={libraryTrack?.id ?? ''}
                trackTitle={activeTitle ?? 'this track'}
                busy={playlistSongs.busy(playlist.id)}
                blocked={createBusy}
                expanded={expandedPlaylist === playlist.id}
                onExpand={(open) => setExpandedPlaylist(open ? playlist.id : '')}
                onToggleTrack={() => togglePlaylistTrack(playlist)}
                onRemoveSong={(index) =>
                  playlistSongs.mutation.mutate({ playlistId: playlist.id, index })
                }
              />
            ))}
            {!allPlaylists.isLoading && !availablePlaylists.length && (
              <p className={pickerNoteClassName}>No playlists yet.</p>
            )}
            {matchingPlaylists.length > PICKER_ROWS && (
              <p className={pickerNoteClassName}>
                Showing {PICKER_ROWS} of {matchingPlaylists.length}. Filter above to reach the
                others.
              </p>
            )}
          </div>
          <form className="flex flex-wrap items-end gap-[10px]" onSubmit={submitNewPlaylist}>
            <label className="grid min-w-[min(260px,100%)] gap-[6px] text-small text-muted">
              New playlist
              <Field
                value={newPlaylistName}
                placeholder="Create and add this track"
                maxLength={200}
                onChange={(event) => setNewPlaylistName(event.target.value)}
              />
            </label>
            <Button type="submit" disabled={createBusy || !newPlaylistName.trim()}>
              {createBusy ? 'Creating…' : 'Create'}
            </Button>
          </form>
          {(playlistSongs.mutation.isError || createPlaylist.isError) && (
            <ErrorBanner>
              {playlistSongs.mutation.error?.message || createPlaylist.error?.message}
            </ErrorBanner>
          )}
        </dialog>
      )}
    </PlayerContext.Provider>
  )
}
