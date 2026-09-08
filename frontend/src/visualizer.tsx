import { useEffect, useRef, useState } from 'react'

import {
  Heart,
  LockKeyhole,
  Pause,
  Play,
  RotateCcw,
  Settings2,
  SkipBack,
  SkipForward,
  UnlockKeyhole,
  X,
} from 'lucide-react'

import { durationText, remember, stored, usePlayer } from './player'
import { seedFor, songMapSchema, VisualizerDirector } from './visualizer-director'
import type { SongMap } from './visualizer-director'
import type { VisualSettings, VisualWorld } from './visualizer-renderer'

import './visualizer.css'

type Props = { onClose: () => void }

const bounded = (value: number, fallback: number, minimum: number, maximum: number) =>
  Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback

export default function Visualizer({ onClose }: Props) {
  const player = usePlayer()
  const track = player.libraryTrack
  const canvas = useRef<HTMLCanvasElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const latest = useRef(player)
  latest.current = player
  const [visible, setVisible] = useState(true)
  const [menu, setMenu] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const [analysisState, setAnalysisState] = useState('Listening live')
  const [phase, setPhase] = useState('Emerge')
  const [favourite, setFavourite] = useState(false)
  const [settings, setSettings] = useState<VisualSettings>(() => {
    let saved: Record<string, unknown> = {}
    try {
      const value: unknown = JSON.parse(stored('musimo.visualizer', '{}'))
      if (typeof value === 'object' && value !== null && !Array.isArray(value))
        saved = value as Record<string, unknown>
    } catch {
      /* Defaults also work when browser storage is unavailable. */
    }
    return {
      intensity: bounded(Number(saved.intensity ?? 0.8), 0.8, 0, 1.5),
      motion: bounded(
        Number(saved.motion ?? (matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 0.6)),
        0.6,
        0,
        1,
      ),
      quality: saved.quality === 'high' || saved.quality === 'low' ? saved.quality : 'auto',
      offset: bounded(Number(saved.offset ?? 0), 0, -500, 500),
      seed: seedFor(track?.id ?? 'musimo'),
      hold: false,
    }
  })
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const map = useRef<SongMap | null>(null)
  const director = useRef(new VisualizerDirector())
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    remember(
      'musimo.visualizer',
      JSON.stringify({
        intensity: settings.intensity,
        motion: settings.motion,
        quality: settings.quality,
        offset: settings.offset,
      }),
    )
  }, [settings.intensity, settings.motion, settings.quality, settings.offset])

  useEffect(() => {
    if (!track) return
    map.current = null
    director.current.reset()
    setSettings((value) => ({ ...value, seed: seedFor(track.id) }))
    setFavourite(false)
    try {
      const saved: unknown = JSON.parse(stored(`musimo.visualizer-favourite.${track.id}`, 'null'))
      if (
        typeof saved === 'object' &&
        saved !== null &&
        'seed' in saved &&
        typeof saved.seed === 'number'
      ) {
        setSettings((value) => ({
          ...value,
          seed: bounded(saved.seed as number, seedFor(track.id), 0, 1),
        }))
        setFavourite(true)
      }
    } catch {
      /* A damaged favourite must not prevent playback. */
    }
    setAnalysisState('Listening live')
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const url = `/api/visualizer/analysis/${encodeURIComponent(track.id)}`
    const check = async (method = 'GET') => {
      try {
        const response = await fetch(url, { method, signal: controller.signal })
        if (!response.ok) throw new Error('Analysis unavailable')
        const body: unknown = await response.json()
        if (typeof body !== 'object' || body === null) throw new Error('Invalid song map')
        const data = body as Record<string, unknown>
        if (controller.signal.aborted) return
        if (data.status === 'ready') {
          const parsed = songMapSchema.parse(data.map)
          if (
            track.duration &&
            Math.abs(parsed.duration - track.duration) > Math.max(3, track.duration * 0.02)
          )
            throw new Error('This recording has different timing')
          map.current = parsed
          setAnalysisState('Song map ready')
        } else if (data.status === 'failed') {
          setAnalysisState('Listening live')
        } else {
          setAnalysisState('Learning this song')
          timer = setTimeout(() => void check(), 2500)
        }
      } catch {
        if (!controller.signal.aborted) setAnalysisState('Listening live')
      }
    }
    void check('POST')
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [track?.id])

  useEffect(() => {
    let disposed = false
    let animation = 0
    let world: VisualWorld | undefined
    let lastPaint = -1
    let lastLabel = 0
    const frame = () => {
      if (disposed) return
      animation = requestAnimationFrame(frame)
      const current = latest.current
      const element = current.audioElement()
      if (!world || !element || document.hidden) return
      // A paused player redraws for controls/resizing but never advances musical time.
      if (element.paused && performance.now() - lastPaint < 180) return
      if (settingsRef.current.quality === 'low' && performance.now() - lastPaint < 32) return
      lastPaint = performance.now()
      const features = current.visualAudio.sample(element, settingsRef.current.offset)
      const state = director.current.update(features, map.current, settingsRef.current.hold)
      try {
        world.render(state, settingsRef.current)
      } catch {
        setError('The visualizer could not render. Your music is still playing.')
        cancelAnimationFrame(animation)
        return
      }

      if (lastPaint - lastLabel > 700) {
        setPhase(state.phase)
        lastLabel = lastPaint
      }
    }

    const start = async () => {
      const element = latest.current.audioElement()
      if (!canvas.current || !element) return
      try {
        await latest.current.visualAudio.connect(element)
        const { createWorld } = await import('./visualizer-renderer')
        if (disposed) return
        world = await createWorld(canvas.current, setError)
        if (disposed) {
          world.dispose()
          return
        }
        setReady(true)
        frame()
      } catch {
        if (!disposed)
          setError('This browser could not start the visualizer. Your music is still playing.')
      }
    }
    void start()
    const previousFocus = document.activeElement
    const siblings = Array.from(surface.current?.parentElement?.children ?? []).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element !== surface.current,
    )
    const inertBefore = siblings.map((element) => element.inert)
    for (const element of siblings) element.inert = true
    surface.current?.focus()
    return () => {
      disposed = true
      cancelAnimationFrame(animation)
      world?.dispose()
      siblings.forEach((element, index) => {
        element.inert = inertBefore[index] ?? false
      })
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [])

  function reveal() {
    setVisible(true)
    clearTimeout(idle.current)
    idle.current = setTimeout(() => {
      const active = document.activeElement
      if (surface.current?.querySelector('.visualizer-controls')?.contains(active)) return
      if (surface.current?.querySelector('.visualizer-top')?.contains(active)) return
      if (surface.current?.querySelector('.visualizer-top:hover, .visualizer-controls:hover'))
        return
      setVisible(false)
    }, 3000)
  }

  useEffect(() => {
    reveal()
    return () => clearTimeout(idle.current)
  }, [ready])

  useEffect(() => {
    let entered = Boolean(document.fullscreenElement)
    const changed = () => {
      if (document.fullscreenElement) entered = true
      else if (entered) onClose()
    }
    document.addEventListener('fullscreenchange', changed)
    return () => document.removeEventListener('fullscreenchange', changed)
  }, [onClose])

  function close() {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
    onClose()
  }

  function saveFavourite() {
    remember(
      `musimo.visualizer-favourite.${track?.id ?? 'world'}`,
      JSON.stringify({ seed: settings.seed }),
    )
    setFavourite(true)
  }

  const shown = visible || menu || Boolean(error) || !player.playing || !ready
  return (
    <div
      ref={surface}
      className={`visualizer ${shown ? 'visualizer-awake' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Music visualizer"
      tabIndex={-1}
      onPointerMove={reveal}
      onPointerDown={reveal}
      onFocusCapture={reveal}
      onKeyDown={(event) => {
        reveal()
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          if (menu) setMenu(false)
          else close()
        }

        if (event.key === 'Tab') {
          const buttons = surface.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input,select',
          )
          const first = buttons?.[0],
            last = buttons?.[(buttons?.length ?? 1) - 1]
          if (
            event.shiftKey &&
            (document.activeElement === first || document.activeElement === surface.current)
          ) {
            event.preventDefault()
            requestAnimationFrame(() => last?.focus())
          } else if (
            !event.shiftKey &&
            (document.activeElement === last || document.activeElement === surface.current)
          ) {
            event.preventDefault()
            requestAnimationFrame(() => first?.focus())
          }
        }
      }}
    >
      <canvas ref={canvas} aria-label="An iridescent ribbon world responding to your music" />
      <div
        className="visualizer-top"
        onPointerEnter={() => clearTimeout(idle.current)}
        onPointerLeave={reveal}
      >
        <div className="visualizer-wordmark">
          musimo <span>/</span> <span>visuals</span>
        </div>
        <div className="visualizer-top-actions">
          <button aria-label="Visual settings" aria-expanded={menu} onClick={() => setMenu(!menu)}>
            <Settings2 size={19} />
          </button>
          <button aria-label="Exit visualizer" onClick={close}>
            <X size={21} />
          </button>
        </div>
      </div>
      {!ready && !error && (
        <div className="visualizer-message" role="status">
          Forming your world<span>Music keeps playing</span>
        </div>
      )}
      {error && (
        <div className="visualizer-message" role="alert">
          {error}
          <button onClick={close}>Return to Now Playing</button>
        </div>
      )}
      {menu && (
        <section className="visualizer-menu" aria-label="Visual settings">
          <header>
            <span>Your world</span>
            <button aria-label="Close visual settings" onClick={() => setMenu(false)}>
              <X size={17} />
            </button>
          </header>
          <label>
            Intensity <output>{Math.round(settings.intensity * 100)}%</output>
            <input
              aria-label="Visual intensity"
              type="range"
              min="0"
              max="1.5"
              step="0.05"
              value={settings.intensity}
              onChange={(event) =>
                setSettings({ ...settings, intensity: Number(event.target.value) })
              }
            />
          </label>
          <label>
            Camera motion <output>{Math.round(settings.motion * 100)}%</output>
            <input
              aria-label="Camera motion"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={settings.motion}
              onChange={(event) => setSettings({ ...settings, motion: Number(event.target.value) })}
            />
          </label>
          <label>
            Quality
            <select
              aria-label="Visual quality"
              value={settings.quality}
              onChange={(event) => {
                const quality = event.target.value
                if (quality === 'auto' || quality === 'high' || quality === 'low')
                  setSettings({ ...settings, quality })
              }}
            >
              <option value="auto">Automatic</option>
              <option value="high">High detail</option>
              <option value="low">Lightweight</option>
            </select>
          </label>
          <label>
            Timing adjustment{' '}
            <output>
              {settings.offset > 0 ? '+' : ''}
              {settings.offset} ms
            </output>
            <input
              aria-label="Visual timing adjustment"
              type="range"
              min="-500"
              max="500"
              step="10"
              value={settings.offset}
              onChange={(event) => setSettings({ ...settings, offset: Number(event.target.value) })}
            />
          </label>
          <p>Positive values bring the visuals forward.</p>
          <div className="visualizer-menu-actions">
            <button
              onClick={() => {
                setSettings({ ...settings, seed: Math.random() })
                setFavourite(false)
              }}
            >
              <RotateCcw size={16} />
              Remix
            </button>
            <button aria-pressed={favourite} onClick={saveFavourite}>
              <Heart size={16} fill={favourite ? 'currentColor' : 'none'} />
              Save
            </button>
          </div>
          <small>{analysisState}</small>
        </section>
      )}
      <div
        className="visualizer-controls"
        onPointerEnter={() => clearTimeout(idle.current)}
        onPointerLeave={reveal}
      >
        <div className="visualizer-track">
          <span className="visualizer-phase">{phase}</span>
          <strong>{track?.title ?? 'Your music'}</strong>
          <span>{track?.artist}</span>
        </div>
        <div className="visualizer-transport">
          <div>
            <button aria-label="Previous track" onClick={player.previous}>
              <SkipBack size={20} />
            </button>
            <button
              className="visualizer-play"
              aria-label={player.playing ? 'Pause' : 'Play'}
              onClick={player.toggle}
            >
              {player.playing ? (
                <Pause size={23} fill="currentColor" />
              ) : (
                <Play size={23} fill="currentColor" />
              )}
            </button>
            <button aria-label="Next track" onClick={player.next}>
              <SkipForward size={20} />
            </button>
          </div>
          <label className="visualizer-progress">
            <span>{durationText(player.position)}</span>
            <input
              aria-label="Playback position"
              type="range"
              min="0"
              max={player.length || 1}
              step="0.1"
              value={Math.min(player.position, player.length || 1)}
              onChange={(event) => player.seek(Number(event.target.value))}
            />
            <span>{durationText(player.length)}</span>
          </label>
        </div>
        <div className="visualizer-secondary">
          <button
            aria-label="Hold current world"
            aria-pressed={settings.hold}
            onClick={() => setSettings({ ...settings, hold: !settings.hold })}
          >
            {settings.hold ? <LockKeyhole size={17} /> : <UnlockKeyhole size={17} />}
            <span>Hold</span>
          </button>
          <input
            aria-label="Volume"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={player.volume}
            onChange={(event) => player.changeVolume(Number(event.target.value))}
          />
        </div>
      </div>
    </div>
  )
}
