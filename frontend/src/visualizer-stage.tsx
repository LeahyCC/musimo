import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'

import {
  parseStudioOptions,
  studies,
  STUDIO_STORAGE_KEY,
  VisualizerEngine,
} from '@musimo/visualizer'
import type { StudioOptions, Study } from '@musimo/visualizer'
import { Disc3 } from 'lucide-react'

import { artUrl, stored, usePlayer } from './player'
import { useOverlayIdle, useStageKeys, VisualizerOverlay } from './visualizer-overlay'
import type { StagePlacement, StudyChoice } from './visualizer-overlay'
import type { VisualSource } from './visualizer-source'

type StageProps = {
  placement: StagePlacement
  stageRef: RefObject<HTMLDivElement | null>
  source: VisualSource | undefined
  status: string
  studyChoice: string
  onStudy: (id: string) => void
  width: number
  fullscreen: boolean
  onFullscreen: () => void
  onPopout?: () => void
  onClose?: () => void
}

type Phase = { name: 'idle' | 'preparing' | 'live' } | { name: 'error'; message: string }

const isStudy = (value: string): value is Study => value in studies

// Dive is the only study with a prepared score, so it is the pick whenever the
// track has one. A stored Dive choice on any other track falls back to Tunnel,
// as the studio does.
export function resolveStudy(choice: string, hasScore: boolean): Study {
  const picked = isStudy(choice) ? choice : 'dive'
  if (picked === 'dive') return hasScore ? 'dive' : 'tunnel'
  return picked
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong with the visuals.'

// Owns one canvas and one engine at a time. Every rebuild is a fresh canvas
// and a fresh engine because a canvas yields a single WebGL context, then the
// new picture dissolves over the old one. The music never waits for any of it.
export function VisualizerStage({
  placement,
  stageRef,
  source,
  status,
  studyChoice,
  onStudy,
  width,
  fullscreen,
  onFullscreen,
  onPopout,
  onClose,
}: StageProps) {
  const player = usePlayer()
  const host = useRef<HTMLDivElement>(null)
  const engine = useRef<VisualizerEngine | undefined>(undefined)
  const preparing = useRef<VisualizerEngine | undefined>(undefined)
  const canvas = useRef<HTMLCanvasElement | undefined>(undefined)
  const generation = useRef(0)
  const task = useRef<Promise<void>>(Promise.resolve())
  const rebuilding = useRef(false)
  const [phase, setPhase] = useState<Phase>({ name: 'idle' })
  const options = useMemo<StudioOptions>(
    () => parseStudioOptions(stored(STUDIO_STORAGE_KEY, '')),
    [],
  )
  const hasScore = Boolean(source?.score)
  const study = resolveStudy(studyChoice, hasScore)
  const choices = useMemo<StudyChoice[]>(
    () =>
      (Object.keys(studies) as Study[]).map((id) => ({
        id,
        name: studies[id].name,
        disabled: id === 'dive' && !hasScore,
      })),
    [hasScore],
  )
  const latest = useRef({ source, study, width, options })
  latest.current = { source, study, width, options }

  const releaseEngines = useCallback(() => {
    generation.current++
    preparing.current?.dispose()
    preparing.current = undefined
    engine.current?.dispose()
    engine.current = undefined
    canvas.current?.remove()
    canvas.current = undefined
  }, [])

  const prepare = useCallback(
    async (token: number) => {
      const { source: current, study: chosen, width: pixels, options: studio } = latest.current
      const hostElement = host.current
      if (!current || !hostElement || token !== generation.current) return
      rebuilding.current = true
      const next = hostElement.ownerDocument.createElement('canvas')
      next.className = 'visual-canvas'
      next.setAttribute('aria-label', 'Live visualizer output')
      let candidate: VisualizerEngine | undefined
      try {
        setPhase({ name: 'preparing' })
        candidate = new VisualizerEngine(next, current.pcm, pixels, current.score, studio)
        preparing.current = candidate
        await candidate.load(chosen)
        if (token !== generation.current) {
          candidate.dispose()
          return
        }
        const audio = player.audio()
        const now = () => audio?.currentTime ?? 0
        await candidate.startAt(now(), now)
        if (token !== generation.current) {
          candidate.dispose()
          return
        }
        engine.current?.dispose()
        const previous = canvas.current
        hostElement.append(next)
        if (previous) {
          previous.setAttribute('aria-hidden', 'true')
          next
            .animate([{ opacity: 0 }, { opacity: 1 }], { duration: 450, easing: 'ease-out' })
            .finished.then(
              () => previous.remove(),
              () => previous.remove(),
            )
        }
        canvas.current = next
        engine.current = candidate
        setPhase({ name: 'live' })
      } catch (error) {
        candidate?.dispose()
        if (token !== generation.current) return
        setPhase({ name: 'error', message: errorMessage(error) })
      } finally {
        if (preparing.current === candidate) preparing.current = undefined
        rebuilding.current = false
      }
    },
    [player.audio],
  )

  // Expensive preparation is serialized; only the newest request is published.
  const rebuild = useCallback(() => {
    const token = ++generation.current
    preparing.current?.dispose()
    preparing.current = undefined
    task.current = task.current.then(() => prepare(token))
    return task.current
  }, [prepare])

  useEffect(() => {
    if (!source) {
      releaseEngines()
      setPhase({ name: 'idle' })
      return
    }
    void rebuild()
  }, [source, study, width, options, rebuild, releaseEngines])

  useEffect(() => () => releaseEngines(), [releaseEngines])

  // The clock is the audio element. Frames advance on the stage's own window so
  // a hidden popout throttles itself, and a large jump asks for a rebuild.
  useEffect(() => {
    const hostElement = host.current
    if (!hostElement) return
    const win = hostElement.ownerDocument.defaultView ?? window
    let frame = 0
    const tick = () => {
      frame = win.requestAnimationFrame(tick)
      const audio = player.audio()
      const current = engine.current
      if (!audio || !current || win.document.hidden || rebuilding.current) return
      try {
        if (!audio.paused && !audio.seeking && current.advance(audio.currentTime) === false)
          void rebuild()
      } catch (error) {
        current.dispose()
        engine.current = undefined
        setPhase({
          name: 'error',
          message: `Visual stopped: ${errorMessage(error)} Audio continues.`,
        })
      }
    }

    frame = win.requestAnimationFrame(tick)
    return () => win.cancelAnimationFrame(frame)
  }, [player.audio, rebuild])

  useEffect(() => {
    const audio = player.audio()
    const hostElement = host.current
    if (!audio || !hostElement) return
    const doc = hostElement.ownerDocument
    const onSeeked = () => {
      if (latest.current.source) void rebuild()
    }

    const onVisibility = () => {
      if (!doc.hidden && !audio.paused && latest.current.source) void rebuild()
    }

    audio.addEventListener('seeked', onSeeked)
    doc.addEventListener('visibilitychange', onVisibility)
    return () => {
      audio.removeEventListener('seeked', onSeeked)
      doc.removeEventListener('visibilitychange', onVisibility)
    }
  }, [player.audio, rebuild])

  const idle = useOverlayIdle(stageRef, player.playing)
  const nextStudy = () => {
    const open = choices.filter((choice) => !choice.disabled).map((choice) => choice.id)
    const index = open.indexOf(study)
    const next = open[(index + 1) % open.length]
    if (next) onStudy(next)
  }

  useStageKeys(stageRef, { placement, onFullscreen, onClose, onNextStudy: nextStudy })

  const track = player.libraryTrack
  const art = track ? artUrl(track) : (player.track?.art ?? '')
  const stageStatus =
    phase.name === 'error'
      ? phase.message
      : phase.name === 'preparing'
        ? 'Preparing visuals…'
        : phase.name === 'live'
          ? player.playing
            ? 'Live'
            : 'Paused'
          : status
  return (
    <div
      ref={stageRef}
      className={`visual-stage ${idle ? 'idle' : ''} ${phase.name === 'live' ? 'live' : ''}`}
      tabIndex={0}
      aria-label="Music visualizer"
      onDoubleClick={(event) => {
        if (event.target instanceof HTMLElement && event.target.closest('.visual-overlay')) return
        onFullscreen()
      }}
    >
      {phase.name !== 'live' && (
        <div className="visual-backdrop">
          {art ? <img src={art} alt="" /> : <Disc3 size={48} />}
        </div>
      )}
      <div ref={host} className="visual-host" />
      <VisualizerOverlay
        placement={placement}
        fullscreen={fullscreen}
        status={stageStatus}
        study={study}
        choices={choices}
        onStudy={onStudy}
        onFullscreen={onFullscreen}
        onPopout={onPopout}
      />
    </div>
  )
}
