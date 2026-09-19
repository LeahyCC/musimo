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
  // Two elements, one per mode. Previews stream from the provider's CDN without
  // CORS headers, and the Web Audio analyser the visualizer needs would silence
  // such media for good, so only the library element ever feeds it.
  const previewAudio = useRef<HTMLAudioElement>(null)
  const libraryAudio = useRef<HTMLAudioElement>(null)
  const request = useRef<AbortController | null>(null)
  const previewCurrent = useRef<MusicResult | null>(null)
  const libraryCurrent = useRef<LibraryTrack | null>(null)
  const queueRef = useRef<LibraryTrack[]>([])
  const indexRef = useRef(-1)
  const sourceRef = useRef('')
  const mode = useRef<'preview' | 'library'>('preview')
  const current = () => (mode.current === 'library' ? libraryAudio.current : previewAudio.current)
  const elements = () => [previewAudio.current, libraryAudio.current]
  const previewStage = useRef(0)
  const pendingSeek = useRef(0)
  const lastSavedSecond = useRef(-1)
  const footerRef = useRef<HTMLElement>(null)
  const [track, setTrack] = useState<MusicResult | null>(null)
  const [libraryTrack, setLibraryTrack] = useState<LibraryTrack | null>(null)
  const [queue, setQueue] = useState<LibraryTrack[]>([])
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
    if (autoplay) void element.play().catch(() => setNotice('Press play when you are ready.'))
  }

  function saveQueue() {
    if (mode.current !== 'library' || !libraryCurrent.current) return
    void fetch('/api/player/queue', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: queueRef.current.map((item) => item.id),
        current: libraryCurrent.current.id,
        position: Math.round((libraryAudio.current?.currentTime ?? 0) * 1000),
      }),
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

  function loadLibrary(index: number, autoplay = true, seek = 0) {
    const item = queueRef.current[index]
    if (!item) return
    request.current?.abort()
    // Only one of the two plays at a time. The other element's pause event is
    // ignored once the mode has changed, so the state is set here instead.
    for (const element of elements()) element?.pause()
    setPlaying(false)
    mode.current = 'library'
    previewCurrent.current = null
    libraryCurrent.current = item
    indexRef.current = index
    pendingSeek.current = seek
    lastSavedSecond.current = -1
    setTrack(null)
    setLibraryTrack(item)
    setCurrentIndex(index)
    setPosition(seek)
    setLength(item.duration || 0)
    setNotice(LIBRARY_NOTICE)
    startAudio(`/api/player/stream/${encodeURIComponent(item.id)}`, autoplay)
  }

  function playLibrary(items: LibraryTrack[], index = 0, origin = '') {
    if (!items.length) return
    queueRef.current = items
    sourceRef.current = origin
    setQueue(items)
    setSource(origin)
    loadLibrary(Math.max(0, Math.min(index, items.length - 1)))
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
    let index = indexRef.current + 1
    if (shuffle && queueRef.current.length > 1) {
      do index = Math.floor(Math.random() * queueRef.current.length)
      while (index === indexRef.current)
    } else if (index >= queueRef.current.length && repeat === 'all') index = 0
    if (index < queueRef.current.length) loadLibrary(index, autoplay)
    else setPlaying(false)
  }

  function previous() {
    if (mode.current !== 'library') return
    if ((libraryAudio.current?.currentTime ?? 0) > 4) {
      if (libraryAudio.current) libraryAudio.current.currentTime = 0
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

  useEffect(() => {
    const value = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.7
    for (const element of elements()) {
      if (!element) continue
      element.volume = value
      element.muted = muted
    }
    remember('musimo.player-volume', String(value))
  }, [volume, muted])

  // Browsers suspend the audio context while a tab is hidden for a while, or on
  // iOS when another app takes the output. Wake it when the tab comes back.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || mode.current !== 'library') return
      if (libraryAudio.current && !libraryAudio.current.paused)
        void audioGraph().then((module) => module.resumeAudio())
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  useEffect(() => {
    remember('musimo.player-shuffle', String(shuffle))
    remember('musimo.player-repeat', repeat)
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

  // Both elements share these. Each ignores events while the other mode is
  // current, so a preview pausing as a library track starts cannot mark that
  // track paused, and a stale timeupdate cannot move the seek bar.
  function mediaHandlers(which: 'preview' | 'library') {
    type MediaEvent = SyntheticEvent<HTMLAudioElement>
    const library = which === 'library'
    return {
      onLoadedMetadata: (event: MediaEvent) => {
        if (mode.current !== which) return
        setReady(true)
        if (pendingSeek.current) {
          event.currentTarget.currentTime = pendingSeek.current
          pendingSeek.current = 0
        }
      },
      onPlay: (event: MediaEvent) => {
        if (mode.current !== which) return
        setPlaying(true)
        if (!library) return
        scrobble(false)
        const element = event.currentTarget
        void audioGraph().then((module) => module.attachAudio(element))
      },
      onPause: () => {
        if (mode.current !== which) return
        setPlaying(false)
        saveQueue()
      },
      onEnded: () => {
        if (mode.current !== which) return
        if (!library) {
          setPlaying(false)
          return
        }
        scrobble(true)
        if (repeat === 'one') loadLibrary(indexRef.current)
        else next()
      },
      onTimeUpdate: (event: MediaEvent) => {
        if (mode.current !== which) return
        const seconds = event.currentTarget.currentTime
        setPosition(seconds)
        if (library && Math.floor(seconds / 10) !== lastSavedSecond.current) {
          lastSavedSecond.current = Math.floor(seconds / 10)
          saveQueue()
        }
      },
      onDurationChange: (event: MediaEvent) => {
        if (mode.current !== which) return
        const { duration } = event.currentTarget
        if (Number.isFinite(duration)) setLength(duration)
      },
      onError: () => {
        if (mode.current !== which) return
        setPlaying(false)
        setReady(false)
        if (library) {
          setNotice('This library track could not be played.')
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
        <audio
          ref={libraryAudio}
          className="library-audio"
          preload="metadata"
          {...mediaHandlers('library')}
        />
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
