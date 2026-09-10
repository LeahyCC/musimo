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
import type { ReactNode } from 'react'

import { createPortal } from 'react-dom'

import { useNavigate } from '@tanstack/react-router'
import { Disc3, Image as ImageIcon, Sparkles } from 'lucide-react'

import type { LibraryTrack } from './api'
import { artUrl, remember, stored, usePlayer } from './player'
import { loadVisualSource } from './visualizer-source'
import type { VisualSource } from './visualizer-source'

const VisualizerStage = lazy(() =>
  import('./visualizer-stage').then((module) => ({ default: module.VisualizerStage })),
)

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

type VisualizerValue = {
  enabled: boolean
  setEnabled: (value: boolean) => void
  studyChoice: string
  setStudyChoice: (id: string) => void
  source: VisualSource | undefined
  status: string
  popout: boolean
  canPopout: boolean
  openPopout: () => void
  closePopout: () => void
  popoutToFullscreen: () => void
  pendingFullscreen: boolean
  clearPendingFullscreen: () => void
  attach: () => () => void
  notice: string
  setNotice: (text: string) => void
}

const noop = () => undefined
const VisualizerContext = createContext<VisualizerValue>({
  enabled: false,
  setEnabled: noop,
  studyChoice: 'dive',
  setStudyChoice: noop,
  source: undefined,
  status: '',
  popout: false,
  canPopout: false,
  openPopout: noop,
  closePopout: noop,
  popoutToFullscreen: noop,
  pendingFullscreen: false,
  clearPendingFullscreen: noop,
  attach: () => noop,
  notice: '',
  setNotice: noop,
})
export const useVisualizer = () => useContext(VisualizerContext)

const ENABLED_KEY = 'musimo.now-playing-visuals'
const STUDY_KEY = 'musimo.visualizer.study'
const POPOUT_WIDTH = 1280
const FULLSCREEN_WIDTH = 1920

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

// Lives at the app root so the popout and the prepared audio survive route
// changes. The audio element stays with the player; this only reads its clock.
export function VisualizerProvider({ children }: { children: ReactNode }) {
  const player = usePlayer()
  const navigate = useNavigate()
  const [enabled, setEnabledState] = useState(() => stored(ENABLED_KEY, 'on') !== 'off')
  const [studyChoice, setStudyChoiceState] = useState(() => stored(STUDY_KEY, 'dive'))
  const [demand, setDemand] = useState(0)
  const [source, setSource] = useState<VisualSource | undefined>(undefined)
  const [loadError, setLoadError] = useState('')
  const [pipWindow, setPipWindow] = useState<Window | null>(null)
  const [pendingFullscreen, setPendingFullscreen] = useState(false)
  const [notice, setNotice] = useState('')
  const popoutStage = useRef<HTMLDivElement>(null)
  const trackId = player.libraryTrack?.id
  const popout = pipWindow !== null
  const wanted = enabled && Boolean(trackId) && (demand > 0 || popout)

  const setEnabled = useCallback((value: boolean) => {
    setEnabledState(value)
    remember(ENABLED_KEY, value ? 'on' : 'off')
  }, [])

  const setStudyChoice = useCallback((id: string) => {
    setStudyChoiceState(id)
    remember(STUDY_KEY, id)
  }, [])

  const attach = useCallback(() => {
    setDemand((count) => count + 1)
    return () => setDemand((count) => count - 1)
  }, [])

  // Prepared audio follows the current library track. It is released when the
  // track changes or visuals are switched off, and only fetched while a stage
  // can show it.
  useEffect(() => {
    if (!enabled || !trackId) {
      setSource(undefined)
      setLoadError('')
      return
    }
    if (!wanted || source?.trackId === trackId) return
    const controller = new AbortController()
    setSource(undefined)
    setLoadError('')
    loadVisualSource(trackId, controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted) setSource(loaded)
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setLoadError(
          error instanceof Error ? error.message : 'Visuals are unavailable for this track.',
        )
      })

    return () => controller.abort()
  }, [enabled, trackId, wanted, source])

  const status = !trackId
    ? 'Visuals need a library track.'
    : loadError
      ? loadError
      : source
        ? ''
        : 'Preparing visuals…'

  const canPopout = useMemo(() => Boolean(pictureInPicture()), [])
  const openPopout = useCallback(() => {
    const api = pictureInPicture()
    if (!api) return
    api
      .requestWindow({ width: 640, height: 360 })
      .then((win) => {
        copyStyles(win.document)
        win.document.title = 'Musimo visualizer'
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

  const value = useMemo<VisualizerValue>(
    () => ({
      enabled,
      setEnabled,
      studyChoice,
      setStudyChoice,
      source,
      status,
      popout,
      canPopout,
      openPopout,
      closePopout,
      popoutToFullscreen,
      pendingFullscreen,
      clearPendingFullscreen,
      attach,
      notice,
      setNotice,
    }),
    [
      enabled,
      setEnabled,
      studyChoice,
      setStudyChoice,
      source,
      status,
      popout,
      canPopout,
      openPopout,
      closePopout,
      popoutToFullscreen,
      pendingFullscreen,
      clearPendingFullscreen,
      attach,
      notice,
    ],
  )

  return (
    <VisualizerContext.Provider value={value}>
      {children}
      {pipWindow &&
        createPortal(
          <div className="popout-root">
            <Suspense fallback={null}>
              <VisualizerStage
                placement="popout"
                stageRef={popoutStage}
                source={source}
                status={status}
                studyChoice={studyChoice}
                onStudy={setStudyChoice}
                width={POPOUT_WIDTH}
                fullscreen={false}
                onFullscreen={popoutToFullscreen}
                onClose={closePopout}
              />
            </Suspense>
          </div>,
          pipWindow.document.body,
        )}
    </VisualizerContext.Provider>
  )
}

// The Now Playing hero slot: the visuals, or the artwork when Colin would
// rather see that, with the switch between them always in reach.
export function NowPlayingVisuals({ track }: { track: LibraryTrack }) {
  const visualizer = useVisualizer()
  const container = useRef<HTMLDivElement>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const art = artUrl(track)
  const { attach, pendingFullscreen, clearPendingFullscreen, popout, enabled, setNotice } =
    visualizer

  useEffect(() => attach(), [attach])

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === container.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  useEffect(() => {
    if (!pendingFullscreen || popout || !enabled) return
    clearPendingFullscreen()
    container.current
      ?.requestFullscreen()
      .catch(() => setNotice('Press F on the visualizer for full screen.'))
  }, [pendingFullscreen, popout, enabled, clearPendingFullscreen, setNotice])

  function toggleFullscreen() {
    const element = container.current
    if (!element) return
    if (document.fullscreenElement === element) void document.exitFullscreen()
    else
      element
        .requestFullscreen()
        .catch(() => setNotice('Full screen is unavailable in this browser.'))
  }

  if (!enabled)
    return (
      <div className="now-visuals">
        <div className="now-art">{art ? <img src={art} alt="" /> : <Disc3 />}</div>
        <div className="now-visuals-actions">
          <button className="button" onClick={() => visualizer.setEnabled(true)}>
            <Sparkles size={15} /> Show visuals
          </button>
        </div>
      </div>
    )
  return (
    <div className="now-visuals">
      {popout ? (
        <div className="visual-stage visual-popped">
          {art && <img className="visual-popped-art" src={art} alt="" />}
          <div className="visual-popped-notice">
            <p>Playing in the popout window.</p>
            <button className="button" onClick={visualizer.closePopout}>
              Bring back
            </button>
          </div>
        </div>
      ) : (
        <Suspense
          fallback={
            <div className="visual-stage">
              <div className="visual-backdrop">{art ? <img src={art} alt="" /> : <Disc3 />}</div>
            </div>
          }
        >
          <VisualizerStage
            placement="docked"
            stageRef={container}
            source={visualizer.source}
            status={visualizer.status}
            studyChoice={visualizer.studyChoice}
            onStudy={visualizer.setStudyChoice}
            width={fullscreen ? FULLSCREEN_WIDTH : POPOUT_WIDTH}
            fullscreen={fullscreen}
            onFullscreen={toggleFullscreen}
            onPopout={visualizer.canPopout ? visualizer.openPopout : undefined}
          />
        </Suspense>
      )}
      <div className="now-visuals-actions">
        <button className="button" onClick={() => visualizer.setEnabled(false)}>
          <ImageIcon size={15} /> Show artwork
        </button>
        {visualizer.notice && (
          <span className="muted" role="status">
            {visualizer.notice}
          </span>
        )}
      </div>
    </div>
  )
}
