import { useEffect, useRef } from 'react'

import { renderer } from './gpu/Renderer'

type Props = {
  hud: boolean
  particles: number
  /** The device could not be had, or was lost for good: show artwork instead. */
  onUnsupported: () => void
}

// The whole visualizer tree is loaded on demand from here. React owns the
// canvas elements and nothing per frame; the renderer draws until unmount.
export default function VisualizerStage({ hud, particles, onUnsupported }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const overlay = useRef<HTMLCanvasElement>(null)
  const failed = useRef(onUnsupported)
  failed.current = onUnsupported

  useEffect(() => {
    const element = canvas.current
    const hudElement = overlay.current
    if (!element || !hudElement) return
    void renderer
      .attach(element, hudElement, () => failed.current())
      .then((result) => {
        if (result === 'unsupported') failed.current()
      })

    return () => renderer.detach(element)
  }, [])

  useEffect(() => renderer.setHud(hud), [hud])
  useEffect(() => renderer.setParticleCount(particles), [particles])

  return (
    <>
      <canvas ref={canvas} className="stage-visualizer" aria-hidden="true" />
      <canvas ref={overlay} className="stage-hud" hidden aria-hidden="true" />
    </>
  )
}
