import { createContext, type FormEvent, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
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
import type { LibraryTrack, MusicResult } from './api'

type RepeatMode = 'off' | 'all' | 'one'
type Playback = {
  track: MusicResult | null
  libraryTrack: LibraryTrack | null
  queue: LibraryTrack[]
  currentIndex: number
  playing: boolean
  position: number
  length: number
  shuffle: boolean
  repeat: RepeatMode
  play: (track: MusicResult) => void
  playLibrary: (tracks: LibraryTrack[], index?: number) => void
  shuffleLibrary: (tracks: LibraryTrack[]) => void
  next: () => void
  previous: () => void
}
const PlayerContext = createContext<Playback>({
  track: null,
  libraryTrack: null,
  queue: [],
  currentIndex: -1,
  playing: false,
  position: 0,
  length: 0,
  shuffle: false,
  repeat: 'off',
  play: () => undefined,
  playLibrary: () => undefined,
  shuffleLibrary: () => undefined,
  next: () => undefined,
  previous: () => undefined,
})
export const usePlayer = () => useContext(PlayerContext)

export const durationText = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

const artUrl = (track: LibraryTrack) =>
  track.coverArt ? `/api/player/art/${encodeURIComponent(track.coverArt)}` : ''

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

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audio = useRef<HTMLAudioElement>(null)
  const request = useRef<AbortController | null>(null)
  const previewCurrent = useRef<MusicResult | null>(null)
  const libraryCurrent = useRef<LibraryTrack | null>(null)
  const queueRef = useRef<LibraryTrack[]>([])
  const indexRef = useRef(-1)
  const mode = useRef<'preview' | 'library'>('preview')
  const previewStage = useRef(0)
  const pendingSeek = useRef(0)
  const lastSavedSecond = useRef(-1)
  const [track, setTrack] = useState<MusicResult | null>(null)
  const [libraryTrack, setLibraryTrack] = useState<LibraryTrack | null>(null)
  const [queue, setQueue] = useState<LibraryTrack[]>([])
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
  const selectedPlaylistIndex = isLibraryTrack
    ? (likedPlaylist.data?.entry ?? []).findIndex((item) => item.id === libraryTrack?.id)
    : -1
  const isLiked = selectedPlaylistIndex >= 0
  const addToLiked = useMutation({
    mutationFn: ({ trackId, shouldAdd }: { trackId: string; shouldAdd: boolean }) => {
      const playlist = likedPlaylist.data
      if (!playlist) throw new Error('Liked playlist is not loaded.')
      if (!shouldAdd && selectedPlaylistIndex < 0) {
        throw new Error('Track is not in the liked playlist.')
      }
      const body = shouldAdd
        ? { song_id_to_add: trackId }
        : { song_index_to_remove: selectedPlaylistIndex }
      return api(
        `library/playlists/${encodeURIComponent(playlist.id)}/songs`,
        libraryPlaylistDetailSchema,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['library-playlist-liked'] })
      void queryClient.invalidateQueries({ queryKey: ['library-playlists'] })
    },
  })
  const addToPlaylist = useMutation({
    mutationFn: ({ playlistId, songId }: { playlistId: string; songId: string }) =>
      api(
        `library/playlists/${encodeURIComponent(playlistId)}/songs`,
        libraryPlaylistDetailSchema,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ song_id_to_add: songId }),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['library-playlists'] })
      void queryClient.invalidateQueries({ queryKey: ['library-playlist-liked'] })
    },
  })
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
      playlistDialog.current?.close()
    },
  })

  async function loadPreview(item: MusicResult, fallback: boolean) {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setNotice('Finding preview…')
    try {
      const clip = await api(`preview/${item.id}?fallback=${fallback}`, previewSchema, {
        signal: controller.signal,
      })
      if (controller.signal.aborted || previewCurrent.current?.id !== item.id) return
      if (!clip.url) {
        setNotice('No preview available for this track.')
        return
      }
      setNotice(`${clip.source} preview`)
      startAudio(clip.url)
    } catch (error) {
      if (!controller.signal.aborted)
        setNotice(error instanceof Error ? error.message : 'Preview unavailable')
    }
  }

  function startAudio(url: string, autoplay = true) {
    const element = audio.current
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
        position: Math.round((audio.current?.currentTime ?? 0) * 1000),
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
    audio.current?.pause()
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
    setNotice('Your Navidrome library')
    startAudio(`/api/player/stream/${encodeURIComponent(item.id)}`, autoplay)
  }

  function playLibrary(items: LibraryTrack[], index = 0) {
    if (!items.length) return
    queueRef.current = items
    setQueue(items)
    loadLibrary(Math.max(0, Math.min(index, items.length - 1)))
  }

  function shuffleLibrary(items: LibraryTrack[]) {
    if (!items.length) return
    setShuffle(true)
    playLibrary(items, Math.floor(Math.random() * items.length))
  }

  function toggle() {
    const element = audio.current
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
      audio.current?.src
    ) {
      toggle()
      return
    }
    request.current?.abort()
    audio.current?.pause()
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
    if ((audio.current?.currentTime ?? 0) > 4) {
      if (audio.current) audio.current.currentTime = 0
      return
    }
    loadLibrary(Math.max(0, indexRef.current - 1))
  }

  function stop() {
    request.current?.abort()
    saveQueue()
    previewCurrent.current = null
    libraryCurrent.current = null
    audio.current?.pause()
    audio.current?.removeAttribute('src')
    audio.current?.load()
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
        loadLibrary(index, false, saved.position / 1000)
        setNotice('Queue restored. Press play to continue.')
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    const value = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.7
    if (audio.current) {
      audio.current.volume = value
      audio.current.muted = muted
    }
    remember('musimo.player-volume', String(value))
  }, [volume, muted])

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
  const playlistSearchTerms = playlistSearch.trim().toLocaleLowerCase()
  const availablePlaylists = (allPlaylists.data?.items ?? [])
    .filter((playlist) => playlist.id !== likedPlaylist.data?.id)
    .filter((playlist) =>
      playlistSearchTerms ? playlist.name.toLocaleLowerCase().includes(playlistSearchTerms) : true,
    )

  function openPlaylistDialog() {
    setPlaylistSearch('')
    setNewPlaylistName('')
    playlistDialog.current?.showModal()
  }

  const canToggleLiked = likedPlaylist.data && libraryTrack ? true : false
  const likedActionBusy = addToLiked.isPending
  const addActionBusy = addToPlaylist.isPending
  const createBusy = createPlaylist.isPending

  function toggleLikedTrack() {
    const trackId = libraryTrack?.id
    if (!trackId || !likedPlaylist.data) return
    addToLiked.mutate({ trackId, shouldAdd: !isLiked })
  }

  function addTrackToPlaylist(playlistId: string) {
    if (!libraryTrack) return
    addToPlaylist.mutate({ playlistId, songId: libraryTrack.id })
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
        currentIndex,
        playing,
        position,
        length,
        shuffle,
        repeat,
        play,
        playLibrary,
        shuffleLibrary,
        next: () => next(),
        previous,
      }}
    >
      {children}
      <footer className="player live-player">
        <div className="now-playing">
          {activeArt ? <img src={activeArt} alt="" /> : <Disc3 size={30} />}
          <span>
            <strong>
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
              <small className="player-byline">
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
            <small className="playback-notice" role="status">
              {notice}
            </small>
          </span>
        </div>
        {isLibrary && (
          <div className="playlist-actions">
            <button
              className={`icon-button ${isLiked ? 'active' : ''}`}
              aria-label={
                isLiked ? `Remove ${activeTitle} from liked` : `Add ${activeTitle} to liked`
              }
              disabled={!canToggleLiked || likedActionBusy}
              onClick={() => toggleLikedTrack()}
            >
              <ThumbsUp size={16} fill={isLiked ? 'currentColor' : 'none'} />
            </button>
            <button
              className="icon-button"
              aria-label={`Add ${activeTitle} to a playlist`}
              disabled={!isLibrary}
              onClick={() => openPlaylistDialog()}
            >
              <Plus size={16} />
            </button>
            <Link
              className="icon-button open-now-playing"
              aria-label="Open Now Playing"
              to="/now-playing"
            >
              <Maximize2 size={17} />
            </Link>
          </div>
        )}
        <div className="playback-controls">
          {isLibrary ? (
            <button className="icon-button" aria-label="Previous track" onClick={previous}>
              <SkipBack size={17} />
            </button>
          ) : (
            <button
              className="icon-button restart-preview"
              aria-label="Restart preview"
              disabled={!ready}
              onClick={() => {
                if (audio.current) {
                  audio.current.currentTime = 0
                  void audio.current.play().catch(() => setNotice('Press play when you are ready.'))
                }
              }}
            >
              <RotateCcw size={16} />
            </button>
          )}
          <button
            className="round-play"
            aria-label={
              isLibrary ? (playing ? 'Pause' : 'Play') : playing ? 'Pause preview' : 'Play preview'
            }
            disabled={!activeTitle}
            onClick={toggle}
          >
            {playing ? <Pause size={19} /> : <Play size={19} />}
          </button>
          {isLibrary && (
            <button className="icon-button" aria-label="Next track" onClick={() => next()}>
              <SkipForward size={17} />
            </button>
          )}
          <span>{durationText(position)}</span>
          <input
            aria-label={isLibrary ? 'Playback position' : 'Preview position'}
            type="range"
            min="0"
            max={length || 30}
            step="0.1"
            value={Math.min(position, length || 30)}
            disabled={!ready}
            onChange={(event) => {
              const value = Number(event.target.value)
              if (audio.current) audio.current.currentTime = value
              setPosition(value)
            }}
          />
          <span>{durationText(length)}</span>
        </div>
        <div className="volume-controls">
          {isLibrary && (
            <>
              <button
                className={`icon-button ${shuffle ? 'active' : ''}`}
                aria-label="Shuffle"
                onClick={() => setShuffle(!shuffle)}
              >
                <Shuffle size={17} />
              </button>
              <button
                className={`icon-button ${repeat !== 'off' ? 'active' : ''}`}
                aria-label={`Repeat ${repeat}`}
                onClick={() =>
                  setRepeat(repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off')
                }
              >
                <Repeat size={17} />
                {repeat === 'one' && <small>1</small>}
              </button>
            </>
          )}
          <button
            className="icon-button"
            aria-label={
              isLibrary ? (muted ? 'Unmute' : 'Mute') : muted ? 'Unmute preview' : 'Mute preview'
            }
            onClick={() => setMuted(!muted)}
          >
            {muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <input
            type="range"
            aria-label={isLibrary ? 'Volume' : 'Preview volume'}
            min="0"
            max="1"
            step="0.01"
            value={muted ? 0 : volume}
            onChange={(event) => {
              setVolume(Number(event.target.value))
              setMuted(false)
            }}
          />
        </div>
        {(track || libraryTrack) && (
          <button
            className="icon-button close-preview"
            aria-label={isLibrary ? 'Close player' : 'Close preview'}
            onClick={stop}
          >
            <X size={16} />
          </button>
        )}
        {isLibrary && (
          <dialog
            ref={playlistDialog}
            className="playlist-picker-sheet"
            aria-label="Add track to playlist"
            onClick={(event) => {
              if (event.target === playlistDialog.current) playlistDialog.current?.close()
            }}
          >
            <header>
              <h2>Add to playlist</h2>
              <button
                type="button"
                className="icon-button"
                aria-label="Close playlist picker"
                onClick={() => playlistDialog.current?.close()}
              >
                <X size={16} />
              </button>
            </header>
            <label className="playlist-picker-search">
              <input
                aria-label="Filter playlists"
                value={playlistSearch}
                placeholder="Filter playlists"
                onChange={(event) => setPlaylistSearch(event.target.value)}
              />
            </label>
            {allPlaylists.isLoading && <p role="status">Loading playlists…</p>}
            {allPlaylists.isError && <p className="error">{allPlaylists.error.message}</p>}
            <div className="playlist-picker-list">
              {availablePlaylists.map((playlist) => (
                <div key={playlist.id} className="playlist-picker-row">
                  <span>{playlist.name}</span>
                  <button
                    type="button"
                    className="button"
                    disabled={addActionBusy || createBusy}
                    onClick={() => addTrackToPlaylist(playlist.id)}
                  >
                    {addActionBusy ? 'Saving…' : 'Add'}
                  </button>
                </div>
              ))}
              {!allPlaylists.isLoading && !availablePlaylists.length && (
                <p className="playlist-picker-empty">No playlists yet.</p>
              )}
            </div>
            <form className="playlist-picker-form" onSubmit={submitNewPlaylist}>
              <label>
                New playlist
                <input
                  value={newPlaylistName}
                  placeholder="Create and add this track"
                  maxLength={200}
                  onChange={(event) => setNewPlaylistName(event.target.value)}
                />
              </label>
              <button
                className="button"
                type="submit"
                disabled={createBusy || !newPlaylistName.trim()}
              >
                {createBusy ? 'Creating…' : 'Create'}
              </button>
            </form>
            {(addToPlaylist.isError || addToLiked.isError || createPlaylist.isError) && (
              <p className="error">
                {addToPlaylist.error?.message ||
                  addToLiked.error?.message ||
                  createPlaylist.error?.message}
              </p>
            )}
          </dialog>
        )}
        <audio
          ref={audio}
          preload="metadata"
          onLoadedMetadata={() => {
            setReady(true)
            if (pendingSeek.current && audio.current) {
              audio.current.currentTime = pendingSeek.current
              pendingSeek.current = 0
            }
          }}
          onPlay={() => {
            setPlaying(true)
            if (mode.current === 'library') scrobble(false)
          }}
          onPause={() => {
            setPlaying(false)
            saveQueue()
          }}
          onEnded={() => {
            if (mode.current === 'library') scrobble(true)
            if (mode.current === 'library' && repeat === 'one') loadLibrary(indexRef.current)
            else if (mode.current === 'library') next()
            else setPlaying(false)
          }}
          onTimeUpdate={() => {
            const seconds = audio.current?.currentTime ?? 0
            setPosition(seconds)
            if (
              mode.current === 'library' &&
              Math.floor(seconds / 10) !== lastSavedSecond.current
            ) {
              lastSavedSecond.current = Math.floor(seconds / 10)
              saveQueue()
            }
          }}
          onDurationChange={() => {
            if (Number.isFinite(audio.current?.duration)) setLength(audio.current?.duration ?? 0)
          }}
          onError={() => {
            setPlaying(false)
            setReady(false)
            if (mode.current === 'library') {
              setNotice('This library track could not be played.')
              return
            }
            const item = previewCurrent.current
            if (!item) return
            if (previewStage.current < 2) {
              previewStage.current += 1
              void loadPreview(item, previewStage.current === 2)
            } else setNotice('No playable preview available.')
          }}
        />
      </footer>
    </PlayerContext.Provider>
  )
}
