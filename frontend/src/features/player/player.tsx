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
  Disc3,
  ListMusic,
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
  accountPlaySchema,
  api,
  ApiError,
  diagnosticsSchema,
  libraryPlaylistDetailSchema,
  libraryPlaylistsSchema,
  librarySelectionSchema,
  libraryShuffleWindowSchema,
  playerQueueSchema,
  previewSchema,
} from '../../api'
import type { LibraryPlaylist, LibraryTrack, MusicResult } from '../../api'
import { cx } from '../../lib/cx'
import { IconButton, iconButtonClassName, useToast } from '../../ui'
import type { ToastAction, ToastTone } from '../../ui'
import {
  accountCookieReplaced,
  accountStreamStopped,
  adoptLibraryTrack,
  canAccountPlay,
  isDeezerTrack,
  toQueueTrack,
} from './account-play'
import type { DeezerListen } from './account-play'
import { audioGraph, resumeAudio } from './audio-graph'
import { crossfadeSpan } from './crossfade'
import { useCrossfadeSeconds } from './crossfade-settings'
import { fadeInGain, fadeOutGain, rampDown } from './fades'
import { HANDOVER_WINDOW_SECONDS, handoverDelay, lengthsAgree } from './handover'
import { createHandoverClock } from './handover-clock'
import type { HandoverClock } from './handover-clock'
import {
  addToHistory,
  HISTORY_LISTEN_SECONDS,
  type HistoryEntry,
  readHistory,
  writeHistory,
} from './play-history'
import { PlaylistPicker } from './playlist-picker'
import { QueueWriter } from './queue-writer'
import {
  playsAlbumInOrder,
  replayGainHasPeak,
  replayGainMultiplier,
  splitLevel,
} from './replay-gain'
import { useReplayGainSettings } from './replay-gain-settings'
import { dropForRoom, needsMore, QUEUE_LIMIT, SHUFFLE_FETCH, stillWaiting } from './shuffle-deck'
import type { Deck } from './shuffle-deck'
import { SLEEP_FADE_SECONDS, sleepChoiceLabel } from './sleep-timer'
import type { SleepChoice, SleepStatus } from './sleep-timer'

export type RepeatMode = 'off' | 'all' | 'one'
export type BotQueueAction = 'play' | 'next' | 'append' | 'replace'
type ExtendResult = 'added' | 'skipped' | 'idle' | 'failed'
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
  /**
   * Which collection filled the queue, so its own play button can show pause. It survives edits
   * while the playing track is one of the collection's own, and is `queue` once it is not.
   */
  source: string
  /** True once the queue has been changed by hand since it was filled from `source`. */
  edited: boolean
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
   * A Tracks shuffle. `items` is the first window, already in play order. When the pass is
   * larger than the queue, `seed` names the order kept on the server and `cursor` is how far
   * into it `items` reaches. The window is refilled as it plays.
   */
  playDeck: (
    tracks: LibraryTrack[],
    seed: string,
    total: number,
    cursor: number,
    source?: string,
  ) => void
  /**
   * Queue edits. Each one saves the queue. The two that add say what happened in `notice`, and
   * refuse, adding nothing, when the queue would pass the 500 songs it keeps. Up next
   * announces the other three itself, where the listener made them.
   */
  playNext: (tracks: LibraryTrack[]) => void
  addToQueue: (tracks: LibraryTrack[]) => void
  removeFromQueue: (index: number) => void
  moveInQueue: (from: number, to: number) => void
  /** Empties the queue but for the track that is playing. */
  clearQueue: () => void
  botStamp: () => string
  applyBotQueue: (tracks: LibraryTrack[], action: BotQueueAction, expected: string) => void
  undoBotQueue: () => void
  canUndoBotQueue: boolean
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
  previewState: (trackId: number, spotifyId?: string) => PreviewState | undefined
  /** Deezer catalog Play. A Spotify row stays on its preview. */
  playCatalog: (item: MusicResult) => void
  /** Album Play, or play from here. Each track falls back on its own. */
  playCatalogFrom: (tracks: MusicResult[], index: number, source?: string) => void
  /** The Deezer id whose account file is being fetched, if any. */
  fetchingId: number | null
  cancelFetch: () => void
  listen: DeezerListen | undefined
  /** Opens the add-to-playlist sheet; a phone's mini player has no button of its own for it. */
  openPlaylistPicker: () => void
  /** The footer's status line. Now Playing hides the footer, so the page repeats it. */
  notice: string
  /** Empties the player, the footer's close button. Now Playing has one of its own. */
  stop: () => void
  /** The sleep timer while one runs, else null. It is not saved: a reload clears it. */
  sleep: SleepStatus | null
  /** Starts a sleep timer, replacing any running one. Null cancels it. */
  setSleep: (choice: SleepChoice | null) => void
  /** Saves the queue again after a failed save. One that lands takes the failure notice away. */
  retryQueueSave: () => void
}
const PlayerContext = createContext<Playback>({
  track: null,
  libraryTrack: null,
  queue: [],
  source: '',
  edited: false,
  currentIndex: -1,
  playing: false,
  position: 0,
  length: 0,
  shuffle: false,
  repeat: 'off',
  play: () => undefined,
  playLibrary: () => undefined,
  shuffleLibrary: () => undefined,
  playDeck: () => undefined,
  playNext: () => undefined,
  addToQueue: () => undefined,
  removeFromQueue: () => undefined,
  moveInQueue: () => undefined,
  clearQueue: () => undefined,
  botStamp: () => '',
  applyBotQueue: () => undefined,
  undoBotQueue: () => undefined,
  canUndoBotQueue: false,
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
  playCatalog: () => undefined,
  playCatalogFrom: () => undefined,
  fetchingId: null,
  cancelFetch: () => undefined,
  listen: undefined,
  openPlaylistPicker: () => undefined,
  notice: '',
  stop: () => undefined,
  sleep: null,
  setSleep: () => undefined,
  retryQueueSave: () => undefined,
})
export const usePlayer = () => useContext(PlayerContext)

const LIBRARY_NOTICE = 'Your music library'
const RESTORED_NOTICE = 'Queue restored. Press play to continue.'
/** The notices a failed queue save leaves, so the Listening room can show them in Up next too. */
export const QUEUE_SAVE_FAILED = 'The queue changed here but could not be saved.'
export const QUEUE_REPLACED =
  'Another browser saved the queue. Refresh to restore it before saving more changes.'
const SLEEP_ENDED_NOTICE = 'Sleep timer ended. Playback paused.'
const SLEEP_CANCELLED_NOTICE = 'Sleep timer cancelled.'
const SLEEP_QUEUE_LOST_NOTICE =
  'Sleep timer cancelled. Shuffle and repeat never reach the end of the queue.'

export { QUEUE_LIMIT }
/** The queue's source when it is no longer any one collection: the listener's own. */
export const EDITED_SOURCE = 'queue'
/** The source of a queue brought back after a reload, which does not remember where it began. */
export const RESTORED_SOURCE = 'restored'
/** Where the entries queued by hand are kept, by position, across a reload. */
const CHOSEN_KEY = 'musimo.queue-chosen'
/** A Tracks shuffle that does not fit in the saved queue. The order itself stays on the server. */
const DECK_KEY = 'musimo.shuffle-deck'

/**
 * What the queue counts as coming from. An edit does not take the collection away: it is still the
 * album while the playing track is one of the album's own. It is the listener's queue once the
 * playing track is one they added, and for a queue whose collection was never known.
 */
export function queueSource(origin: string, edited: boolean, playingAdded: boolean) {
  if (playingAdded) return EDITED_SOURCE
  if (edited && (origin === '' || origin === RESTORED_SOURCE)) return EDITED_SOURCE
  return origin
}

/** A fingerprint of the songs in the queue and their order, so saved positions know what they fit. */
export function queueHash(ids: readonly string[]) {
  // FNV-1a over the joined ids. Not secure, only a cheap way to notice that the queue changed.
  let hash = 0x811c9dc5
  const text = ids.join('\n')
  for (let at = 0; at < text.length; at += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(at), 0x01000193)
  }
  return `${ids.length}:${(hash >>> 0).toString(16)}`
}

/**
 * The entries queued by hand, as text to keep. The saved queue holds ids only, so the
 * places of these entries are kept beside a fingerprint of the queue they belong to. Empty text
 * when nothing was chosen, which is nothing to keep.
 */
export function encodeChosen(queue: readonly LibraryTrack[], chosen: ReadonlySet<LibraryTrack>) {
  const at = queue.flatMap((item, place) => (chosen.has(item) ? [place] : []))
  if (!at.length) return ''
  return JSON.stringify({ hash: queueHash(queue.map((item) => item.id)), at })
}

/**
 * The entries of `queue` that `saved` (from `encodeChosen`) marks as chosen. Nothing is chosen when
 * the text is unreadable or was written for a different queue: places that no longer point at the
 * same songs would put the wrong ones first.
 */
export function decodeChosen(queue: readonly LibraryTrack[], saved: string) {
  const chosen = new Set<LibraryTrack>()
  let value: unknown
  try {
    value = JSON.parse(saved)
  } catch {
    return chosen
  }
  if (value === null || typeof value !== 'object') return chosen
  const { hash, at } = value as Record<string, unknown>
  if (hash !== queueHash(queue.map((item) => item.id)) || !Array.isArray(at)) return chosen
  for (const place of at) {
    const item = typeof place === 'number' ? queue[place] : undefined
    if (item) chosen.add(item)
  }
  return chosen
}

/** Empty when `adding` more songs fit beside `size` already queued, else the reason they do not. */
export function queueOverflow(size: number, adding: number) {
  if (size + adding <= QUEUE_LIMIT) return ''
  return `The queue is full. It holds ${QUEUE_LIMIT} songs and this would make ${size + adding}. Nothing was added.`
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
export const isPassiveNotice = (text: string) =>
  text === LIBRARY_NOTICE || text === RESTORED_NOTICE || text === 'Deezer account'

/** True while this exact collection owns the queue, so Play can become Pause. */
export function useCollectionPlayback(source: string) {
  const player = usePlayer()
  const active = Boolean(source) && player.source === source && Boolean(player.libraryTrack)
  return { active, playing: active && player.playing, toggle: player.toggle }
}

/**
 * Which catalog row a preview belongs to. A Spotify id is its own key, so it is never compared
 * with a Deezer track id, including when that Spotify id is only digits.
 */
export function previewIdentity(item: { id: number; spotify_id?: string }) {
  return item.spotify_id ? `spotify:${item.spotify_id}` : `deezer:${item.id}`
}

/** The same derived state for a catalog preview, which has no collection behind it. */
export function usePreviewPlayback(id: number, spotifyId = '') {
  const player = usePlayer()
  const active =
    !player.libraryTrack &&
    player.track !== null &&
    previewIdentity(player.track) === previewIdentity({ id, spotify_id: spotifyId })
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
   specs use, and the one the seek and volume bar rules in style.css hang off. The idle footer is
   hidden on a phone where it is rendered, not here. */
const footerClassName = cx(
  'live-player fixed right-[var(--safe-right)] bottom-0 left-[calc(var(--sidebar-width)+var(--safe-left))] z-bar grid h-[76px] grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)] items-center gap-[20px] border-t border-line-strong bg-raised px-[20px]',
  'max-tablet:gap-[12px] max-tablet:px-[16px]',
  // The phone's mini player is a card above the tab bar, not a bar across the screen.
  'max-phone:right-[calc(8px+var(--safe-right))] max-phone:bottom-[calc(var(--nav-height)+var(--safe-bottom))] max-phone:left-[calc(8px+var(--safe-left))] max-phone:mb-[6px] max-phone:flex max-phone:h-auto max-phone:min-h-[56px] max-phone:gap-[6px] max-phone:rounded-[12px] max-phone:border-0 max-phone:bg-hover max-phone:p-[8px]',
)

export const songCount = (count: number) => `${count} ${count === 1 ? 'song' : 'songs'}`

export const artUrl = (track: LibraryTrack) => {
  if (!track.coverArt) return ''
  if (track.coverArt.startsWith('https://') || track.coverArt.startsWith('http://'))
    return track.coverArt
  return `/api/player/art/${encodeURIComponent(track.coverArt)}`
}

// Elements whose sound already reaches the graph's bus. A media element can be given to
// `createMediaElementSource` once only, so each is remembered for good.
const routed = new WeakSet<HTMLMediaElement>()
// The gain stage of each library element, between its source and the bus. It carries a
// ReplayGain boost past what an element's `volume` can hold.
const boosters = new WeakMap<HTMLMediaElement, GainNode>()

/**
 * Sends a library element's sound through the audio graph, where the visualizer hears it. Call it
 * from the element's `play` event, which is also what lets a suspended context resume. Each element
 * gets its own gain node, at 1 until `applyVolume` sets it, so the sound is unchanged until a boost
 * is asked for. Gapless playback has two elements that swap roles, and without both wired up the
 * stage goes flat on every other track while the music carries on. Only ever called for the library
 * pair: a preview's cross-origin audio would be silenced for good.
 */
async function routeToAnalyser(element: HTMLMediaElement) {
  if (routed.has(element)) return
  const graph = audioGraph()
  // Nothing is wired up until the context runs, since a source on a suspended context is silent.
  // The next play tries again.
  if (!(await resumeAudio()) || routed.has(element)) return
  routed.add(element)
  const booster = graph.context.createGain()
  graph.context.createMediaElementSource(element).connect(booster)
  booster.connect(graph.bus)
  boosters.set(element, booster)
}

/** The gain stage to boost through, or undefined where there is no running graph to boost in. */
const runningBooster = (element: HTMLMediaElement) => {
  const booster = boosters.get(element)
  return booster?.context.state === 'running' ? booster : undefined
}

/** How long before a track ends the next one starts loading. A shorter track loads it at once. */
export const PRELOAD_LEAD_SECONDS = 15
/** Tracks that may fail one after another before playback stops, rather than racing the queue. */
export const MAX_FAILURES = 3
/** True once the next track should be loading: the last seconds of a track, all of a short one. */
export const preloadDue = (length: number, time: number) =>
  length > 0 && length - time <= PRELOAD_LEAD_SECONDS

export const skippedNotice = (title: string) => `Skipped ${title}, it could not be played`
export const failureLimitNotice = `Stopped after ${MAX_FAILURES} tracks in a row could not be played. Check that the music folder is mounted.`

const streamUrl = (track: LibraryTrack) =>
  track.origin === 'deezer'
    ? `/api/player/account/${encodeURIComponent(track.id)}/file`
    : `/api/player/stream/${encodeURIComponent(track.id)}`

const secondsLeft = (element: HTMLAudioElement) =>
  Number.isFinite(element.duration) ? element.duration - element.currentTime : Infinity

// Not in every browser's Navigator type. A true `saveData` is the listener asking not to spend
// data on things they have not asked for.
const dataSaverOn = () =>
  (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true

/** Which of the two library elements. One plays while the other holds the next track. */
type Slot = 0 | 1
type Preload = { index: number; item: LibraryTrack; slot: Slot; failed: boolean }
/**
 * A crossfade in progress. The element that is fading out keeps playing its old track after the new
 * one has taken over everywhere else; `out` and `in` are the two levels the fade holds right now,
 * and `span` is how many seconds it was set to last.
 */
type Crossfade = {
  element: HTMLAudioElement
  item: LibraryTrack
  index: number
  span: number
  out: number
  in: number
}
type SleepTimer = { choice: SleepChoice; endsAt: number }

// How often the fades are recomputed. Fine enough that a five second fade has no steps to hear.
const ENVELOPE_TICK_MS = 100
// A fading-out element with this little left is done: it is paused rather than left to its end.
const FADE_DONE_SECONDS = 0.05

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

function forget(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    /* Browser storage is optional. */
  }
}

function strings(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return null
  return value
}

/** The saved deck only belongs to the queue it was written with. */
function readDeck(queueIds: string[]): Deck | null {
  try {
    const raw: unknown = JSON.parse(stored(DECK_KEY, ''))
    if (!raw || typeof raw !== 'object') return null
    const body = raw as { seed?: unknown; cursor?: unknown; total?: unknown; queue?: unknown }
    const queue = strings(body.queue)
    if (typeof body.seed !== 'string' || !queue) return null
    if (typeof body.cursor !== 'number' || typeof body.total !== 'number') return null
    if (!Number.isInteger(body.cursor) || !Number.isInteger(body.total)) return null
    if (body.cursor < 0 || body.total < 0) return null
    if (queue.length !== queueIds.length || queue.some((id, index) => id !== queueIds[index]))
      return null
    return { seed: body.seed, cursor: body.cursor, total: body.total }
  } catch {
    return null
  }
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
  // Times the handover off the page's own timers, which a hidden tab holds to one a second. Made on
  // first use so its worker stays out of the first paint.
  const handoverClock = useRef<HandoverClock | null>(null)
  // Set while the old track is still fading out under the new one. See `Crossfade`.
  const fadingOut = useRef<Crossfade | null>(null)
  // The sleep timer, and the level its last five seconds have brought everything down to.
  const sleepRef = useRef<SleepTimer | null>(null)
  const sleepGain = useRef(1)
  // Recomputes the fades while either is running, and stops itself when neither is.
  const envelopeTimer = useRef<number | undefined>(undefined)
  const tickRef = useRef<() => void>(() => undefined)
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
  // Bumped on every library load, so a wait for more shuffle songs can tell the listener moved on.
  const libraryLoads = useRef(0)
  const queueRef = useRef<LibraryTrack[]>([])
  // Bumped when the queue or the loaded track changes. Pause and play leave it alone,
  // so a music-bot undo can survive those.
  const queueGeneration = useRef(0)
  const botUndo = useRef<{
    stamp: string
    tracks: LibraryTrack[]
    index: number
    position: number
    chosen: Set<LibraryTrack>
    source: string
    deck: Deck | null
    edited: boolean
  } | null>(null)
  const [canUndoBotQueue, setCanUndoBotQueue] = useState(false)
  const indexRef = useRef(-1)
  // A library shuffle bigger than the saved queue. Null for an album, a playlist, or a short list.
  const deck = useRef<Deck | null>(null)
  const extendJob = useRef<Promise<ExtendResult> | null>(null)
  // Bumped on every queue save so an older response cannot count as the latest one.
  const queueSave = useRef(0)
  const queueWriter = useRef<QueueWriter | null>(null)
  // The queue saves itself every 10 seconds while music plays, so a server that is down would
  // raise the same toast each time. It is said once per kind, until a save goes through again.
  const queueFailureShown = useRef<'failed' | 'replaced' | null>(null)
  // The collection that filled the queue. Edits leave it alone; `queueSource` says what it counts as.
  const sourceRef = useRef('')
  const editedRef = useRef(false)
  // Entries the listener queued by hand, which shuffle plays before the rest. Each entry is its
  // own copy of the song, so the set can tell a song queued twice apart.
  const chosen = useRef(new Set<LibraryTrack>())
  // The same entries for good: `chosen` forgets one when it plays, this remembers it was not the
  // collection's own song, so the source can follow the playing track.
  const added = useRef(new WeakSet<LibraryTrack>())
  const mode = useRef<'preview' | 'library'>('preview')
  const slots = () => [libraryA.current, libraryB.current] as const
  const library = () => slots()[activeSlot.current]
  const accountRequest = useRef<AbortController | null>(null)
  const resumeQueue = useRef(false)
  const previewAutoplay = useRef(true)
  const [fetchingId, setFetchingId] = useState<number | null>(null)
  const diagnostics = useQuery({
    queryKey: ['diagnostics'],
    queryFn: ({ signal }) => api('diagnostics', diagnosticsSchema, { signal }),
    staleTime: 30_000,
  })
  const listen = diagnostics.data?.deezer_listen
  const listenRef = useRef(listen)
  listenRef.current = listen
  const cookieMark = useRef<string | undefined>(undefined)
  useEffect(() => {
    const next = listen ? (listen.mark ?? '') : undefined
    const previous = cookieMark.current
    if (next !== undefined) cookieMark.current = next
    const replaced =
      libraryCurrent.current?.origin === 'deezer' && accountCookieReplaced(previous, next)
    if (!accountStreamStopped(libraryCurrent.current?.origin, listen?.ready) && !replaced) return
    accountRequest.current?.abort()
    setFetchingId(null)
    const element = library()
    element?.pause()
    element?.removeAttribute('src')
    element?.load()
    libraryCurrent.current = null
    setLibraryTrack(null)
    setPlaying(false)
    setReady(false)
    setNotice(listen?.detail || 'Choose a track to start listening.')
  }, [listen?.ready, listen?.detail, listen?.mark])
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
  //
  // `gain` is the part of a ReplayGain boost an element's volume cannot hold, for a library element
  // that has been wired up (see `boosters`). It is 1 everywhere else: a preview, and any element
  // while there is no running graph.
  function outputLevel(element: HTMLAudioElement | null): { volume: number; gain: number } | null {
    const { volume: set, shuffle: shuffled, replay } = levelling.current
    const base = Number.isFinite(set) ? Math.max(0, Math.min(1, set)) : 0.7
    if (!element) return { volume: base, gain: 1 }
    if (element === previewAudio.current) return { volume: base * sleepGain.current, gain: 1 }
    const slot: Slot = element === libraryA.current ? 0 : 1
    let target: { item: LibraryTrack | null; index: number } | null = null
    const fading = fadingOut.current
    if (fading && element === fading.element) {
      // Still playing the track that was handed over from, though the slot now counts as standby.
      target = fading
    } else if (slot === activeSlot.current) {
      target = { item: libraryCurrent.current, index: indexRef.current }
    } else if (preload.current?.slot === slot) {
      target = preload.current
    }
    if (!target) return null
    const faded = base * envelope(element)
    if (!target.item) return { volume: faded, gain: 1 }
    const inOrder = playsAlbumInOrder(queueRef.current, target.index, shuffled)
    const multiplier = replayGainMultiplier(
      target.item.replayGain,
      replay.mode,
      inOrder,
      replay.preampDb,
    )
    // The multiplier is already held to 1 / peak, so a boost through the gain stage cannot clip. A
    // track with no peak tag has no such bound and is not boosted.
    const boostable =
      runningBooster(element) !== undefined &&
      replayGainHasPeak(target.item.replayGain, replay.mode, inOrder)
    return splitLevel(faded, multiplier, boostable)
  }

  // What the sleep timer's fade and a crossfade take off an element's level, on top of the person's
  // volume and the ReplayGain. 1 leaves it alone.
  function envelope(element: HTMLAudioElement): number {
    const fading = fadingOut.current
    let crossfade = 1
    if (fading) {
      if (element === fading.element) crossfade = fading.out
      else if (element === library()) crossfade = fading.in
    }
    return sleepGain.current * crossfade
  }

  function applyVolume() {
    for (const element of elements()) {
      if (!element) continue
      const level = outputLevel(element)
      if (level !== null) {
        element.volume = level.volume
        const booster = boosters.get(element)
        if (booster) booster.gain.value = level.gain
      }
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
  const [edited, setEdited] = useState(false)
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
  const [notice, setNoticeText] = useState('Choose a track to start listening.')
  const toast = useToast()
  // The toasts still up, by text, so a message that comes again replaces itself rather than stacking.
  const toasts = useRef(new Map<string, () => void>())
  /**
   * Sets the line Now Playing reads and, when given a tone, also shows it as a toast: the footer
   * has no room for a line of its own. Passive status ("Your music library") has no tone.
   */
  const setNotice = useCallback(
    (text: string, tone?: ToastTone, action?: ToastAction) => {
      setNoticeText(text)
      if (!tone) return
      toasts.current.get(text)?.()
      if (toasts.current.size > 20) toasts.current.clear()
      toasts.current.set(text, toast.show({ tone, text, action }))
    },
    [toast],
  )
  const replaySettings = useReplayGainSettings()
  const crossfadeSeconds = useCrossfadeSeconds()
  // What the timer was set to, and for a minutes timer the whole seconds it has left. The running
  // timer itself is `sleepRef`; these two exist to redraw the control.
  const [sleepChoice, setSleepChoice] = useState<SleepChoice | null>(null)
  const [sleepLeft, setSleepLeft] = useState(0)
  // What the volume needs, kept where the functions below (some run from timers and one-off
  // effects) read the latest of it rather than the render they were made in.
  const levelling = useRef({ volume, muted, shuffle, replay: replaySettings })
  levelling.current = { volume, muted, shuffle, replay: replaySettings }
  const [playlistSearch, setPlaylistSearch] = useState('')
  const [newPlaylistName, setNewPlaylistName] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [expandedPlaylist, setExpandedPlaylist] = useState('')
  const [previewStates, setPreviewStates] = useState<Map<string, PreviewState>>(new Map())
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
      if (playlist.id) setNotice(`Created playlist ${playlist.name}.`, 'good')
      setNewPlaylistName('')
      closePlaylistDialog()
    },
  })

  function previewRequest(item: MusicResult, fallback: boolean) {
    // A Spotify row has no Deezer id. Its missing clip uses the iTunes match, not /preview/0.
    if (item.spotify_id) {
      const params = new URLSearchParams({
        artist: item.artist,
        title: item.title,
        duration: String(item.duration),
      })
      return `preview-match?${params}`
    }
    return `preview/${item.id}?fallback=${fallback}`
  }

  async function loadPreview(item: MusicResult, fallback: boolean, autoplay = true) {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    previewAutoplay.current = autoplay
    const identity = previewIdentity(item)
    setNotice('Finding preview…')
    setPreviewStates((prev) => new Map(prev).set(identity, 'finding'))
    try {
      const clip = await api(previewRequest(item, fallback), previewSchema, {
        signal: controller.signal,
      })
      if (
        controller.signal.aborted ||
        !previewCurrent.current ||
        previewIdentity(previewCurrent.current) !== identity
      )
        return
      if (!clip.url) {
        setNotice('No preview available for this track.', 'warn')
        setPreviewStates((prev) => new Map(prev).set(identity, 'none'))
        continueAfterPreview(true)
        return
      }
      setNotice(`${clip.source} preview`)
      setPreviewStates((prev) => new Map(prev).set(identity, 'ready'))
      startAudio(clip.url, autoplay)
    } catch (error) {
      if (!controller.signal.aborted) {
        setNotice(error instanceof Error ? error.message : 'Preview unavailable', 'danger')
        continueAfterPreview(true)
      }
    }
  }

  // An account song in a queue fell through to a clip. A clip that plays through moves on.
  // One that never starts moves on too, and a run of those stops instead of walking the queue.
  function continueAfterPreview(failed: boolean) {
    if (!resumeQueue.current) return
    resumeQueue.current = false
    mode.current = 'library'
    if (!failed) {
      failures.current = 0
      next(true)
      return
    }
    failures.current += 1
    if (failures.current >= MAX_FAILURES) {
      failures.current = 0
      setPlaying(false)
      setNotice(failureLimitNotice, 'danger')
      return
    }
    next(wantPlay.current)
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
      setNotice('Press play when you are ready.', 'info')
    })
  }

  // Retry saves the queue as it is now, not as it was when the failure happened.
  // With nothing loaded there is no queue for Retry to send, so the toast goes without it.
  function queueSaveFailed() {
    setNotice(
      QUEUE_SAVE_FAILED,
      'warn',
      libraryCurrent.current ? { label: 'Retry', run: () => void saveQueue(true) } : undefined,
    )
  }

  // `announce` is for an edit the listener just made: it is the one save whose failure they need
  // to hear about, since the queue on screen would then differ from the one that restores.
  function persistQueue(body: string): Promise<Response | null> {
    queueWriter.current ??= new QueueWriter((replaced) => {
      const kind = replaced ? 'replaced' : 'failed'
      if (queueFailureShown.current === kind) return
      queueFailureShown.current = kind
      if (replaced) setNotice(QUEUE_REPLACED, 'warn')
      else queueSaveFailed()
    })

    return queueWriter.current.save(body).then((response) => {
      if (response?.ok) queueFailureShown.current = null
      return response
    })
  }

  function saveQueue(announce = false): Promise<boolean> {
    if (mode.current !== 'library' || !libraryCurrent.current) return Promise.resolve(false)
    const generation = ++queueSave.current
    const ids = queueRef.current.map((item) => item.id)
    const remembered = queueRef.current.flatMap((item) =>
      item.origin === 'deezer' && item.deezerId
        ? [
            {
              id: item.deezerId,
              title: item.title,
              artist: item.artist,
              album: item.album,
              duration: item.duration,
              art: item.coverArt ?? '',
            },
          ]
        : [],
    )
    const deckAtSave = deck.current
    const body = JSON.stringify({
      ids,
      current: libraryCurrent.current.id,
      position: Math.round((library()?.currentTime ?? 0) * 1000),
    })
    const write = () => persistQueue(body)
    const ready = remembered.length
      ? fetch('/api/player/account/tracks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tracks: remembered }),
        }).then((response) => {
          // A queue of dz- ids is dropped on restore when these rows were never saved.
          if (!response.ok) throw new Error('The queue could not be saved.')
        })
      : Promise.resolve()
    return ready
      .then(write)
      .then((response) => {
        if (!response) return false
        if (generation !== queueSave.current) return false
        if (!response.ok) {
          if (announce && response.status !== 409) queueSaveFailed()
          return false
        }
        // The deck fingerprint has to match the queue that was actually stored.
        if (deckAtSave && deck.current === deckAtSave) writeDeck(deckAtSave, ids)
        return true
      })
      .catch(() => {
        if (generation === queueSave.current && announce) queueSaveFailed()
        return false
      })
  }

  // What was queued by hand is not in the saved queue, which holds ids only. Keep it beside the
  // fingerprint of the queue it belongs to, and let the restore check that the two still match.
  function saveChosen() {
    const saved = encodeChosen(queueRef.current, chosen.current)
    if (saved) remember(CHOSEN_KEY, saved)
    else forget(CHOSEN_KEY)
  }

  // Tells the rest of the app which collection the queue counts as coming from right now. It
  // depends on the playing track, so it runs whenever that changes and whenever an edit lands.
  function publishSource() {
    const playing = libraryCurrent.current
    setSource(
      queueSource(
        sourceRef.current,
        editedRef.current,
        playing !== null && added.current.has(playing),
      ),
    )
  }

  function scrobble(submission: boolean) {
    const item = libraryCurrent.current
    // An account listen is not a library play.
    if (!item || item.origin === 'deezer') return
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
    // A library shuffle already has its order. Picking at random here would only see the window.
    if (shuffle && !deck.current && queue.length > 1) {
      const chosenAt = chosenIndex(queue, indexRef.current, chosen.current)
      if (chosenAt >= 0) return chosenAt
      let index: number
      do index = Math.floor(Math.random() * queue.length)
      while (index === indexRef.current)
      return index
    }
    const index = indexRef.current + 1
    if (index < queue.length) return index
    // Songs still waiting must not wrap around the window that happens to be loaded.
    if (deck.current && stillWaiting(deck.current) > 0) return -1
    if (repeat === 'all') return 0
    return -1
  }

  // Forgets what the standby element was loading and stops it downloading. Anything that changes
  // what plays next (an edit, shuffle, repeat) calls this; the next timeupdate loads the new pick.
  function discardPreload() {
    cancelHandover()
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
    // A crossfade is still playing its old track out of this element. A track too short to have
    // finished the overlap yet asks for its successor early, and must not cut that off.
    if (fadingOut.current?.element === element) return
    void extendDeck()
    discardPreload()
    // Repeat one plays the same song again, and loading it early makes that gapless too.
    const index = repeat === 'one' ? indexRef.current : nextIndex()
    const upcoming = queueRef.current[index]
    if (!upcoming || upcoming.origin === 'deezer') return
    const slot: Slot = activeSlot.current === 0 ? 1 : 0
    preload.current = { index, item: upcoming, slot, failed: false }
    // A metered connection gets the metadata only. The song then starts as it always did.
    element.preload = dataSaverOn() ? 'metadata' : 'auto'
    element.src = streamUrl(upcoming)
    applyVolume()
    // Ready well before the last second, when the handover is armed.
    handoverClock.current ??= createHandoverClock()
    handoverClock.current.warm()
  }

  function cancelHandover() {
    handoverClock.current?.cancel()
  }

  // Starts the standby element just before the playing one ends. The wait is kept by a worker, so a
  // hidden tab, which holds page timers to one a second, does not push it late. It is worked out
  // afresh from the element's own position on every timeupdate, and also on seek, play and rate
  // change, so each of those replaces the wait before it; a pause, a load or a discard cancels it.
  function scheduleHandover(active: HTMLAudioElement) {
    cancelHandover()
    const item = libraryCurrent.current
    const held = preload.current
    if (!item || !held || held.failed || active.paused) return
    if (!lengthsAgree(active.duration, item.duration)) return
    const delay = handoverDelay(secondsLeft(active), active.playbackRate)
    if (delay === null) return
    handoverClock.current ??= createHandoverClock()
    handoverClock.current.arm(delay, () => {
      // Checked again now: the wait belongs to the track and element it was made for, and to a
      // position still inside the last second.
      if (libraryCurrent.current !== item || library() !== active || active.paused) return
      if (secondsLeft(active) > HANDOVER_WINDOW_SECONDS) return
      finishTrack(active)
    })
  }

  // Starts the overlap when the playing track is within the listener's crossfade of its end and the
  // next one has loaded enough to play. Called on every timeupdate. The new track takes over at once,
  // everywhere (queue, scrobble, Media Session, seek bar), which is what `finishTrack` does; the old
  // one is left playing, quieter each tick, until the fade is done. If the next track is not ready
  // in time this never fires, and the ordinary handover does the job.
  function maybeCrossfade(active: HTMLAudioElement) {
    const item = libraryCurrent.current
    const held = preload.current
    const incoming = standby()
    if (!item || !held || held.failed || !incoming || active.paused || fadingOut.current) return
    if (held.item !== queueRef.current[held.index]) return
    if (incoming.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return
    // A sleep timer ending after this track means there is nothing to overlap into.
    if (sleepEndsAfterTrack()) return
    const span = crossfadeSpan({
      seconds: crossfadeSeconds,
      repeat,
      current: item,
      currentIndex: indexRef.current,
      upcoming: held.item,
      upcomingIndex: held.index,
      length: active.duration,
      left: secondsLeft(active),
    })
    if (span <= 0) return
    fadingOut.current = { element: active, item, index: indexRef.current, span, out: 1, in: 0 }
    finishTrack(active)
    ensureTicking()
  }

  // Ends the overlap: the old track's element stops and the new one goes to full level.
  function endCrossfade() {
    const fading = fadingOut.current
    if (!fading) return
    fadingOut.current = null
    fading.element.pause()
    applyVolume()
  }

  // A track has played to its end, or is about to. Its listen is reported and the next one starts,
  // unless a sleep timer ends here.
  function finishTrack(finished: HTMLAudioElement) {
    cancelHandover()
    // A track shorter than the listening threshold never reaches it, so its end counts. A
    // longer one that was scrubbed to its end without playing does not.
    if (finished.duration <= HISTORY_LISTEN_SECONDS) recordPlay()
    scrobble(true)
    if (sleepEndsAfterTrack()) {
      sleepAtTrackEnd(finished)
      return
    }
    if (repeat === 'one') loadLibrary(indexRef.current)
    else next()
  }

  // Whether a track or queue sleep timer ends when the playing track does.
  function sleepEndsAfterTrack() {
    const kind = sleepRef.current?.choice.kind
    if (kind === 'track') return true
    return kind === 'queue' && indexRef.current >= queueRef.current.length - 1
  }

  // The playing track ran out under a sleep timer. It has been reported like any finished track;
  // playback pauses, and the track that would have followed is loaded ready, so pressing play
  // carries on from there rather than replaying what the listener fell asleep to.
  function sleepAtTrackEnd(finished: HTMLAudioElement) {
    finished.pause()
    cancelHandover()
    if (repeat === 'one') loadLibrary(indexRef.current, false)
    else next(false)
    clearSleep()
    setNotice(SLEEP_ENDED_NOTICE, 'info')
    saveQueue()
  }

  // A minutes timer ran out, possibly in the middle of a track or a crossfade.
  function sleepPause() {
    cancelHandover()
    fadingOut.current?.element.pause()
    fadingOut.current = null
    for (const element of elements()) element?.pause()
    clearSleep()
    setNotice(SLEEP_ENDED_NOTICE, 'info')
  }

  // Forgets the timer and puts the level back. Whatever ends a timer calls this after it has paused,
  // so the level only comes back once nothing is playing.
  function clearSleep() {
    sleepRef.current = null
    sleepGain.current = 1
    setSleepChoice(null)
    applyVolume()
  }

  function startSleep(choice: SleepChoice | null) {
    if (!choice) {
      clearSleep()
      setNotice(SLEEP_CANCELLED_NOTICE, 'info')
      return
    }
    sleepGain.current = 1
    // The clock is the wall clock, so pausing does not stop a minutes timer.
    const endsAt = choice.kind === 'minutes' ? Date.now() + choice.minutes * 60_000 : 0
    sleepRef.current = { choice, endsAt }
    setSleepChoice(choice)
    setSleepLeft(choice.kind === 'minutes' ? choice.minutes * 60 : 0)
    setNotice(`Sleep timer set for ${sleepChoiceLabel(choice)}.`, 'info')
    ensureTicking()
  }

  // Seconds until the timer's fade should reach silence. Infinity while the timer is not in its last
  // stretch, which the fade reads as full level.
  function sleepSecondsLeft(timer: SleepTimer): number {
    if (timer.choice.kind === 'minutes') return (timer.endsAt - Date.now()) / 1000
    const playing = mode.current === 'library' ? library() : null
    if (!playing) return Infinity
    if (timer.choice.kind === 'queue' && indexRef.current < queueRef.current.length - 1)
      return Infinity
    return secondsLeft(playing)
  }

  function ensureTicking() {
    if (envelopeTimer.current !== undefined) return
    envelopeTimer.current = window.setInterval(() => tickRef.current(), ENVELOPE_TICK_MS)
  }

  // One step of the sleep fade and the crossfade. It reads refs only, because the interval that
  // calls it outlives the render it was made in.
  function tickEnvelope() {
    const timer = sleepRef.current
    if (timer) {
      const left = sleepSecondsLeft(timer)
      if (timer.choice.kind === 'minutes') {
        if (left <= 0) {
          sleepPause()
          return
        }
        setSleepLeft(Math.ceil(left))
      }
      sleepGain.current = rampDown(left, SLEEP_FADE_SECONDS)
    }
    const fading = fadingOut.current
    if (fading) {
      const left = secondsLeft(fading.element)
      if (fading.element.paused || left <= FADE_DONE_SECONDS) endCrossfade()
      else {
        const progress = 1 - left / fading.span
        fading.out = fadeOutGain(progress)
        fading.in = fadeInGain(progress)
      }
    }
    applyVolume()
    if (!sleepRef.current && !fadingOut.current) {
      window.clearInterval(envelopeTimer.current)
      envelopeTimer.current = undefined
    }
  }

  // A library track would not load or play. Skips to the next and says which, until too many in a
  // row have failed, which more likely means the music folder is out of reach than that every song is bad.
  function skipUnplayable() {
    const failed = libraryCurrent.current
    if (!failed) return
    failures.current += 1
    if (failures.current >= MAX_FAILURES) {
      failures.current = 0
      setNotice(failureLimitNotice, 'danger')
      return
    }
    next(wantPlay.current)
    setNotice(skippedNotice(failed.title), 'warn')
  }

  async function loadAccount(item: LibraryTrack, autoplay: boolean) {
    const deezerId = item.deezerId
    const generation = libraryLoads.current
    if (!deezerId) return
    accountRequest.current?.abort()
    const controller = new AbortController()
    accountRequest.current = controller
    setFetchingId(deezerId)
    setReady(false)
    setNotice('Fetching…')
    try {
      const result = await api(`player/account/${encodeURIComponent(item.id)}`, accountPlaySchema, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: item.title,
          artist: item.artist,
          album: item.album,
          duration: item.duration,
          art: item.coverArt ?? '',
        }),
        signal: controller.signal,
      })
      if (generation !== libraryLoads.current || controller.signal.aborted) return
      if (result.play === 'library' && result.id) {
        const looked = await api('library/tracks/lookup', librarySelectionSchema, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [result.id] }),
          signal: controller.signal,
        })
        const found = looked.items[0]
        if (generation !== libraryLoads.current || controller.signal.aborted) return
        if (found) {
          const previous = queueRef.current.find((row) => row.id === item.id)
          const queue = adoptLibraryTrack(queueRef.current, item.id, found)
          const adopted = queue.find((row) => row.id === found.id)
          if (previous && adopted) {
            if (chosen.current.delete(previous)) chosen.current.add(adopted)
            if (added.current.has(previous)) added.current.add(adopted)
          }
          queueRef.current = queue
          setQueue(queue)
          const playing = adopted ?? found
          libraryCurrent.current = playing
          setLibraryTrack(playing)
          setNotice(LIBRARY_NOTICE)
          startAudio(streamUrl(playing), autoplay)
          return
        }
      }

      if (result.play === 'account' && result.url) {
        setNotice('Deezer account')
        startAudio(result.url, autoplay)
        return
      }

      if (result.play === 'unavailable') {
        setNotice(result.detail || 'This song is not available on the Deezer account.', 'warn')
        next(autoplay)
        return
      }

      if (result.play === 'busy') {
        setNotice(result.detail || 'The Deezer account is busy.', 'warn')
        setPlaying(false)
        return
      }
      playPreviewKeepingQueue(item, result.detail, autoplay)
    } catch (error) {
      if (controller.signal.aborted || generation !== libraryLoads.current) return
      setNotice(
        error instanceof Error ? error.message : 'Deezer did not return the audio.',
        'danger',
      )
      setPlaying(false)
    } finally {
      if (accountRequest.current === controller) {
        accountRequest.current = null
        setFetchingId(null)
      }
    }
  }

  function playPreviewKeepingQueue(item: LibraryTrack, detail: string, autoplay: boolean) {
    const deezerId = item.deezerId
    if (!deezerId) return
    resumeQueue.current = true
    mode.current = 'preview'
    const synthetic = {
      id: deezerId,
      kind: 'track' as const,
      title: item.title,
      artist: item.artist,
      artist_id: 0,
      album: item.album,
      album_id: 0,
      art: item.coverArt ?? '',
      duration: item.duration,
      year: null,
      explicit: false,
      preview: '',
      isrc: '',
      spotify_id: '',
      popularity: 0,
      track_count: 0,
      record_type: '',
      ownership: 'missing' as const,
      matched_paths: [],
      matched_by: '' as const,
      matched_album: '',
      matched_song: '',
      owned_count: 0,
      coverage_verified: false,
      disc: 1,
      position: 1,
    }
    previewCurrent.current = synthetic
    setTrack(synthetic)
    setLibraryTrack(null)
    if (detail) setNotice(detail, 'warn')
    previewStage.current = 1
    void loadPreview(synthetic, false, autoplay)
  }

  function cancelFetch() {
    accountRequest.current?.abort()
    setFetchingId(null)
    setPlaying(false)
    setReady(false)
    const element = library()
    element?.pause()
    element?.removeAttribute('src')
    element?.load()
    setNotice('Press play when you are ready.', 'info')
  }

  function playCatalog(item: MusicResult) {
    if (!isDeezerTrack(item)) {
      play(item)
      return
    }

    if (fetchingId === item.id) {
      cancelFetch()
      return
    }

    if (
      mode.current === 'library' &&
      libraryCurrent.current?.origin === 'deezer' &&
      libraryCurrent.current.deezerId === item.id
    ) {
      toggle()
      return
    }

    if (!canAccountPlay(item, listenRef.current)) {
      play(item)
      return
    }
    playLibrary([toQueueTrack(item)], 0, `catalog:${item.id}`)
  }

  function playCatalogFrom(tracks: MusicResult[], index: number, origin = '') {
    const slice = tracks.slice(Math.max(0, index)).filter((item) => isDeezerTrack(item))
    if (!slice.some((item) => canAccountPlay(item, listenRef.current))) {
      const start = tracks[Math.max(0, index)]
      if (start) play(start)
      return
    }
    playLibrary(slice.map(toQueueTrack), 0, origin)
  }

  function loadLibrary(index: number, autoplay = true, seek = 0) {
    const item = queueRef.current[index]
    if (!item) return
    queueGeneration.current += 1
    setCanUndoBotQueue(false)
    request.current?.abort()
    cancelHandover()
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
    // A crossfade that starts this handover keeps the old track playing. Any other load ends one
    // that is still running: this one replaces both tracks.
    const crossfading = handOver && fadingOut.current?.element === outgoing
    if (!crossfading) fadingOut.current = null
    // Only one of the two plays at a time. The other element's pause event is
    // ignored once the mode has changed, so the state is set here instead. A track handed over
    // at its very end is left to finish its last moments rather than cut off.
    const finishing =
      handOver && outgoing && (crossfading || secondsLeft(outgoing) <= HANDOVER_WINDOW_SECONDS / 2)
    for (const element of elements()) {
      if (handOver && element === library()) continue
      if (finishing && element === outgoing) continue
      element?.pause()
    }
    setPlaying(false)
    mode.current = 'library'
    previewCurrent.current = null
    libraryCurrent.current = item
    libraryLoads.current += 1
    wantPlay.current = autoplay
    chosen.current.delete(item)
    saveChosen()
    publishSource()
    indexRef.current = index
    void extendDeck()
    pendingSeek.current = seek
    lastSavedSecond.current = -1
    recorded.current = false
    setTrack(null)
    setLibraryTrack(item)
    setCurrentIndex(index)
    setPosition(seek)
    setLength(item.duration || 0)
    setNotice(item.origin === 'deezer' ? 'Deezer account' : LIBRARY_NOTICE)
    if (item.origin === 'deezer') {
      discardPreload()
      // The element may still be holding the previous song. A press while this fetch
      // runs has to cancel the wait, not start that song.
      const element = library()
      element?.pause()
      element?.removeAttribute('src')
      element?.load()
      void loadAccount(item, autoplay)
      return
    }

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
        // The browser will not start this element from a script. Go back to the one that will. A
        // crossfade cannot happen then, so the old track is cut for the new one as it was before.
        standbyBlocked.current = true
        fadingOut.current = null
        activate(outgoingSlot)
        incoming.removeAttribute('src')
        incoming.load()
        applyVolume()
        startAudio(streamUrl(item))
        return
      }
      setNotice('Press play when you are ready.', 'info')
    })
  }

  function writeDeck(value: Deck | null, queueIds: string[]) {
    if (!value) {
      forget(DECK_KEY)
      return
    }

    try {
      localStorage.setItem(DECK_KEY, JSON.stringify({ ...value, queue: queueIds }))
    } catch {
      /* No fingerprint for a queue this browser could not store. */
    }
  }

  function clearDeck() {
    if (!deck.current) return
    deck.current = null
    writeDeck(null, [])
  }

  // Pulls the next songs of a library shuffle into the queue, dropping played ones when the
  // saved queue is full. A finished pass starts again, leaving out songs still queued.
  // Callers share one request, so a track that ends mid-lookup waits for the same result.
  function extendDeck(): Promise<ExtendResult> {
    if (extendJob.current) return extendJob.current
    const job = runExtend()
    extendJob.current = job
    void job.finally(() => {
      if (extendJob.current === job) extendJob.current = null
    })

    return job
  }

  async function runExtend(): Promise<ExtendResult> {
    const current = deck.current
    // No seed: the whole pass is already in the queue, or the server forgot the order.
    if (!current || !current.seed) return 'idle'
    const queue = queueRef.current
    const index = indexRef.current
    const waiting = stillWaiting(current)
    if (!needsMore(queue.length, index, waiting)) return 'idle'
    // Repeat plays this queue again. There is nothing further to fetch.
    if (waiting === 0 && queue.length >= current.total) return 'idle'
    // Dropping every played song still has to leave the one that is playing, so this is the
    // most that can be added without the saved queue refusing the lot.
    const room = QUEUE_LIMIT - (queue.length - index)
    if (room <= 0) return 'idle'
    const limit = Math.min(SHUFFLE_FETCH, room)
    try {
      const page = await api('library/tracks/shuffle', libraryShuffleWindowSchema, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          seed: current.seed,
          cursor: current.cursor,
          limit,
          // A finished pass starts again without the songs still queued.
          skip: waiting === 0 ? queue.map((item) => item.id) : [],
        }),
      })
      if (deck.current !== current) return 'idle'
      current.seed = page.seed
      current.cursor = page.cursor
      current.total = page.total
      const tracks = page.items
      if (!tracks.length) {
        if (!page.missing.length) current.seed = ''
        return page.missing.length ? 'skipped' : 'idle'
      }
      const drop = dropForRoom(queueRef.current.length, indexRef.current, tracks.length)
      const nextQueue = [...queueRef.current.slice(drop), ...tracks]
      const nextAt = indexRef.current - drop
      queueRef.current = nextQueue
      indexRef.current = nextAt
      // Dropping played songs shifts every index, so a preloaded next song would be the wrong one.
      if (drop > 0) discardPreload()
      setQueue(nextQueue)
      setCurrentIndex(nextAt)
      void saveQueue()
      return 'added'
    } catch (error: unknown) {
      if (deck.current !== current) return 'idle'
      // A restart dropped the order. The songs already queued still play in that order.
      if (error instanceof ApiError && error.code === 'shuffle_expired') {
        current.seed = ''
        current.cursor = current.total
        return 'idle'
      }
      return 'failed'
    }
  }

  // The loaded window ran out while more songs are still on the way. Wait for them, then play.
  // A song picked or a stop while it waits wins: playing on from the old spot would undo it.
  async function fillThenPlay(autoplay: boolean) {
    const startDeck = deck.current
    const startLoads = libraryLoads.current
    const movedOn = () => deck.current !== startDeck || libraryLoads.current !== startLoads
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const before = queueRef.current.length
      const result = await extendDeck()
      if (movedOn()) return
      if (queueRef.current.length > before) break
      if (result !== 'skipped') break
    }
    const index = nextIndex()
    if (index >= 0) loadLibrary(index, autoplay)
    else setPlaying(false)
  }

  function playLibrary(items: LibraryTrack[], index = 0, origin = '') {
    if (!items.length) return
    failures.current = 0
    // Playing a row of the queue itself keeps the queue, what was chosen by hand in it, and where
    // it came from. Any other list starts a queue of its own.
    if (items !== queueRef.current) {
      clearDeck()
      chosen.current.clear()
      sourceRef.current = origin
      editedRef.current = false
      setEdited(false)
    }
    queueRef.current = items
    setQueue(items)
    loadLibrary(Math.max(0, Math.min(index, items.length - 1)))
  }

  // Every edit lands here: the new order, where the playing track now sits, and the save. The queue
  // keeps the collection it began as, marked edited, for as long as the playing track is one of
  // that collection's own.
  function editQueue(items: LibraryTrack[], index: number) {
    queueGeneration.current += 1
    setCanUndoBotQueue(false)
    // A hand edit ends a library shuffle. The queue on screen is the whole queue again.
    clearDeck()
    queueRef.current = items
    indexRef.current = index
    editedRef.current = true
    // What plays next may have changed, so what the standby element loaded may be wrong.
    discardPreload()
    setQueue(items)
    setCurrentIndex(index)
    setEdited(true)
    publishSource()
    saveChosen()
    saveQueue(true)
  }

  function enqueue(tracks: LibraryTrack[], upNext: boolean) {
    if (!tracks.length) return
    const inQueue = libraryCurrent.current ? queueRef.current.length : 0
    const refusal = queueOverflow(inQueue, tracks.length)
    if (refusal) {
      setNotice(refusal, 'warn')
      return
    }
    const entries = tracks.map((track) => ({ ...track }))
    // With nothing loaded there is no queue to join, so these songs become it.
    if (!libraryCurrent.current) {
      playLibrary(entries, 0, EDITED_SOURCE)
      return
    }

    for (const entry of entries) {
      chosen.current.add(entry)
      added.current.add(entry)
    }
    const queue = queueRef.current
    const at = upNext ? playNextPosition(queue, indexRef.current, chosen.current) : queue.length
    editQueue([...queue.slice(0, at), ...entries, ...queue.slice(at)], indexRef.current)
    const what = entries.length === 1 ? (entries[0]?.title ?? 'song') : songCount(entries.length)
    setNotice(upNext ? `Playing ${what} next.` : `Added ${what} to the queue.`, 'good')
  }

  const playNext = (tracks: LibraryTrack[]) => enqueue(tracks, true)
  const addToQueue = (tracks: LibraryTrack[]) => enqueue(tracks, false)

  function botStamp() {
    return `${queueGeneration.current}:${libraryLoads.current}:${indexRef.current}:${queueRef.current.map((item) => item.id).join(',')}`
  }

  function applyBotQueue(tracks: LibraryTrack[], action: BotQueueAction, expected: string) {
    // Check refs synchronously after validation, not the render that started the request.
    if (botStamp() !== expected) throw new Error('The queue changed. Ask again before applying.')
    if (!tracks.length) throw new Error('There are no songs to apply.')
    if (mode.current === 'preview' && previewCurrent.current)
      throw new Error('Close the catalog preview before applying a music bot selection.')
    const old = libraryCurrent.current ? queueRef.current : []
    const count =
      action === 'play' || !libraryCurrent.current
        ? 0
        : action === 'replace'
          ? indexRef.current + 1
          : old.length
    const refusal = queueOverflow(Math.max(0, count), tracks.length)
    if (refusal) throw new Error(refusal)
    const before = {
      tracks: [...old],
      index: indexRef.current,
      position: library()?.currentTime ?? 0,
      chosen: new Set(chosen.current),
      source: sourceRef.current,
      // Clone: an in-flight window fetch may still hold the former object after the edit.
      deck: deck.current ? { ...deck.current } : null,
      edited: editedRef.current,
    }
    if (action === 'play')
      playLibrary(
        tracks.map((item) => ({ ...item })),
        0,
        'music-bot',
      )
    else if (action === 'replace' && libraryCurrent.current) {
      chosen.current.clear()
      const entries = tracks.map((item) => ({ ...item }))
      for (const entry of entries) {
        chosen.current.add(entry)
        added.current.add(entry)
      }
      editQueue([...old.slice(0, indexRef.current + 1), ...entries], indexRef.current)
    } else enqueue(tracks, action === 'next')
    botUndo.current = { ...before, stamp: botStamp() }
    setCanUndoBotQueue(true)
    void saveQueue(true)
  }

  function undoBotQueue() {
    const before = botUndo.current
    if (!before || before.stamp !== botStamp()) {
      setCanUndoBotQueue(false)
      throw new Error('The queue changed after that edit. Undo will not overwrite it.')
    }
    botUndo.current = null
    setCanUndoBotQueue(false)
    const sameSong =
      before.tracks.length > 0 && before.tracks[before.index] === libraryCurrent.current
    chosen.current = before.chosen
    sourceRef.current = before.source
    editedRef.current = before.edited
    queueRef.current = before.tracks
    indexRef.current = before.index
    discardPreload()
    setQueue(before.tracks)
    setCurrentIndex(before.index)
    setEdited(before.edited)
    saveChosen()
    publishSource()
    if (!before.tracks.length) {
      libraryCurrent.current = null
      stop()
      queueSave.current += 1
      void persistQueue(JSON.stringify({ ids: [], current: '', position: 0 }))
        .then((response) => {
          if (response && !response.ok && response.status !== 409) queueSaveFailed()
        })
        .catch(() => queueSaveFailed())
    } else {
      // Upcoming edits leave the playing element and its clock untouched. Undoing Play restores
      // the former song paused, so a delayed Undo never promises a browser autoplay success.
      // The deck is restored after the load, so that load does not fetch another shuffle window.
      if (!sameSong) loadLibrary(before.index, false, before.position)
      deck.current = before.deck
      void saveQueue(true)
    }
    setNotice('Queue edit undone.', 'info')
  }

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
    // What is left is one song and nothing to say it came with a collection.
    sourceRef.current = EDITED_SOURCE
    editQueue([playing], 0)
  }

  function shuffleLibrary(items: LibraryTrack[], origin = '') {
    if (!items.length) return
    setShuffle(true)
    playLibrary(items, Math.floor(Math.random() * items.length), origin)
  }

  function playDeck(
    items: LibraryTrack[],
    seed: string,
    total: number,
    cursor: number,
    origin = '',
  ) {
    if (!items.length) return
    setShuffle(true)
    playLibrary(items, 0, origin)
    const count = total > 0 ? total : items.length
    // The deck is what stops the shuffle toggle from picking at random inside this window.
    deck.current = {
      seed,
      cursor: cursor > 0 ? cursor : items.length,
      total: count,
    }
    void saveQueue()
    setNotice(`Shuffling ${count.toLocaleString()} songs.`, 'info')
  }

  function toggle() {
    if (accountRequest.current) {
      cancelFetch()
      return
    }
    const element = current()
    const hasItem = mode.current === 'library' ? libraryCurrent.current : previewCurrent.current
    if (!element || !hasItem) return
    if (!element.paused) {
      // Pausing in the middle of a crossfade cuts the old track rather than freezing two.
      endCrossfade()
      element.pause()
    } else if (element.ended && deck.current) void fillThenPlay(true)
    else if (element.getAttribute('src'))
      void element.play().catch(() => setNotice('Cannot play this track.', 'danger'))
    else if (previewCurrent.current) {
      previewStage.current = 1
      void loadPreview(previewCurrent.current, false)
    }
  }

  function play(item: MusicResult) {
    resumeQueue.current = false
    if (
      mode.current === 'preview' &&
      previewCurrent.current &&
      previewIdentity(previewCurrent.current) === previewIdentity(item) &&
      previewAudio.current?.src
    ) {
      toggle()
      return
    }
    request.current?.abort()
    for (const element of elements()) element?.pause()
    fadingOut.current = null
    // A preview has no end of track or queue for a timer to wait for. A minutes timer still holds.
    if (sleepRef.current && sleepRef.current.choice.kind !== 'minutes') clearSleep()
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
      setNotice(item.spotify_id ? 'Spotify preview' : 'Deezer preview')
      setPreviewStates((prev) => new Map(prev).set(previewIdentity(item), 'ready'))
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
    else if (deck.current) void fillThenPlay(autoplay)
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

  // The interval reads the latest render's copy, not the one it was started from.
  tickRef.current = tickEnvelope

  // What the control shows. A track's time left is the seek bar's own clock; an album or queue adds
  // the songs still to come; a minutes timer counts down on its own.
  const trackLeft = Math.max(0, length - position)
  const sleep: SleepStatus | null = sleepChoice
    ? {
        choice: sleepChoice,
        remaining:
          sleepChoice.kind === 'minutes'
            ? sleepLeft
            : sleepChoice.kind === 'track'
              ? trackLeft
              : trackLeft +
                queue.slice(currentIndex + 1).reduce((total, item) => total + item.duration, 0),
      }
    : null

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
    if (shuffle) clearDeck()
    setShuffle(!shuffle)
  }

  function cycleRepeat() {
    setRepeat(repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off')
  }

  function stop() {
    request.current?.abort()
    saveQueue()
    clearDeck()
    cancelHandover()
    preload.current = null
    failures.current = 0
    previewCurrent.current = null
    libraryCurrent.current = null
    sourceRef.current = ''
    editedRef.current = false
    setSource('')
    setEdited(false)
    fadingOut.current = null
    for (const element of elements()) {
      element?.pause()
      element?.removeAttribute('src')
      element?.load()
    }
    // Closing the player ends any timer with it.
    clearSleep()
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
        const savedDeck = readDeck(saved.entry.map((item) => item.id))
        if (savedDeck) {
          deck.current = savedDeck
          setShuffle(true)
        }
        sourceRef.current = RESTORED_SOURCE
        // Only the ids came back, so the songs queued by hand are found again by their places.
        // They are dropped, not guessed at, when the queue is no longer the one they were saved for.
        chosen.current = decodeChosen(saved.entry, stored(CHOSEN_KEY, ''))
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
      if (library() && !library()?.paused) void resumeAudio()
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
    // With either on there is no last track to wait for, so an end of queue timer could never fire.
    if (sleepRef.current?.choice.kind === 'queue' && (shuffle || repeat !== 'off')) {
      clearSleep()
      setNotice(SLEEP_QUEUE_LOST_NOTICE, 'warn')
    }
  }, [shuffle, repeat])

  // Nothing is left ticking once the player is gone.
  useEffect(
    () => () => {
      window.clearInterval(envelopeTimer.current)
      handoverClock.current?.dispose()
    },
    [],
  )

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
  // The seek and volume bars draw their played portion from --progress, since WebKit has no
  // pseudo-element for a range's progress.
  const seekStyle = {
    '--progress': `${Math.min(100, (Math.min(position, seekMax) / seekMax) * 100).toFixed(2)}%`,
  } as CSSProperties
  const volumeStyle = { '--progress': `${(muted ? 0 : volume) * 100}%` } as CSSProperties

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
      const { height } = footer.getBoundingClientRect()
      // The phone's mini player floats above the tab bar with a gap under it, and that gap is
      // as much room as the player takes. Hidden, it takes none.
      const gap = height ? Number.parseFloat(getComputedStyle(footer).marginBottom) || 0 : 0
      document.documentElement.style.setProperty('--player-height', `${height + gap}px`)
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
    <img className="size-[48px] rounded-md max-phone:size-[40px]" src={activeArt} alt="" />
  ) : (
    <span className="grid size-[48px] place-items-center rounded-md bg-sunken max-phone:size-[40px]">
      <Disc3 size={24} className="text-faint" />
    </span>
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
        // The gain stage exists only once this has run, so the level is applied again after it.
        void routeToAnalyser(element).then(applyVolume)
        // A resume in the last second arms the handover now rather than at the next timeupdate.
        scheduleHandover(element)
      },
      // A track that has started playing ends a run of failures.
      onPlaying: () => {
        if (inPlay() && forLibrary) failures.current = 0
      },
      onPause: (event: MediaEvent) => {
        if (!inPlay()) return
        cancelHandover()
        setPlaying(false)
        saveQueue()
        if (forLibrary) publishPosition(event.currentTarget)
      },
      onSeeked: (event: MediaEvent) => {
        if (!inPlay() || !forLibrary) return
        publishPosition(event.currentTarget)
        // The end has moved, so the wait made for the old position is replaced.
        scheduleHandover(event.currentTarget)
      },
      // At another rate the same seconds of track pass in more or less time.
      onRateChange: (event: MediaEvent) => {
        if (inPlay() && forLibrary) scheduleHandover(event.currentTarget)
      },
      onEnded: (event: MediaEvent) => {
        if (!inPlay()) return
        if (!forLibrary) {
          setPlaying(false)
          continueAfterPreview(false)
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
        maybeCrossfade(element)
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
          void loadPreview(item, previewStage.current === 2, previewAutoplay.current)
        } else {
          setNotice('No playable preview available.', 'danger')
          continueAfterPreview(true)
        }
      },
    }
  }

  function retryQueueSave() {
    void saveQueue(true).then((saved) => {
      if (!saved) return
      setNoticeText((now) => (now === QUEUE_SAVE_FAILED ? LIBRARY_NOTICE : now))
      // The failure's toast says the queue is not saved; it must not outlive the save that fixed it.
      toasts.current.get(QUEUE_SAVE_FAILED)?.()
      toasts.current.delete(QUEUE_SAVE_FAILED)
    })
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
        edited,
        currentIndex,
        playing,
        position,
        length,
        shuffle,
        repeat,
        play,
        playCatalog,
        playCatalogFrom,
        fetchingId,
        cancelFetch,
        listen,
        playLibrary,
        shuffleLibrary,
        playDeck,
        playNext,
        addToQueue,
        removeFromQueue,
        moveInQueue,
        clearQueue,
        botStamp,
        applyBotQueue,
        undoBotQueue,
        canUndoBotQueue,
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
        previewState: (trackId, spotifyId = '') =>
          previewStates.get(previewIdentity({ id: trackId, spotify_id: spotifyId })),
        openPlaylistPicker: openPlaylistDialog,
        notice,
        stop,
        sleep,
        setSleep: startSleep,
        retryQueueSave,
      }}
    >
      {children}
      <footer
        ref={footerRef}
        // The attribute rather than a `hidden` utility: Tailwind's base layer gives it
        // `display: none !important`, so it wins over the footer's own `grid` in any order.
        hidden={hidden}
        className={cx(footerClassName, !activeTitle && 'max-phone:hidden')}
      >
        {/* Left: the cover, what is playing, like. */}
        <div className="flex min-w-0 items-center gap-[12px] text-small max-phone:flex-1 max-phone:gap-[10px] [&_a:hover]:underline">
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
            <strong className="block truncate text-body font-semibold">
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
              <small className="mt-[3px] block truncate text-small text-muted max-phone:mt-[1px] max-phone:max-w-full max-phone:leading-[1.3]">
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
                  <span>
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
                  </span>
                )}
              </small>
            )}
          </span>
          {isLibrary && (
            <IconButton
              active={isLiked}
              // The label already says which way the press goes, so a pressed state on top of it
              // would be read out twice.
              aria-pressed={undefined}
              aria-label={
                isLiked ? `Remove ${activeTitle} from liked` : `Add ${activeTitle} to liked`
              }
              className="max-phone:hidden"
              disabled={!canToggleLiked || playlistSongs.busy(likedPlaylist.data?.id ?? '')}
              size="compact"
              onClick={() => toggleLikedTrack()}
            >
              <ThumbsUp size={16} fill={isLiked ? 'currentColor' : 'none'} />
            </IconButton>
          )}
        </div>
        {/* Middle: the transport, with the progress bar under it. On a phone only play and next
            stay, and the bar leaves the row to run along the player's top edge, where the
            handwritten rules in style.css draw its track from --progress. */}
        <div className="playback-controls flex flex-col items-center gap-[6px] max-phone:contents">
          <div className="flex items-center gap-[8px] text-muted max-phone:gap-[2px]">
            {isLibrary && (
              <IconButton
                active={shuffle}
                size="compact"
                aria-label="Shuffle"
                className="max-phone:hidden"
                onClick={toggleShuffle}
              >
                <Shuffle size={16} />
              </IconButton>
            )}
            {isLibrary ? (
              <IconButton
                size="compact"
                className="max-phone:hidden"
                aria-label="Previous track"
                onClick={previous}
              >
                <SkipBack size={17} fill="currentColor" />
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
                    void element
                      .play()
                      .catch(() => setNotice('Press play when you are ready.', 'info'))
                  }
                }}
              >
                <RotateCcw size={16} />
              </IconButton>
            )}
            <button
              type="button"
              data-ui="icon-button"
              data-variant="play"
              className="inline-flex size-[38px] shrink-0 items-center justify-center rounded-pill border-0 bg-accent p-0 text-accent-ink coarse:min-h-11 coarse:min-w-11 max-phone:size-[44px] max-phone:bg-transparent max-phone:text-text"
              aria-label={
                isLibrary
                  ? playing
                    ? 'Pause'
                    : 'Play'
                  : playing
                    ? 'Pause preview'
                    : 'Play preview'
              }
              disabled={!activeTitle}
              onClick={toggle}
            >
              {playing ? (
                <Pause size={18} fill="currentColor" />
              ) : (
                <Play size={18} fill="currentColor" />
              )}
            </button>
            {isLibrary && (
              <IconButton
                size="compact"
                className="max-phone:size-[44px]"
                aria-label="Next track"
                onClick={() => next()}
              >
                <SkipForward size={17} fill="currentColor" />
              </IconButton>
            )}
            {isLibrary && (
              <IconButton
                active={repeat !== 'off'}
                size="compact"
                className="max-phone:hidden"
                aria-label={`Repeat ${repeat}`}
                onClick={cycleRepeat}
              >
                <Repeat size={16} />
                {repeat === 'one' && (
                  <small className="absolute mt-[5px] block translate-x-[7px] translate-y-[7px] text-micro text-accent">
                    1
                  </small>
                )}
              </IconButton>
            )}
          </div>
          <div className="flex w-full max-w-[520px] items-center gap-[10px] text-tiny text-faint tabular-nums max-phone:contents">
            <span className="w-[36px] shrink-0 text-right max-phone:hidden">
              {durationText(position)}
            </span>
            <input
              className="h-[16px] min-w-0 flex-1 appearance-none bg-transparent accent-accent max-phone:absolute max-phone:top-[-5px] max-phone:left-[8px] max-phone:m-0 max-phone:block max-phone:h-[13px] max-phone:w-[calc(100%-16px)] max-phone:flex-none max-phone:disabled:opacity-60"
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
            <span className="w-[36px] shrink-0 max-phone:hidden">{durationText(length)}</span>
          </div>
        </div>
        {/* Right: playlist, queue, volume, expand, and the close that ends playback. A phone
            keeps only the close. */}
        <div className="flex items-center justify-end gap-[4px] text-muted max-phone:contents">
          {isLibrary && (
            <IconButton
              aria-label={`Add ${activeTitle} to a playlist`}
              className="max-phone:hidden"
              disabled={!isLibrary}
              size="compact"
              onClick={() => openPlaylistDialog()}
            >
              <Plus size={17} />
            </IconButton>
          )}
          {isLibrary && (
            // The queue lives on Now Playing, so this is a link there.
            <Link
              data-ui="icon-button"
              className={iconButtonClassName(false, 'shrink-0 max-phone:hidden', 'compact')}
              aria-label="Queue"
              to="/now-playing"
            >
              <ListMusic size={17} />
            </Link>
          )}
          <IconButton
            size="compact"
            className="max-phone:hidden"
            aria-label={
              isLibrary ? (muted ? 'Unmute' : 'Mute') : muted ? 'Unmute preview' : 'Mute preview'
            }
            onClick={toggleMute}
          >
            {muted || volume === 0 ? <VolumeX size={17} /> : <Volume2 size={17} />}
          </IconButton>
          <input
            className="mx-[2px] h-[16px] w-[90px] appearance-none bg-transparent accent-accent max-tablet:w-[56px] max-phone:hidden"
            type="range"
            aria-label={isLibrary ? 'Volume' : 'Preview volume'}
            min="0"
            max="1"
            step="0.01"
            value={muted ? 0 : volume}
            style={volumeStyle}
            onChange={(event) => changeVolume(Number(event.target.value))}
          />
          {isLibrary && (
            // The cover beside the title is the link. This icon shows only where the cover does
            // too, so it is a second way to click, not a second stop for a keyboard or a reader.
            <Link
              data-ui="icon-button"
              className={iconButtonClassName(
                false,
                'shrink-0 max-tablet:hidden max-phone:hidden',
                'compact',
              )}
              aria-hidden="true"
              tabIndex={-1}
              to="/now-playing"
            >
              <Maximize2 size={16} />
            </Link>
          )}
          {(track || libraryTrack) && (
            <IconButton
              size="compact"
              className="max-phone:size-[44px]"
              aria-label={isLibrary ? 'Close player' : 'Close preview'}
              onClick={stop}
            >
              <X size={16} />
            </IconButton>
          )}
        </div>
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
        <PlaylistPicker
          dialogRef={playlistDialog}
          onClose={closePlaylistDialog}
          onClosed={() => setPickerOpen(false)}
          trackId={libraryTrack?.id ?? ''}
          trackTitle={activeTitle ?? 'this track'}
          trackArt={activeArt}
          search={playlistSearch}
          onSearch={setPlaylistSearch}
          loading={allPlaylists.isLoading}
          loadError={allPlaylists.isError ? allPlaylists.error.message : undefined}
          rows={availablePlaylists.map((playlist) => ({
            playlist,
            songs: songsByPlaylist.get(playlist.id),
            failed: failedPlaylists.has(playlist.id),
            busy: playlistSongs.busy(playlist.id),
          }))}
          matching={matchingPlaylists.length}
          limit={PICKER_ROWS}
          blocked={createBusy}
          expanded={expandedPlaylist}
          onExpand={setExpandedPlaylist}
          onRetry={(playlistId) =>
            void playlistDetails[
              availablePlaylists.findIndex((playlist) => playlist.id === playlistId)
            ]?.refetch()
          }
          onToggleTrack={togglePlaylistTrack}
          onRemoveSong={(playlistId, index) => playlistSongs.mutation.mutate({ playlistId, index })}
          newName={newPlaylistName}
          onNewName={setNewPlaylistName}
          onCreate={submitNewPlaylist}
          createBusy={createBusy}
          changeError={playlistSongs.mutation.error?.message || createPlaylist.error?.message}
        />
      )}
    </PlayerContext.Provider>
  )
}
