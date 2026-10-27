import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'

import {
  AudioLines,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Disc3,
  Maximize2,
  Minimize2,
  Pause,
  PictureInPicture2,
  Play,
  RectangleHorizontal,
  Repeat,
  Shuffle,
  SkipBack,
  SkipForward,
  Square,
  ThumbsUp,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'

import { cx } from '../../lib/cx'
import type { Layout } from '../../lib/layout'
import { useCoarsePointer } from '../../lib/use-coarse'
import { IconButton, Select } from '../../ui'
import type { IconButtonProps } from '../../ui'
import { artUrl, durationText, usePlayer } from '../player/player'
import { PRESET_NAMES, presetLabel } from '../visualizer/visualizer-presets'

export type StagePlacement = 'docked' | 'popout'
export type StageView = 'artwork' | 'visualizer'
/** How the docked stage sits on the page: a square beside the tabs, or a theater above them. */
export type StageSize = 'small' | 'large'

type OverlayProps = {
  /** Classic draws its buttons at the top right and the preset bar along the bottom; the Listening
      room puts all of them in one pill along the bottom. */
  layout: Layout
  placement: StagePlacement
  fullscreen: boolean
  /**
   * Draws the transport over the picture. Docked, the Now Playing page carries it beside the
   * stage, so only full screen and the popout, which have nothing else to hold it, turn it on.
   */
  controls: boolean
  onFullscreen: () => void
  onPopout?: () => void
  /** The docked stage's size, and the switch for it. Undefined where the stage has one size only:
      full screen, the popout and a phone, so no button is drawn there. */
  size?: StageSize
  onSize?: () => void
  /** Undefined where the visualizer is not available, so no toggle is shown. */
  view?: StageView
  onView?: (view: StageView) => void
  preset?: string
  onPreset?: (name: string) => void
  /** Walks the preset list: -1 and 1, the same keys as `[` and `]`. */
  onCyclePreset?: (delta: number) => void
  /** Whether the preset changes with the music (`musimo.visualizer-auto`), and its switch. */
  autoPresets: boolean
  onAutoPresets: (on: boolean) => void
  /** What the room's pill says over the artwork: the album and its year. */
  artLabel: string
}

const IDLE_MS = 2500

/* The overlay's controls sit on artwork or the visualizer, not on the page, so they take the
   on-media color. `compact` is the 32 by 36 box they had, and still 44px on a touch screen. */
function StageButton(props: IconButtonProps) {
  return <IconButton variant="on-media" size="compact" {...props} />
}

/* `idle` on the stage (its `group`) fades every bar and stops them catching the pointer, so the
   picture is clean once the pointer leaves. */
const fadeClassName =
  'transition-opacity duration-250 group-[.idle]:pointer-events-none group-[.idle]:opacity-0'
const stageBarClassName = cx('pointer-events-auto flex items-center', fadeClassName)

/* Everything here sits on artwork or the visualizer, never on the page, so it is drawn in the
   on-media color over a dark scrim whatever the theme. */
const classicButtonClassName = (active = false) =>
  cx(
    'grid size-[34px] place-items-center rounded-[8px] border-0 p-0 coarse:size-11',
    active ? 'bg-accent text-accent-ink' : 'bg-scrim/45 text-on-media hover:bg-scrim/65',
  )
const classicStepClassName =
  'grid size-[28px] shrink-0 place-items-center rounded-[7px] border-0 bg-transparent p-0 text-on-media hover:bg-on-media/15 coarse:size-11'
const roomButtonClassName =
  'grid size-[28px] shrink-0 place-items-center rounded-pill border-0 bg-transparent p-0 text-on-media hover:bg-on-media/15 coarse:size-11'
const monoClassName = 'font-mono text-tiny'
/* The preset's name is the select itself, so a click opens the list natively. It carries no box of
   its own; the bar around it is the box. */
const presetSelectClassName = cx(
  'min-w-[10ch] cursor-pointer truncate border-0 bg-transparent p-0 text-on-media [&>option]:bg-raised [&>option]:text-text',
  monoClassName,
)

// The overlay fades out after a short still spell while music plays, and the
// cursor goes with it. It stays while paused, while the pointer rests on a
// control, and comes back on any movement or key.
//
// A touch screen keeps it: there is no pointer to rest or move, and every tap
// ends with a `pointerleave`, which used to hide the controls between the tap
// landing and the click, so the stage's buttons could not be pressed while a
// song played.
export function useOverlayIdle(container: RefObject<HTMLDivElement | null>, playing: boolean) {
  const [idle, setIdle] = useState(false)

  useEffect(() => {
    const element = container.current
    if (!element) return
    const win = element.ownerDocument.defaultView ?? window
    let timer = 0
    const touchOnly = win.matchMedia('(hover: none)').matches
    const rest = () => {
      if (!playing || touchOnly) return
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

    const leave = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      win.clearTimeout(timer)
      if (playing && !touchOnly) setIdle(true)
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

// The transport drawn over the picture, for full screen and the popout, where the page's own
// control row is out of reach. It duplicates that row on purpose: it lives in another document.
function StageControls() {
  const player = usePlayer()
  const track = player.libraryTrack
  const title = track?.title ?? player.track?.title ?? 'Nothing playing'
  const byline = [track?.artist ?? player.track?.artist, track?.album ?? player.track?.album]
    .filter(Boolean)
    .join(' · ')
  const art = track ? artUrl(track) : (player.track?.art ?? '')
  const length = player.length || 30
  return (
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
          aria-label={player.liked.isLiked ? `Remove ${title} from liked` : `Add ${title} to liked`}
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
          <StageButton active={player.shuffle} aria-label="Shuffle" onClick={player.toggleShuffle}>
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
  )
}

type BarButtonProps = {
  label: string
  onClick: () => void
  className: string
  /** A key that does the same, for `aria-keyshortcuts` and the tooltip. */
  keys?: string
  pressed?: boolean
  children: ReactNode
}

function BarButton({ label, onClick, className, keys, pressed, children }: BarButtonProps) {
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      aria-pressed={pressed}
      aria-keyshortcuts={keys}
      title={keys ? `${label} (${keys})` : label}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/** The chosen preset by its short name; hovering shows the full name, which credits its authors. */
function PresetSelect({
  preset,
  onPreset,
  className,
}: {
  preset: string
  onPreset: (name: string) => void
  className?: string
}) {
  return (
    <Select
      className={cx(presetSelectClassName, className)}
      aria-label="Preset"
      title={preset}
      value={preset}
      onChange={(event) => onPreset(event.target.value)}
    >
      {PRESET_NAMES.map((name) => (
        <option key={name} value={name}>
          {presetLabel(name)}
        </option>
      ))}
    </Select>
  )
}

/**
 * The room's Art | MilkDrop switch. Real radios under the look, as `Segmented` does, so the arrow
 * keys and what a screen reader says are the browser's; it is drawn here rather than with
 * `Segmented` because it sits on the picture and takes the on-media colors.
 */
function ViewSwitch({ view, onView }: { view: StageView; onView: (view: StageView) => void }) {
  const name = useId()
  return (
    <div
      role="radiogroup"
      aria-label="Show on the stage"
      className="flex shrink-0 rounded-pill bg-on-media/10 p-[2px]"
    >
      {(['artwork', 'visualizer'] as const).map((option) => (
        <label
          key={option}
          className={cx(
            'grid h-[26px] cursor-pointer place-items-center rounded-pill px-[10px] uppercase coarse:min-h-11',
            'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-solid',
            monoClassName,
            view === option ? 'bg-on-media text-media' : 'text-on-media',
          )}
        >
          <input
            type="radio"
            className="sr-only"
            name={name}
            checked={view === option}
            // V is the same switch, so both radios say so.
            aria-keyshortcuts="V"
            onChange={() => onView(option)}
          />
          {option === 'artwork' ? 'Art' : 'MilkDrop'}
        </label>
      ))}
    </div>
  )
}

/** Auto lets the music change the preset; Hold keeps the one showing. One button that says which. */
function AutoHold({
  on,
  onChange,
  className,
}: {
  on: boolean
  onChange: (on: boolean) => void
  className?: string
}) {
  return (
    <button
      type="button"
      // Pressed is Auto, so the name stays put and the state says which way it is.
      aria-label="Change with the music"
      aria-pressed={on}
      title={
        on
          ? 'Changes with the music. Press to hold this preset.'
          : 'Held. Press to let the music change it.'
      }
      className={cx(
        'h-[28px] shrink-0 border-0 px-[10px] text-tiny font-semibold tracking-[0.5px] coarse:min-h-11',
        on ? 'bg-accent/90 text-accent-ink' : 'bg-on-media/15 text-on-media',
        className,
      )}
      onClick={() => onChange(!on)}
    >
      {on ? 'AUTO' : 'HOLD'}
    </button>
  )
}

function PresetSteps({
  onCyclePreset,
  className,
  size,
}: {
  onCyclePreset: (delta: number) => void
  className: string
  size: number
}) {
  return (
    <>
      <BarButton
        label="Previous preset"
        keys="["
        className={className}
        onClick={() => onCyclePreset(-1)}
      >
        <ChevronLeft size={size} />
      </BarButton>
      <BarButton
        label="Next preset"
        keys="]"
        className={className}
        onClick={() => onCyclePreset(1)}
      >
        <ChevronRight size={size} />
      </BarButton>
    </>
  )
}

/** Pop out, stage size and full screen, in that order. The size label says where the press goes. */
function WindowButtons({
  className,
  icon,
  fullscreen,
  fullscreenLabel,
  onFullscreen,
  onPopout,
  size,
  onSize,
}: {
  className: string
  icon: number
  fullscreen: boolean
  fullscreenLabel: string
  onFullscreen: () => void
  onPopout?: () => void
  size?: StageSize
  onSize?: () => void
}) {
  return (
    <>
      {onPopout && (
        <BarButton label="Pop out player" className={className} onClick={onPopout}>
          <PictureInPicture2 size={icon} />
        </BarButton>
      )}
      {size && onSize && (
        <BarButton
          label={size === 'large' ? 'Small stage' : 'Large stage'}
          keys="S"
          className={className}
          onClick={onSize}
        >
          {size === 'large' ? <Square size={icon} /> : <RectangleHorizontal size={icon} />}
        </BarButton>
      )}
      <BarButton label={fullscreenLabel} keys="F" className={className} onClick={onFullscreen}>
        {fullscreen ? <Minimize2 size={icon} /> : <Maximize2 size={icon} />}
      </BarButton>
    </>
  )
}

/**
 * Presets on a touch screen. The drawn select has no way to dismiss it once it covers the stage,
 * so this is a sheet: the X, the dimmed picture, or a row all close it.
 */
function PresetSheet({
  preset,
  onPreset,
  onClose,
}: {
  preset: string
  onPreset: (name: string) => void
  onClose: () => void
}) {
  const closeButton = useRef<HTMLButtonElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    closeButton.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="pointer-events-auto absolute inset-0 z-20 flex flex-col justify-end">
      <button
        type="button"
        className="absolute inset-0 border-0 bg-scrim/55"
        aria-label="Close presets"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Presets"
        className="relative flex max-h-[min(70%,480px)] flex-col overflow-hidden rounded-t-[18px] bg-raised text-text"
      >
        <div className="flex items-center gap-[8px] py-[8px] pr-[8px] pl-[16px]">
          <h2 className="min-w-0 flex-1 text-body font-semibold">Presets</h2>
          <button
            ref={closeButton}
            type="button"
            className="grid size-11 place-items-center rounded-full border-0 bg-transparent text-text"
            aria-label="Close presets"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[8px] pb-[calc(8px+var(--safe-bottom))]">
          {PRESET_NAMES.map((name) => {
            const selected = name === preset
            return (
              <button
                key={name}
                type="button"
                aria-current={selected ? 'true' : undefined}
                title={name}
                className={cx(
                  'flex min-h-11 w-full items-center gap-[8px] rounded-[10px] border-0 bg-transparent px-[8px] text-left text-body',
                  selected ? 'bg-hover text-accent' : 'text-text',
                )}
                onClick={() => onPreset(name)}
              >
                <Check size={16} className={cx('shrink-0', !selected && 'invisible')} />
                <span className="min-w-0 truncate">{presetLabel(name)}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** One set of stage controls for a finger: large targets, a preset sheet, and a full screen button. */
function TouchStageChrome({
  fullscreen,
  onFullscreen,
  onPopout,
  size,
  onSize,
  view,
  onView,
  preset,
  onPreset,
  onCyclePreset,
  autoPresets,
  onAutoPresets,
  artLabel,
}: OverlayProps) {
  const [open, setOpen] = useState(false)
  const visualizer = view === 'visualizer'
  const presetControls = Boolean(visualizer && preset && onPreset && onCyclePreset)

  return (
    <div className="stage-overlay pointer-events-none absolute inset-0">
      {fullscreen && (
        <div className="pointer-events-auto absolute top-0 left-0 z-10 pt-[var(--safe-top)] pl-[4px]">
          <button
            type="button"
            className="grid size-11 place-items-center rounded-full border-0 bg-scrim/55 text-on-media"
            aria-label="Exit full screen"
            onClick={onFullscreen}
          >
            <X size={22} />
          </button>
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 z-10 grid gap-[8px] p-[10px] pb-[calc(10px+var(--safe-bottom))]">
        <div className="stage-view-control pointer-events-auto grid gap-[8px] rounded-[20px] bg-scrim/60 p-[8px] text-on-media backdrop-blur-[8px]">
          {view && onView && <ViewSwitch view={view} onView={onView} />}
          {presetControls && preset && onPreset ? (
            <button
              type="button"
              className="flex min-h-11 items-center gap-[8px] rounded-[12px] border-0 bg-on-media/10 px-[12px] text-left text-on-media"
              aria-haspopup="dialog"
              aria-expanded={open}
              aria-label={`Preset, ${presetLabel(preset)}`}
              title={preset}
              onClick={() => setOpen(true)}
            >
              <span className={cx('min-w-0 flex-1 truncate', monoClassName)}>
                {presetLabel(preset)}
              </span>
              <ChevronDown size={18} aria-hidden="true" />
            </button>
          ) : (
            artLabel && (
              <span className={cx('truncate px-[8px] uppercase', monoClassName)}>{artLabel}</span>
            )
          )}
          <div className="flex items-center gap-[6px]">
            {presetControls && onCyclePreset && (
              <>
                <PresetSteps
                  onCyclePreset={onCyclePreset}
                  className={roomButtonClassName}
                  size={18}
                />
                <AutoHold on={autoPresets} onChange={onAutoPresets} className="rounded-pill" />
              </>
            )}
            <span className="flex-1" />
            <WindowButtons
              className={roomButtonClassName}
              icon={18}
              fullscreen={fullscreen}
              fullscreenLabel={fullscreen ? 'Exit full screen' : 'Full screen'}
              onFullscreen={onFullscreen}
              onPopout={onPopout}
              size={size}
              onSize={onSize}
            />
          </div>
        </div>
      </div>
      {open && preset && onPreset && (
        <PresetSheet
          preset={preset}
          onPreset={(name) => {
            onPreset(name)
            setOpen(false)
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

export function NowPlayingOverlay({
  layout,
  placement,
  fullscreen,
  controls,
  onFullscreen,
  onPopout,
  size,
  onSize,
  view,
  onView,
  preset,
  onPreset,
  onCyclePreset,
  autoPresets,
  onAutoPresets,
  artLabel,
}: OverlayProps) {
  const coarse = useCoarsePointer()
  const player = usePlayer()
  if (coarse)
    return (
      <TouchStageChrome
        layout={layout}
        placement={placement}
        fullscreen={fullscreen}
        controls={controls}
        onFullscreen={onFullscreen}
        onPopout={onPopout}
        size={size}
        onSize={onSize}
        view={view}
        onView={onView}
        preset={preset}
        onPreset={onPreset}
        onCyclePreset={onCyclePreset}
        autoPresets={autoPresets}
        onAutoPresets={onAutoPresets}
        artLabel={artLabel}
      />
    )
  const fullscreenLabel =
    placement === 'popout'
      ? 'Full screen in the app'
      : fullscreen
        ? 'Exit full screen'
        : 'Full screen'
  const visualizer = view === 'visualizer'
  const presetControls = visualizer && preset && onPreset && onCyclePreset

  const windowButtons = (className: string, icon: number) => (
    <WindowButtons
      className={className}
      icon={icon}
      fullscreen={fullscreen}
      fullscreenLabel={fullscreenLabel}
      onFullscreen={onFullscreen}
      onPopout={onPopout}
      size={size}
      onSize={onSize}
    />
  )

  // Playing or Paused. Docked, the page's own play button says it, so it is only heard; full
  // screen and the popout have nothing else that says it, so there it shows.
  const status = (
    <span
      className={cx(
        'min-w-0 flex-1 truncate text-caption tracking-[1.5px] text-on-media/65 uppercase [text-shadow:0_1px_6px_var(--color-shadow)]',
        !controls && 'sr-only',
      )}
      role="status"
    >
      {player.playing ? 'Playing' : 'Paused'}
    </span>
  )

  if (layout === 'room')
    return (
      <div className="stage-overlay pointer-events-none absolute inset-0 flex flex-col justify-between">
        <div className={cx('stage-top px-[16px] pt-[14px] pb-[24px]', stageBarClassName)}>
          {status}
        </div>
        <div className="grid gap-[8px]">
          {/* One pill along the bottom: Art or MilkDrop, what is showing, the preset steps and
              Auto or Hold while it is MilkDrop, then the window buttons. It fades with the rest. */}
          <div
            className={cx(
              'stage-view-control pointer-events-auto mx-[12px] flex min-w-0 flex-wrap items-center gap-[6px] rounded-pill max-phone:rounded-[20px] bg-scrim/50 py-[5px] pr-[5px] pl-[6px] text-on-media backdrop-blur-[6px]',
              !controls && 'mb-[12px]',
              fadeClassName,
            )}
          >
            {view && onView && <ViewSwitch view={view} onView={onView} />}
            <span className="flex min-w-0 flex-1 items-center opacity-80 max-phone:order-first max-phone:basis-full max-phone:px-[6px]">
              {presetControls ? (
                <PresetSelect preset={preset} onPreset={onPreset} className="max-w-full" />
              ) : (
                <span className={cx('truncate uppercase', monoClassName)}>{artLabel}</span>
              )}
            </span>
            {presetControls && (
              <>
                <PresetSteps
                  onCyclePreset={onCyclePreset}
                  className={roomButtonClassName}
                  size={14}
                />
                <AutoHold on={autoPresets} onChange={onAutoPresets} className="rounded-pill" />
              </>
            )}
            {windowButtons(roomButtonClassName, 14)}
          </div>
          {controls && <StageControls />}
        </div>
      </div>
    )

  return (
    <div className="stage-overlay pointer-events-none absolute inset-0 flex flex-col justify-between">
      <div
        className={cx(
          'stage-top justify-between gap-[8px] px-[12px] pt-[12px] pb-[24px]',
          controls && 'bg-linear-to-b from-scrim/67 to-transparent',
          stageBarClassName,
        )}
      >
        {status}
        <div className="ml-auto flex gap-[6px]">
          {view && onView && (
            <BarButton
              label="Visualizer"
              keys="V"
              pressed={visualizer}
              className={classicButtonClassName(visualizer)}
              onClick={() => onView(visualizer ? 'artwork' : 'visualizer')}
            >
              <AudioLines size={16} />
            </BarButton>
          )}
          {windowButtons(classicButtonClassName(), 15)}
        </div>
      </div>
      <div className="grid gap-[8px]">
        {/* Over the artwork, a hint that the visualizer is a key away; over the visualizer, the
            preset bar. Either fades with the top bar when the stage goes idle. */}
        {presetControls ? (
          <div
            className={cx(
              'stage-view-control pointer-events-auto mx-[12px] flex min-w-0 items-center gap-[6px] rounded-[10px] bg-scrim/50 py-[6px] pr-[6px] pl-[12px] text-on-media backdrop-blur-[6px]',
              !controls && 'mb-[12px]',
              fadeClassName,
            )}
          >
            <span className="flex min-w-0 flex-1 items-center gap-[4px]">
              {/* At most a little over half the bar, so the caption beside it still shows. */}
              <PresetSelect
                preset={preset}
                onPreset={onPreset}
                className="max-w-[55%] max-phone:max-w-full"
              />
              <span
                className={cx(
                  'min-w-0 shrink-[4] truncate text-on-media/70 max-phone:hidden',
                  monoClassName,
                )}
              >
                · {autoPresets ? 'changes with the music' : 'held'}
              </span>
            </span>
            <AutoHold on={autoPresets} onChange={onAutoPresets} className="rounded-[7px]" />
            <PresetSteps onCyclePreset={onCyclePreset} className={classicStepClassName} size={15} />
          </div>
        ) : (
          view && (
            <span
              className={cx(
                'stage-view-control mx-[14px] text-on-media/60 [text-shadow:0_1px_6px_var(--color-shadow)]',
                !controls && 'mb-[12px]',
                monoClassName,
                fadeClassName,
              )}
            >
              album art<span className="no-hover:hidden"> · V for visualizer</span>
            </span>
          )
        )}
        {controls && <StageControls />}
      </div>
    </div>
  )
}
