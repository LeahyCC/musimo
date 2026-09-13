import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode, RefObject } from 'react'

import { createPortal } from 'react-dom'

import { useNavigate } from '@tanstack/react-router'
import { Disc3 } from 'lucide-react'

import { NowPlayingOverlay, useOverlayIdle, useStageKeys } from './now-playing-overlay'
import type { StagePlacement, StageView } from './now-playing-overlay'
import { artUrl, remember, stored, usePlayer } from './player'
import { findPreset, firstPresetOf, presetOrDefault, stepPreset } from './visualizer/presets'
import type { Preset } from './visualizer/presets/types'
import { DEFAULT_FLUID_SIZE, FLUID_SIZES, isSceneId } from './visualizer/scenes/catalog'
import type { SceneId } from './visualizer/scenes/catalog'

// The whole WebGPU tree stays out of the main bundle until a stage wants it.
const VisualizerStage = lazy(() => import('./visualizer/Visualizer'))

type PictureInPictureApi = {
  requestWindow: (options?: {
    width?: number
    height?: number
    disallowReturnToOpener?: boolean
    preferInitialWindowPlacement?: boolean
  }) => Promise<Window>
  window: Window | null
}

const pictureInPicture = () =>
  (window as Window & { documentPictureInPicture?: PictureInPictureApi }).documentPictureInPicture

type PopoutValue = {
  popout: boolean
  canPopout: boolean
  openPopout: () => void
  closePopout: () => void
  popoutToFullscreen: () => void
  pendingFullscreen: boolean
  clearPendingFullscreen: () => void
  notice: string
  setNotice: (text: string) => void
  /** Artwork or the visualizer. Lives here so it survives the stage remounting. */
  view: StageView
  toggleView: () => void
  /** False without WebGPU, or once the device could not be had. */
  canVisualize: boolean
  markUnsupported: () => void
  hud: boolean
  toggleHud: () => void
  /**
   * The preset drawing. It carries the scene, the scene's numbers and the
   * post stack, so choosing one sets all three at once.
   */
  preset: Preset
  setPreset: (id: string) => void
  /** Where `[` and `]` go: -1 and 1. */
  cyclePreset: (delta: number) => void
  /** Which scene draws, and how much work the chosen one does. */
  scene: SceneId
  setScene: (scene: SceneId) => void
  fluidSize: number
  setFluidSize: (size: number) => void
}

const noop = () => undefined
const PopoutContext = createContext<PopoutValue>({
  popout: false,
  canPopout: false,
  openPopout: noop,
  closePopout: noop,
  popoutToFullscreen: noop,
  pendingFullscreen: false,
  clearPendingFullscreen: noop,
  notice: '',
  setNotice: noop,
  view: 'artwork',
  toggleView: noop,
  canVisualize: false,
  markUnsupported: noop,
  hud: false,
  toggleHud: noop,
  preset: presetOrDefault(''),
  setPreset: noop,
  cyclePreset: noop,
  scene: presetOrDefault('').scene,
  setScene: noop,
  fluidSize: DEFAULT_FLUID_SIZE,
  setFluidSize: noop,
})
export const useNowPlayingPopout = () => useContext(PopoutContext)

const POPOUT_SIZE = 420
const VIEW_KEY = 'musimo.now-playing-view'
const PRESET_KEY = 'musimo.visualizer-preset'
const SCENE_KEY = 'musimo.visualizer-scene'
const FLUID_KEY = 'musimo.visualizer-fluid-grid'
const NOTICE_KEY = 'musimo.now-playing-visualizer-notice'
const UNSUPPORTED = 'This browser has no WebGPU, so the stage shows the artwork.'

const hasWebGpu = () => typeof navigator !== 'undefined' && Boolean(navigator.gpu)

// What the browser remembers. A preset names a scene, so it decides; the
// scene key is only consulted where no preset was ever stored.
function remembered(): Preset {
  const saved = findPreset(stored(PRESET_KEY, ''))
  if (saved) return saved
  const scene = stored(SCENE_KEY, '')
  return isSceneId(scene) ? firstPresetOf(scene) : presetOrDefault('')
}

// The popout document starts empty and cannot navigate, so the tab's
// stylesheets are copied across once when it opens.
function copyStyles(target: Document) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const style = target.createElement('style')
      style.textContent = Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n')
      target.head.append(style)
    } catch {
      if (!sheet.href) continue
      const link = target.createElement('link')
      link.rel = 'stylesheet'
      link.href = sheet.href
      target.head.append(link)
    }
  }
}

// Lives at the app root so the popout survives route changes. The audio
// element stays with the player; this only reads its clock.
export function PopoutProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const [pipWindow, setPipWindow] = useState<Window | null>(null)
  const [pendingFullscreen, setPendingFullscreen] = useState(false)
  const [notice, setNotice] = useState('')
  const popoutStage = useRef<HTMLDivElement>(null)
  const popout = pipWindow !== null
  const [view, setView] = useState<StageView>(() =>
    stored(VIEW_KEY, 'visualizer') === 'artwork' ? 'artwork' : 'visualizer',
  )
  const [canVisualize, setCanVisualize] = useState(hasWebGpu)
  const [hud, setHud] = useState(false)
  // The preset carries a scene, so the two are kept in step rather than left
  // to argue: choosing a preset moves the scene select under it, and choosing
  // a scene moves to that scene's first preset. The stored preset wins over
  // the stored scene, which matters on the first visit after this shipped,
  // where the second is set and the first is not.
  const [preset, setPresetState] = useState<Preset>(remembered)
  const [scene, setSceneState] = useState<SceneId>(() => remembered().scene)
  const choosePreset = useCallback((chosen: Preset) => {
    setPresetState(chosen)
    setSceneState(chosen.scene)
  }, [])
  const setPreset = useCallback((id: string) => choosePreset(presetOrDefault(id)), [choosePreset])
  const cyclePreset = useCallback(
    (delta: number) => choosePreset(stepPreset(preset.id, delta)),
    [choosePreset, preset],
  )
  const setScene = useCallback((chosen: SceneId) => {
    setSceneState(chosen)
    setPresetState((current) => (current.scene === chosen ? current : firstPresetOf(chosen)))
  }, [])
  const [fluidSize, setFluidSize] = useState(() => {
    const saved = Number(stored(FLUID_KEY, ''))
    return FLUID_SIZES.includes(saved) ? saved : DEFAULT_FLUID_SIZE
  })
  useEffect(() => remember(VIEW_KEY, view), [view])
  useEffect(() => remember(PRESET_KEY, preset.id), [preset])
  useEffect(() => remember(SCENE_KEY, scene), [scene])
  useEffect(() => remember(FLUID_KEY, String(fluidSize)), [fluidSize])
  const toggleView = useCallback(
    () => setView((current) => (current === 'artwork' ? 'visualizer' : 'artwork')),
    [],
  )
  const toggleHud = useCallback(() => setHud((current) => !current), [])
  // Said once per browser, then artwork without comment.
  const markUnsupported = useCallback(() => {
    setCanVisualize(false)
    if (stored(NOTICE_KEY, '') === 'shown') return
    remember(NOTICE_KEY, 'shown')
    setNotice(UNSUPPORTED)
  }, [])

  const canPopout = useMemo(() => Boolean(pictureInPicture()), [])
  const openPopout = useCallback(() => {
    const api = pictureInPicture()
    if (!api) return
    setNotice('')
    api
      .requestWindow({ width: POPOUT_SIZE, height: POPOUT_SIZE })
      .then((win) => {
        copyStyles(win.document)
        win.document.title = 'Musimo player'
        win.document.body.className = 'popout-body'
        win.addEventListener('pagehide', () =>
          setPipWindow((current) => (current === win ? null : current)),
        )
        setPipWindow(win)
      })
      .catch(() => setNotice('The popout could not open.'))
  }, [])

  const closePopout = useCallback(() => pipWindow?.close(), [pipWindow])

  // A popout cannot go fullscreen itself, so the request travels back to the
  // tab: close the window, bring the tab forward, and let the docked stage
  // pick the request up as soon as it mounts.
  const popoutToFullscreen = useCallback(() => {
    setPendingFullscreen(true)
    pipWindow?.close()
    window.focus()
    void navigate({ to: '/now-playing' })
  }, [pipWindow, navigate])

  const clearPendingFullscreen = useCallback(() => setPendingFullscreen(false), [])

  const value = useMemo<PopoutValue>(
    () => ({
      popout,
      canPopout,
      openPopout,
      closePopout,
      popoutToFullscreen,
      pendingFullscreen,
      clearPendingFullscreen,
      notice,
      setNotice,
      view,
      toggleView,
      canVisualize,
      markUnsupported,
      hud,
      toggleHud,
      preset,
      setPreset,
      cyclePreset,
      scene,
      setScene,
      fluidSize,
      setFluidSize,
    }),
    [
      popout,
      canPopout,
      openPopout,
      closePopout,
      popoutToFullscreen,
      pendingFullscreen,
      notice,
      view,
      toggleView,
      canVisualize,
      markUnsupported,
      hud,
      toggleHud,
      preset,
      setPreset,
      cyclePreset,
      scene,
      setScene,
      fluidSize,
    ],
  )

  return (
    <PopoutContext.Provider value={value}>
      {children}
      {pipWindow &&
        createPortal(
          <div className="popout-root">
            <Stage
              placement="popout"
              stageRef={popoutStage}
              fullscreen={false}
              onFullscreen={popoutToFullscreen}
              onClose={closePopout}
            />
          </div>,
          pipWindow.document.body,
        )}
    </PopoutContext.Provider>
  )
}

type StageProps = {
  placement: StagePlacement
  stageRef: RefObject<HTMLDivElement | null>
  fullscreen: boolean
  onFullscreen: () => void
  onPopout?: () => void
  onClose?: () => void
}

// One box: the visualizer, or a blurred cover fill behind a sharp,
// letterboxed copy of the same artwork, with the hover controls on top.
// Docked, full screen and popout all share it.
function Stage({ placement, stageRef, fullscreen, onFullscreen, onPopout, onClose }: StageProps) {
  const player = usePlayer()
  const popout = useNowPlayingPopout()
  const track = player.libraryTrack
  const art = track ? artUrl(track) : (player.track?.art ?? '')
  const idle = useOverlayIdle(stageRef, player.playing)
  const view = popout.canVisualize ? popout.view : undefined
  useStageKeys(stageRef, {
    placement,
    onFullscreen,
    onClose,
    onToggleView: view ? popout.toggleView : undefined,
    onToggleHud: view === 'visualizer' ? popout.toggleHud : undefined,
    onCyclePreset: view === 'visualizer' ? popout.cyclePreset : undefined,
  })
  const artwork = (
    <>
      <div className="stage-backdrop">{art ? <img src={art} alt="" /> : <Disc3 size={48} />}</div>
      {art && <img className="stage-art" src={art} alt="" />}
    </>
  )

  return (
    <div
      ref={stageRef}
      className={`stage ${idle ? 'idle' : ''}`}
      tabIndex={0}
      aria-label="Now Playing"
      onDoubleClick={(event) => {
        if (event.target instanceof HTMLElement && event.target.closest('.stage-overlay')) return
        onFullscreen()
      }}
    >
      {view === 'visualizer' ? (
        <Suspense fallback={artwork}>
          <VisualizerStage
            hud={popout.hud}
            preset={popout.preset}
            scene={popout.scene}
            fluidSize={popout.fluidSize}
            onUnsupported={popout.markUnsupported}
          />
        </Suspense>
      ) : (
        artwork
      )}
      <NowPlayingOverlay
        placement={placement}
        fullscreen={fullscreen}
        onFullscreen={onFullscreen}
        onPopout={onPopout}
        view={view}
        onToggleView={popout.toggleView}
        preset={popout.preset}
        onPreset={popout.setPreset}
        scene={popout.scene}
        onScene={popout.setScene}
        fluidSize={popout.fluidSize}
        onFluidSize={popout.setFluidSize}
      />
    </div>
  )
}

// The Now Playing hero slot: the stage, or the dimmed artwork with a way back
// while it plays in the popout window.
export function NowPlayingStage() {
  const popout = useNowPlayingPopout()
  const player = usePlayer()
  const container = useRef<HTMLDivElement>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const track = player.libraryTrack
  const art = track ? artUrl(track) : (player.track?.art ?? '')

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === container.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // No WebGPU at all is known before anything loads; say so once.
  useEffect(() => {
    if (!popout.canVisualize) popout.markUnsupported()
  }, [popout.canVisualize, popout.markUnsupported])

  useEffect(() => {
    if (!popout.pendingFullscreen || popout.popout) return
    popout.clearPendingFullscreen()
    popout.setNotice('')
    container.current
      ?.requestFullscreen()
      .catch(() => popout.setNotice('Press F on the player for full screen.'))
  }, [popout.pendingFullscreen, popout.popout, popout.clearPendingFullscreen, popout.setNotice])

  function toggleFullscreen() {
    const element = container.current
    if (!element) return
    popout.setNotice('')
    if (document.fullscreenElement === element) void document.exitFullscreen()
    else
      element
        .requestFullscreen()
        .catch(() => popout.setNotice('Full screen is unavailable in this browser.'))
  }

  return (
    <div className="stage-slot">
      {popout.popout ? (
        <div className="stage stage-popped">
          {art && <img className="stage-popped-art" src={art} alt="" />}
          <div className="stage-popped-notice">
            <p>Playing in the popout window.</p>
            <button className="button" onClick={popout.closePopout}>
              Bring back
            </button>
          </div>
        </div>
      ) : (
        <Stage
          placement="docked"
          stageRef={container}
          fullscreen={fullscreen}
          onFullscreen={toggleFullscreen}
          onPopout={popout.canPopout ? popout.openPopout : undefined}
        />
      )}
      {popout.notice && (
        <span className="muted stage-notice" role="status">
          {popout.notice}
        </span>
      )}
    </div>
  )
}
