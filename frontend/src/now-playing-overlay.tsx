import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

import {
  Disc3,
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
import { FLUID_SIZES, isSceneId, SCENE_IDS, SCENE_LABELS } from 'visimo/catalog'
import type { SceneId } from 'visimo/catalog'
import { PRESETS } from 'visimo/presets'
import type { Preset } from 'visimo/presets'

import { cx } from './cx'
import { artUrl, durationText, usePlayer } from './player'
import { IconButton, Kbd } from './ui'
import type { IconButtonProps } from './ui'

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

/* The overlay's controls sit on artwork or the visualizer, not on the page, so they take the
   on-media color. `compact` is the 32 by 36 box they had, and still 44px on a touch screen. */
function StageButton(props: IconButtonProps) {
  return <IconButton variant="on-media" size="compact" {...props} />
}

/* `idle` on the stage (its `group`) fades the two bars and stops them catching the pointer. The
   visualizer control sits outside them, so it can stay on screen when they have gone. */
const stageBarClassName =
  'pointer-events-auto flex items-center transition-opacity duration-250 group-[.idle]:pointer-events-none group-[.idle]:opacity-0'
const stageSelectClassName =
  'h-[32px] rounded-[8px] border border-on-media/20 bg-scrim/60 px-[8px] text-small text-on-media'
/* The visualizer control is always over the picture, so it draws on the media color and not on
   the page's. */
const viewControlClassName =
  'inline-flex h-[32px] items-center rounded-[8px] border border-on-media/30 bg-media/70 text-small text-on-media coarse:min-h-11'

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
    <div className="stage-overlay pointer-events-none absolute inset-0 flex flex-col justify-between">
      <div
        className={cx(
          'stage-top justify-between gap-[8px] bg-linear-to-b from-scrim/67 to-transparent px-[16px] pt-[14px] pb-[24px]',
          stageBarClassName,
        )}
      >
        <span
          className="min-w-0 flex-1 truncate text-caption tracking-[1.5px] text-on-media/65 uppercase [text-shadow:0_1px_6px_var(--color-shadow)]"
          role="status"
        >
          {player.playing ? 'Playing' : 'Paused'}
        </span>
        <div className="flex gap-[4px]">
          {/* Nothing to choose while there is one scene, so it is not shown. */}
          {view === 'visualizer' && onScene && SCENE_IDS.length > 1 && (
            <select
              className={stageSelectClassName}
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
              className={stageSelectClassName}
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
          {onPopout && (
            <StageButton aria-label="Pop out player" onClick={onPopout}>
              <PictureInPicture2 size={17} />
            </StageButton>
          )}
          <StageButton aria-label={fullscreenLabel} onClick={onFullscreen}>
            {fullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
          </StageButton>
        </div>
      </div>
      {/* Outside both bars on purpose: it dims when they fade, but stays. In full screen and in
          the popout it goes with them, so the visuals are clean and a small window is not covered. */}
      {view && onToggleView && (
        <div
          className={cx(
            'stage-view-control pointer-events-auto absolute top-[56px] left-[16px] flex max-w-[calc(100%-32px)] flex-wrap items-center gap-[6px] transition-opacity duration-250',
            // A popout is small, and the control would sit on most of the picture for good.
            fullscreen || placement === 'popout'
              ? 'group-[.idle]:pointer-events-none group-[.idle]:opacity-0'
              : 'group-[.idle]:opacity-70',
          )}
        >
          <button
            type="button"
            className={cx(viewControlClassName, 'gap-[6px] pr-[4px] pl-[10px]')}
            aria-pressed={view === 'visualizer'}
            onClick={onToggleView}
          >
            <Sparkles size={15} />
            Visualizer
            {/* `aria-pressed` already says which way it is, so the badge and the key are for the eye. */}
            <span
              aria-hidden="true"
              className={cx(
                'rounded-[6px] px-[6px] text-tiny font-semibold',
                view === 'visualizer' ? 'bg-on-media text-media' : 'bg-on-media/20',
              )}
            >
              {view === 'visualizer' ? 'On' : 'Off'}
            </span>
            <Kbd aria-hidden="true" className="border-on-media/40! text-on-media/80">
              V
            </Kbd>
          </button>
          {view === 'visualizer' && preset && onPreset && (
            <>
              <Kbd className="border-on-media/40! text-on-media/80">[</Kbd>
              {/* The name is the select's own text, so a click opens the list natively. */}
              <select
                className={cx(viewControlClassName, 'max-w-[180px] truncate px-[8px]')}
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
              <Kbd className="border-on-media/40! text-on-media/80">]</Kbd>
            </>
          )}
        </div>
      )}
      <div
        className={cx(
          'stage-controls flex-wrap gap-[8px] bg-linear-to-b from-transparent to-scrim/80 px-[16px] pt-[28px] pb-[14px] text-on-media max-phone:gap-[4px]',
          stageBarClassName,
        )}
      >
        <div className="flex min-w-0 flex-[1_1_160px] items-center gap-[10px]">
          {art ? (
            <img className="size-[40px] shrink-0 rounded-md object-cover" src={art} alt="" />
          ) : (
            <Disc3 size={22} />
          )}
          <span className="grid min-w-0">
            <strong className="truncate text-body">{title}</strong>
            {byline && <small className="truncate text-tiny text-on-media/70">{byline}</small>}
          </span>
        </div>
        {track && (
          <StageButton
            active={player.liked.isLiked}
            // The label already says which way the press goes, so a pressed state on top of it
            // would be read out twice.
            aria-pressed={undefined}
            aria-label={
              player.liked.isLiked ? `Remove ${title} from liked` : `Add ${title} to liked`
            }
            disabled={!player.liked.canToggle || player.liked.busy}
            onClick={player.liked.toggle}
          >
            <ThumbsUp size={16} fill={player.liked.isLiked ? 'currentColor' : 'none'} />
          </StageButton>
        )}
        <div className="flex items-center gap-[2px]">
          <StageButton aria-label="Previous track" disabled={!track} onClick={player.previous}>
            <SkipBack size={17} />
          </StageButton>
          <IconButton
            variant="play"
            aria-label={player.playing ? 'Pause' : 'Play'}
            disabled={!track && !player.track}
            onClick={player.toggle}
          >
            {player.playing ? <Pause size={19} /> : <Play size={19} />}
          </IconButton>
          <StageButton aria-label="Next track" disabled={!track} onClick={player.next}>
            <SkipForward size={17} />
          </StageButton>
        </div>
        <div className="flex min-w-0 flex-[3_1_220px] items-center gap-[8px] text-tiny tabular-nums max-phone:order-1 max-phone:basis-full">
          <span>{durationText(player.position)}</span>
          <input
            className="min-w-0 flex-1 accent-accent"
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
            <StageButton
              active={player.shuffle}
              aria-label="Shuffle"
              onClick={player.toggleShuffle}
            >
              <Shuffle size={17} />
            </StageButton>
            <StageButton
              active={player.repeat !== 'off'}
              aria-label={`Repeat ${player.repeat}`}
              onClick={player.cycleRepeat}
            >
              <Repeat size={17} />
              {player.repeat === 'one' && (
                <small className="-ml-[4px] text-micro max-phone:text-caption">1</small>
              )}
            </StageButton>
          </>
        )}
        <div className="flex items-center gap-[2px]">
          <StageButton aria-label={player.muted ? 'Unmute' : 'Mute'} onClick={player.toggleMute}>
            {player.muted || player.volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </StageButton>
          <input
            className="w-[80px] accent-accent max-phone:hidden"
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
