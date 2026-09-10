import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'

import { createPortal } from 'react-dom'

import { useNavigate } from '@tanstack/react-router'
import { Disc3 } from 'lucide-react'

import { NowPlayingOverlay, useOverlayIdle, useStageKeys } from './now-playing-overlay'
import type { StagePlacement } from './now-playing-overlay'
import { artUrl, usePlayer } from './player'

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
})
export const useNowPlayingPopout = () => useContext(PopoutContext)

const POPOUT_SIZE = 420

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
    }),
    [popout, canPopout, openPopout, closePopout, popoutToFullscreen, pendingFullscreen, notice],
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

// One box: a blurred cover fill behind a sharp, letterboxed copy of the same
// artwork, with the hover controls on top. Docked, full screen and popout all
// share it.
function Stage({ placement, stageRef, fullscreen, onFullscreen, onPopout, onClose }: StageProps) {
  const player = usePlayer()
  const track = player.libraryTrack
  const art = track ? artUrl(track) : (player.track?.art ?? '')
  const idle = useOverlayIdle(stageRef, player.playing)
  useStageKeys(stageRef, { placement, onFullscreen, onClose })

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
      <div className="stage-backdrop">{art ? <img src={art} alt="" /> : <Disc3 size={48} />}</div>
      {art && <img className="stage-art" src={art} alt="" />}
      <NowPlayingOverlay
        placement={placement}
        fullscreen={fullscreen}
        onFullscreen={onFullscreen}
        onPopout={onPopout}
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
