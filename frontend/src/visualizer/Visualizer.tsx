import { useEffect, useRef } from 'react'

import { renderer } from './gpu/Renderer'
import type { Preset } from './presets/types'
import type { SceneId } from './scenes/catalog'

type Props = {
  hud: boolean
  /** Its numbers and its stack; the scene below is its own. */
  preset: Preset
  scene: SceneId
  particles: number
  fluidSize: number
  raymarchSteps: number
  /** The device could not be had, or was lost for good: show artwork instead. */
  onUnsupported: () => void
}

// The whole visualizer tree is loaded on demand from here. React owns the
// canvas elements and nothing per frame; the renderer draws until unmount.
export default function VisualizerStage({
  hud,
  preset,
  scene,
  particles,
  fluidSize,
  raymarchSteps,
  onUnsupported,
}: Props) {
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
  // The preset first, so the scene it names is the one that gets built.
  useEffect(() => renderer.setPreset(preset), [preset])
  useEffect(() => renderer.setScene(scene), [scene])
  useEffect(() => renderer.setParticleCount(particles), [particles])
  useEffect(() => renderer.setFluidSize(fluidSize), [fluidSize])
  useEffect(() => renderer.setRaymarchSteps(raymarchSteps), [raymarchSteps])

  return (
    <>
      <canvas ref={canvas} className="stage-visualizer" aria-hidden="true" />
      <canvas ref={overlay} className="stage-hud" hidden aria-hidden="true" />
    </>
  )
}
