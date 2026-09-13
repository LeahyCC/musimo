import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

import {
  Disc3,
  Image as ImageIcon,
  Maximize2,
  Minimize2,
  Pause,
  PictureInPicture2,
  Play,
  Repeat,
  Shuffle,
  SkipBack,
  SkipForward,
  Sparkles,
  ThumbsUp,
  Volume2,
  VolumeX,
} from 'lucide-react'

import { artUrl, durationText, usePlayer } from './player'
import { PRESETS } from './visualizer/presets'
import type { Preset } from './visualizer/presets/types'
import { FLUID_SIZES, isSceneId, SCENE_IDS, SCENE_LABELS } from './visualizer/scenes/catalog'
import type { SceneId } from './visualizer/scenes/catalog'

export type StagePlacement = 'docked' | 'popout'
export type StageView = 'artwork' | 'visualizer'

type OverlayProps = {
  placement: StagePlacement
  fullscreen: boolean
  onFullscreen: () => void
  onPopout?: () => void
  /** Undefined where the visualizer is not available, so no toggle is shown. */
  view?: StageView
  onToggleView?: () => void
  preset?: Preset
  onPreset?: (id: string) => void
  scene?: SceneId
  onScene?: (scene: SceneId) => void
  fluidSize?: number
  onFluidSize?: (size: number) => void
}

const IDLE_MS = 2500

// The overlay fades out after a short still spell while music plays, and the
// cursor goes with it. It stays while paused, while the pointer rests on a
// control, and comes back on any movement or key.
export function useOverlayIdle(container: RefObject<HTMLDivElement | null>, playing: boolean) {
  const [idle, setIdle] = useState(false)

  useEffect(() => {
    const element = container.current
    if (!element) return
    const win = element.ownerDocument.defaultView ?? window
    let timer = 0
    const rest = () => {
      if (!playing) return
      if (element.querySelector('.stage-overlay :hover')) {
        timer = win.setTimeout(rest, IDLE_MS)
        return
      }
      setIdle(true)
    }

    const wake = () => {
      win.clearTimeout(timer)
      setIdle(false)
      if (playing) timer = win.setTimeout(rest, IDLE_MS)
    }

    const leave = () => {
      win.clearTimeout(timer)
      if (playing) setIdle(true)
    }

    element.addEventListener('pointermove', wake)
    element.addEventListener('pointerdown', wake)
    element.addEventListener('pointerenter', wake)
    element.addEventListener('pointerleave', leave)
    element.addEventListener('keydown', wake)
    wake()
    return () => {
      win.clearTimeout(timer)
      element.removeEventListener('pointermove', wake)
      element.removeEventListener('pointerdown', wake)
      element.removeEventListener('pointerenter', wake)
      element.removeEventListener('pointerleave', leave)
      element.removeEventListener('keydown', wake)
    }
  }, [container, playing])

  return idle
}

type KeyActions = {
  placement: StagePlacement
  onFullscreen: () => void
  onClose?: () => void
  onToggleView?: () => void
  onToggleHud?: () => void
  /** Walks the preset list: -1 for `[` and 1 for `]`. */
  onCyclePreset?: (delta: number) => void
}

// Shortcuts bind to the stage's own window, so the popout has its own set.
// Inside the tab they only apply while the stage is fullscreen or holds focus;
// the page's Space handler keeps working everywhere else, which is also why
// Space is left to it there.
export function useStageKeys(container: RefObject<HTMLDivElement | null>, actions: KeyActions) {
  const player = usePlayer()
  const latest = useRef({ actions, player })
  latest.current = { actions, player }

  useEffect(() => {
    const element = container.current
    if (!element) return
    const doc = element.ownerDocument
    const win = doc.defaultView ?? window
    const onKey = (event: KeyboardEvent) => {
      const { actions: current, player: playback } = latest.current
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('input,select,textarea,[contenteditable]')
      )
        return
      if (
        current.placement === 'docked' &&
        doc.fullscreenElement !== element &&
        !element.contains(doc.activeElement)
      )
        return
      const now = playback.audio()?.currentTime ?? 0
      switch (event.key) {
        case ' ':
          if (current.placement !== 'popout') return
          playback.toggle()
          break
        case 'ArrowLeft':
          playback.seek(Math.max(0, now - 5))
          break
        case 'ArrowRight':
          playback.seek(Math.min(playback.length || now + 5, now + 5))
          break
        case 'ArrowUp':
          playback.setVolume(Math.min(1, playback.volume + 0.05))
          break
        case 'ArrowDown':
          playback.setVolume(Math.max(0, playback.volume - 0.05))
          break
        case 'm':
        case 'M':
          playback.toggleMute()
          break
        case 'f':
        case 'F':
          current.onFullscreen()
          break
        case 'n':
        case 'N':
          playback.next()
          break
        case 'p':
        case 'P':
          playback.previous()
          break
        case 'v':
        case 'V':
          if (!current.onToggleView) return
          current.onToggleView()
          break
        case 'h':
        case 'H':
          if (!current.onToggleHud) return
          current.onToggleHud()
          break
        // N and P are already the transport, so the presets walk on the
        // brackets beside them.
        case '[':
          if (!current.onCyclePreset) return
          current.onCyclePreset(-1)
          break
        case ']':
          if (!current.onCyclePreset) return
          current.onCyclePreset(1)
          break
        case 'Escape':
          if (current.placement !== 'popout' || !current.onClose) return
          current.onClose()
          break
        default:
          return
      }
      event.preventDefault()
    }

    win.addEventListener('keydown', onKey)
    return () => win.removeEventListener('keydown', onKey)
  }, [container])
}

export function NowPlayingOverlay({
  placement,
  fullscreen,
  onFullscreen,
  onPopout,
  view,
  onToggleView,
  preset,
  onPreset,
  scene,
  onScene,
  fluidSize,
  onFluidSize,
}: OverlayProps) {
  const player = usePlayer()
  const track = player.libraryTrack
  const title = track?.title ?? player.track?.title ?? 'Nothing playing'
  const byline = [track?.artist ?? player.track?.artist, track?.album ?? player.track?.album]
    .filter(Boolean)
    .join(' · ')
  const art = track ? artUrl(track) : (player.track?.art ?? '')
  const length = player.length || 30
  const fullscreenLabel =
    placement === 'popout'
      ? 'Full screen in the app'
      : fullscreen
        ? 'Exit full screen'
        : 'Full screen'
  return (
    <div className="stage-overlay">
      <div className="stage-top">
        <span className="stage-status" role="status">
          {player.playing ? 'Playing' : 'Paused'}
        </span>
        <div className="stage-actions">
          {view === 'visualizer' && preset && onPreset && (
            <select
              className="stage-select"
              aria-label="Preset"
              value={preset.id}
              onChange={(event) => onPreset(event.target.value)}
            >
              {SCENE_IDS.map((id) => (
                <optgroup key={id} label={SCENE_LABELS[id]}>
                  {PRESETS.filter((entry) => entry.scene === id).map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          )}
          {/* Nothing to choose while there is one scene, so it is not shown. */}
          {view === 'visualizer' && onScene && SCENE_IDS.length > 1 && (
            <select
              className="stage-select"
              aria-label="Scene"
              value={scene}
              onChange={(event) => {
                if (isSceneId(event.target.value)) onScene(event.target.value)
              }}
            >
              {SCENE_IDS.map((id) => (
                <option key={id} value={id}>
                  {SCENE_LABELS[id]}
                </option>
              ))}
            </select>
          )}
          {/* The size control belongs to whichever scene is drawing. */}
          {view === 'visualizer' && scene === 'fluid' && onFluidSize && (
            <select
              className="stage-select"
              aria-label="Fluid grid"
              value={fluidSize}
              onChange={(event) => onFluidSize(Number(event.target.value))}
            >
              {FLUID_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size} grid
                </option>
              ))}
            </select>
          )}
          {view && onToggleView && (
            <button
              className="icon-button"
              aria-label={view === 'visualizer' ? 'Show artwork' : 'Show visualizer'}
              onClick={onToggleView}
            >
              {view === 'visualizer' ? <ImageIcon size={17} /> : <Sparkles size={17} />}
            </button>
          )}
          {onPopout && (
            <button className="icon-button" aria-label="Pop out player" onClick={onPopout}>
              <PictureInPicture2 size={17} />
            </button>
          )}
          <button className="icon-button" aria-label={fullscreenLabel} onClick={onFullscreen}>
            {fullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
          </button>
        </div>
      </div>
      <div className="stage-controls">
        <div className="stage-track">
          {art ? <img src={art} alt="" /> : <Disc3 size={22} />}
          <span>
            <strong>{title}</strong>
            {byline && <small>{byline}</small>}
          </span>
        </div>
        {track && (
          <button
            className={`icon-button ${player.liked.isLiked ? 'active' : ''}`}
            aria-label={
              player.liked.isLiked ? `Remove ${title} from liked` : `Add ${title} to liked`
            }
            disabled={!player.liked.canToggle || player.liked.busy}
            onClick={player.liked.toggle}
          >
            <ThumbsUp size={16} fill={player.liked.isLiked ? 'currentColor' : 'none'} />
          </button>
        )}
        <div className="stage-transport">
          <button
            className="icon-button"
            aria-label="Previous track"
            disabled={!track}
            onClick={player.previous}
          >
            <SkipBack size={17} />
          </button>
          <button
            className="round-play"
            aria-label={player.playing ? 'Pause' : 'Play'}
            disabled={!track && !player.track}
            onClick={player.toggle}
          >
            {player.playing ? <Pause size={19} /> : <Play size={19} />}
          </button>
          <button
            className="icon-button"
            aria-label="Next track"
            disabled={!track}
            onClick={player.next}
          >
            <SkipForward size={17} />
          </button>
        </div>
        <div className="stage-seek">
          <span>{durationText(player.position)}</span>
          <input
            aria-label="Playback position"
            type="range"
            min="0"
            max={length}
            step="0.1"
            value={Math.min(player.position, length)}
            disabled={!player.ready}
            onChange={(event) => player.seek(Number(event.target.value))}
          />
          <span>{durationText(player.length)}</span>
        </div>
        {track && (
          <>
            <button
              className={`icon-button ${player.shuffle ? 'active' : ''}`}
              aria-label="Shuffle"
              onClick={player.toggleShuffle}
            >
              <Shuffle size={17} />
            </button>
            <button
              className={`icon-button ${player.repeat !== 'off' ? 'active' : ''}`}
              aria-label={`Repeat ${player.repeat}`}
              onClick={player.cycleRepeat}
            >
              <Repeat size={17} />
              {player.repeat === 'one' && <small>1</small>}
            </button>
          </>
        )}
        <div className="stage-volume">
          <button
            className="icon-button"
            aria-label={player.muted ? 'Unmute' : 'Mute'}
            onClick={player.toggleMute}
          >
            {player.muted || player.volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <input
            type="range"
            aria-label="Volume"
            min="0"
            max="1"
            step="0.01"
            value={player.muted ? 0 : player.volume}
            onChange={(event) => player.setVolume(Number(event.target.value))}
          />
        </div>
      </div>
    </div>
  )
}
