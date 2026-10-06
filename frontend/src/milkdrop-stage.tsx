// The MilkDrop stage. Loaded on demand: butterchurn and its presets are close to a megabyte, and
// nothing outside Now Playing needs them.
import { useEffect, useRef, useState } from 'react'

import butterchurn from 'butterchurn'
import type { MilkdropPreset, Visualizer } from 'butterchurn'
import presetPack from 'butterchurn-presets'
import isSupported from 'butterchurn/dist/isSupported.min.js'

import { audioGraph, bassReading } from './audio-graph'
import { cx } from './cx'
import { createLatestQueue } from './latest-queue'
import {
  CALM_MOMENTS,
  createMomentDetector,
  MOMENT_DEFAULTS,
  prefersReducedMotion,
} from './music-moments'
import type { Scene } from './music-moments'

// How long one preset melts into the next when the choice was made by hand.
const BLEND_SECONDS = 2.7
// Frames averaged into each `data-frame-ms` reading.
const FRAME_SAMPLE = 30

// The pack is a webpack UMD bundle, and Vite hands it over wrapped once more than its own default
// export says, so the presets can sit one level down. Unwrapped wrongly, no name is ever found and
// butterchurn draws its blank default whatever is chosen.
const presets: Record<string, MilkdropPreset> =
  'default' in presetPack && typeof presetPack.default === 'object'
    ? (presetPack.default as Record<string, MilkdropPreset>)
    : presetPack

// One visualizer for the life of the tab. The stage unmounts whenever nobody can see it, and a new
// visualizer each time would mean a new WebGL context and a cold start; this one only moves to the
// new canvas. Null once it is known it cannot be made here.
let shared: Visualizer | null | undefined
// The preset the shared visualizer was last asked for, so a remount does not blend into what is
// already there; the one it has actually loaded; and the load in flight. A stage can unmount and
// mount again while a preset is still loading, and the new one waits on the same load.
let loaded = ''
let showing = ''
let pending: Promise<void> = Promise.resolve()
const loadInTurn = createLatestQueue()
// Set when the music asked for the next change, so that load uses the moment's blend.
let nextBlend: number | undefined
let frameWarned = false
// The size the shared visualizer draws at, so a remount at the same size leaves it alone.
let drawnSize = ''

// butterchurn redraws its last frame straight away when it is resized. Where there is no finished
// frame yet (seen in WebKit when the stage remounts), that redraw throws, and inside a React effect
// it would take the whole page down. The next frame draws at the new size either way.
function resize(drawing: Visualizer, width: number, height: number) {
  const next = `${width}x${height}`
  if (next === drawnSize) return
  drawnSize = next
  try {
    drawing.setRendererSize(width, height)
  } catch (error: unknown) {
    console.warn('MilkDrop could not redraw at the new size', error)
  }
}

function takeVisualizer(canvas: HTMLCanvasElement) {
  if (shared === undefined) {
    try {
      if (!isSupported()) shared = null
      else {
        const { context, bus } = audioGraph()
        shared = butterchurn.createVisualizer(context, canvas, {
          width: canvas.width,
          height: canvas.height,
        })
        shared.connectAudio(bus)
      }
    } catch {
      // WebGL 2 is there but a context could not be had, or butterchurn failed to build on it.
      shared = null
    }
  } else shared?.setCanvas(canvas)
  return shared
}

type Props = {
  preset: string
  onUnsupported: () => void
  /** Asked for a new preset when the music has a moment. Leave it out to keep the preset still. */
  onMoment?: (scene: Scene) => void
  /** Where the song is, 0 at the start and 1 at the end. 0 when the length is not known yet. */
  progress: number
  className?: string
}

export function MilkdropStage({ preset, onUnsupported, onMoment, progress, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [visualizer, setVisualizer] = useState<Visualizer | null>(null)
  const [shown, setShown] = useState(showing)
  // Read from the frame loop, which is set up once per mount and must not restart on a new prop.
  const momentRef = useRef(onMoment)
  momentRef.current = onMoment
  const progressRef = useRef(progress)
  progressRef.current = progress
  // Read when the stage mounts, so a change to the system setting applies from the next one.
  const moments = useRef(
    createMomentDetector(prefersReducedMotion() ? CALM_MOMENTS : MOMENT_DEFAULTS),
  )

  // Keeps the drawing buffer the canvas's size in device pixels, and draws every frame. The popout
  // is a window of its own, so its frames and resizes come from that window: the tab's would be
  // throttled while the tab is behind it.
  useEffect(() => {
    const canvas = canvasRef.current
    const view = canvas?.ownerDocument.defaultView
    if (!canvas || !view) return
    const size = () => {
      const ratio = view.devicePixelRatio || 1
      return [
        Math.max(1, Math.round(canvas.clientWidth * ratio)),
        Math.max(1, Math.round(canvas.clientHeight * ratio)),
      ] as const
    }
    ;[canvas.width, canvas.height] = size()
    const drawing = takeVisualizer(canvas)
    if (!drawing) {
      onUnsupported()
      return
    }
    resize(drawing, canvas.width, canvas.height)
    setVisualizer(drawing)

    const observer = new view.ResizeObserver(() => {
      const [width, height] = size()
      if (width === canvas.width && height === canvas.height) return
      canvas.width = width
      canvas.height = height
      resize(drawing, width, height)
    })
    observer.observe(canvas)

    const { analyser } = audioGraph()
    const scratch = new Uint8Array(analyser.frequencyBinCount)
    const previous = new Float64Array(analyser.frequencyBinCount)
    let frame = 0
    let frames = 0
    let spent = 0
    const draw = () => {
      const start = performance.now()
      try {
        drawing.render()
      } catch (error: unknown) {
        // One bad frame (a preset part way through loading) skips that frame, not the picture. Said
        // once, since a preset that keeps failing would say it every frame.
        if (!frameWarned) console.warn('MilkDrop could not draw a frame', error)
        frameWarned = true
      }
      spent += performance.now() - start
      // Sample even when nothing is listening, so the averages stay warm and switching the
      // feature on mid-song does not look like a drop.
      const { level, flux } = bassReading(analyser, scratch, previous)
      const moment = moments.current.sample(level, start, progressRef.current, flux)
      if (moment && momentRef.current) {
        nextBlend = moment.blend
        momentRef.current(moment.scene)
      }

      if (++frames === FRAME_SAMPLE) {
        // Written straight onto the canvas: nothing on screen shows it, so nothing re-renders.
        canvas.dataset.frameMs = (spent / frames).toFixed(1)
        frames = 0
        spent = 0
      }
      frame = view.requestAnimationFrame(draw)
    }
    frame = view.requestAnimationFrame(draw)
    return () => {
      view.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [onUnsupported])

  useEffect(() => {
    const chosen = presets[preset]
    if (!visualizer || !chosen) return
    if (loaded !== preset) {
      // The first preset appears at once. A later one melts for as long as the music asked, or for
      // the ordinary MilkDrop blend when the choice was made by hand.
      const blend = loaded ? (nextBlend ?? BLEND_SECONDS) : 0
      nextBlend = undefined
      loaded = preset
      // Any change, by hand or by the music, starts the phrase again and waits out this melt.
      moments.current.restart(performance.now(), blend)
      // A preset whose shaders will not compile here leaves the last one drawing.
      // butterchurn's load waits on itself part way through, so two quick changes run side by
      // side could finish in the wrong order. They go one after another, and a change that a newer
      // one replaced while it waited is dropped.
      pending = loadInTurn(async () => {
        try {
          await visualizer.loadPreset(chosen, blend)
          showing = preset
        } catch (error: unknown) {
          console.warn(`MilkDrop preset "${preset}" did not load`, error)
        }
      }).then(() => {})
    }
    let live = true
    void pending.then(() => {
      if (live && showing === preset) setShown(preset)
    })

    return () => {
      live = false
    }
  }, [visualizer, preset])

  return (
    <canvas
      ref={canvasRef}
      className={cx('absolute inset-0 block size-full', className)}
      data-preset={shown || undefined}
    />
  )
}
