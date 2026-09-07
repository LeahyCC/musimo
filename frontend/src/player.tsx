import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { Link } from '@tanstack/react-router'
import { Disc3, Pause, Play, RotateCcw, Volume2, VolumeX, X } from 'lucide-react'

import { api, previewSchema } from './api'
import type { MusicResult } from './api'

type Playback = { track: MusicResult | null; playing: boolean; play: (track: MusicResult) => void }
const PlayerContext = createContext<Playback>({
  track: null,
  playing: false,
  play: () => undefined,
})
export const usePlayer = () => useContext(PlayerContext)

export const durationText = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audio = useRef<HTMLAudioElement>(null)
  const request = useRef<AbortController | null>(null)
  const current = useRef<MusicResult | null>(null)
  const stage = useRef(0)
  const [track, setTrack] = useState<MusicResult | null>(null)
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [length, setLength] = useState(30)
  const [ready, setReady] = useState(false)
  const [volume, setVolume] = useState(() => {
    try {
      const stored = localStorage.getItem('musimo.preview-volume')
      const value = stored === null ? 0.7 : Number(stored)
      return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.7
    } catch {
      return 0.7
    }
  })
  const [muted, setMuted] = useState(false)
  const [notice, setNotice] = useState('Choose a track to hear a preview.')

  async function load(item: MusicResult, fallback: boolean) {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setNotice('Finding preview…')
    try {
      const clip = await api(`preview/${item.id}?fallback=${fallback}`, previewSchema, {
        signal: controller.signal,
      })
      if (controller.signal.aborted || current.current?.id !== item.id) return
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

  function startAudio(url: string) {
    const element = audio.current
    if (!element) return
    element.src = url
    setReady(false)
    void element.play().catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'NotAllowedError')
        setNotice('Press play to start the preview.')
    })
  }

  function toggle() {
    const element = audio.current
    if (!element || !current.current) return
    if (!element.paused) element.pause()
    else if (element.getAttribute('src'))
      void element
        .play()
        .catch(() => setNotice('Cannot play this preview. Select the track to retry.'))
    else {
      stage.current = 1
      void load(current.current, false)
    }
  }

  function play(item: MusicResult) {
    if (current.current?.id === item.id && audio.current?.getAttribute('src')) {
      toggle()
      return
    }
    request.current?.abort()
    audio.current?.pause()
    audio.current?.removeAttribute('src')
    current.current = item
    setTrack(item)
    setPosition(0)
    setLength(30)
    setReady(false)
    stage.current = item.preview ? 0 : 1
    if (item.preview) {
      setNotice('Deezer preview')
      startAudio(item.preview)
    } else void load(item, false)
  }

  function stop() {
    request.current?.abort()
    current.current = null
    audio.current?.pause()
    audio.current?.removeAttribute('src')
    audio.current?.load()
    setTrack(null)
    setPlaying(false)
    setReady(false)
    setPosition(0)
    setLength(30)
    setNotice('Choose a track to hear a preview.')
  }

  useEffect(() => {
    if (audio.current) {
      audio.current.volume = volume
      audio.current.muted = muted
    }

    try {
      localStorage.setItem('musimo.preview-volume', String(volume))
    } catch {
      /* Playback still works when browser storage is blocked. */
    }
  }, [volume, muted])

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.ctrlKey || event.metaKey || event.altKey) return
      if (
        event.target instanceof HTMLElement &&
        (event.target.matches('input,textarea,select,button,a') || event.target.isContentEditable)
      )
        return
      if (current.current) {
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

  return (
    <PlayerContext.Provider value={{ track, playing, play }}>
      {children}
      <footer className="player live-player">
        <div className="now-playing">
          {track?.art ? <img src={track.art} alt="" /> : <Disc3 size={30} />}
          <span>
            <strong>
              {track?.album_id ? (
                <Link
                  to="/albums/$albumId"
                  params={{ albumId: String(track.album_id) }}
                  search={{ track: track.id }}
                >
                  {track.title}
                </Link>
              ) : (
                (track?.title ?? 'A little listening goes a long way.')
              )}
            </strong>
            {track && (
              <small>
                {track.artist_id ? (
                  <Link to="/artists/$artistId" params={{ artistId: String(track.artist_id) }}>
                    {track.artist}
                  </Link>
                ) : (
                  track.artist
                )}
              </small>
            )}
            <small className="playback-notice" role="status">
              {notice}
            </small>
          </span>
        </div>
        <div className="playback-controls">
          <button
            className="icon-button restart-preview"
            aria-label="Restart preview"
            title="Restart preview"
            disabled={!ready}
            onClick={() => {
              if (audio.current) {
                audio.current.currentTime = 0
                setPosition(0)
                void audio.current.play().catch(() => setNotice('Press play to start the preview.'))
              }
            }}
          >
            <RotateCcw size={16} />
          </button>
          <button
            className="round-play"
            aria-label={playing ? 'Pause preview' : 'Play preview'}
            disabled={!track}
            onClick={toggle}
          >
            {playing ? <Pause size={19} /> : <Play size={19} />}
          </button>
          <span>{durationText(position)}</span>
          <input
            aria-label="Preview position"
            type="range"
            min="0"
            max={length || 30}
            step="0.1"
            value={Math.min(position, length || 30)}
            disabled={!ready}
            aria-valuetext={`${durationText(position)} of ${durationText(length)}`}
            onChange={(e) => {
              const value = Number(e.target.value)
              if (audio.current) audio.current.currentTime = value
              setPosition(value)
            }}
          />
          <span>{durationText(length)}</span>
        </div>
        <div className="volume-controls">
          <button
            className="icon-button"
            aria-label={muted || volume === 0 ? 'Unmute preview' : 'Mute preview'}
            onClick={() => {
              if (volume === 0) setVolume(0.7)
              setMuted(volume === 0 ? false : !muted)
            }}
          >
            {muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <input
            type="range"
            aria-label="Preview volume"
            min="0"
            max="1"
            step="0.01"
            value={muted ? 0 : volume}
            aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)} percent`}
            onChange={(event) => {
              setVolume(Number(event.target.value))
              setMuted(false)
            }}
          />
        </div>
        {track && (
          <button
            className="icon-button close-preview"
            aria-label="Close preview"
            title="Close preview"
            onClick={stop}
          >
            <X size={16} />
          </button>
        )}
        <audio
          ref={audio}
          preload="none"
          onLoadedMetadata={() => setReady(Number.isFinite(audio.current?.duration))}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={() => setPosition(audio.current?.currentTime ?? 0)}
          onDurationChange={() =>
            setLength(
              Number.isFinite(audio.current?.duration) ? (audio.current?.duration ?? 30) : 30,
            )
          }
          onError={() => {
            setPlaying(false)
            setReady(false)
            const item = current.current
            if (!item) return
            if (stage.current < 2) {
              stage.current += 1
              void load(item, stage.current === 2)
            } else {
              audio.current?.removeAttribute('src')
              setNotice('No playable preview available.')
            }
          }}
        />
      </footer>
    </PlayerContext.Provider>
  )
}
