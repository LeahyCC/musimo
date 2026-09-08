import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { Link } from '@tanstack/react-router'
import {
  Disc3,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'

import { api, playerQueueSchema, previewSchema } from './api'
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

function stored(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* Playback still works when browser storage is blocked. */
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
    const controller = new AbortController()
    void api('player/queue', playerQueueSchema, { signal: controller.signal })
      .then((saved) => {
        if (
          controller.signal.aborted ||
          !saved.entry.length ||
          libraryCurrent.current ||
          previewCurrent.current
        )
          return
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

    return () => controller.abort()
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
  const activeArt = libraryTrack ? artUrl(libraryTrack) : track?.art
  const isLibrary = Boolean(libraryTrack)

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
            {activeArtist && <small>{activeArtist}</small>}
            <small className="playback-notice" role="status">
              {notice}
            </small>
          </span>
        </div>
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
