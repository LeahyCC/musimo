import rendererUrl from 'butterchurn/dist/butterchurn.min.js?url'

import type { AudioFrame } from './pcm.ts'

type Variables = Record<string, unknown>
export type Renderer = {
  gl: WebGL2RenderingContext
  loadPreset: (preset: unknown, blendTime: number) => Promise<void>
  render: (options: { elapsedTime: number; audioLevels: AudioFrame }) => void
  loseGLContext: () => void
  renderer: {
    time: number
    frameNum: number
    fps: number
    blending: boolean
    blendProgress: number
    blendStartTime: number
    blendDuration: number
    calcTimeAndFPS: (elapsed: number) => void
    presetEquationRunner: { runFrameEquations: (variables: Variables) => Variables }
    // Butterchurn's own band analyser. Read only by the engine's debug hook,
    // which compares it against the native path's port on the same PCM.
    audioLevels: {
      bass: number
      mid: number
      treb: number
      bass_att: number
      mid_att: number
      treb_att: number
    }
  }
}
type RendererFactory = {
  createVisualizer: (
    context: null,
    canvas: HTMLCanvasElement,
    options: {
      width: number
      height: number
      pixelRatio: number
      textureRatio: number
      deterministic: true
      seed: number
    },
  ) => Renderer
}
export type RendererSandbox = { factory: RendererFactory; remove: () => void }

// The pinned beta changes global Math and keeps a module-level RNG. A separate
// realm also scopes generated preset functions and async loads, without touching
// the host's globals or maintaining a fork of the renderer.
export async function createRendererSandbox(signal: AbortSignal): Promise<RendererSandbox> {
  signal.throwIfAborted()
  const frame = document.createElement('iframe')
  frame.hidden = true
  frame.setAttribute('aria-hidden', 'true')
  frame.title = 'Visualizer renderer context'
  document.body.append(frame)
  const context = frame.contentWindow
  const page = frame.contentDocument
  if (!context || !page) {
    frame.remove()
    throw new Error('Could not create the visualizer context.')
  }
  const script = page.createElement('script')
  script.type = 'module'
  // This asset is copied from the locked npm package by Vite. No remote scripts.
  script.textContent = `import renderer from ${JSON.stringify(new URL(rendererUrl, location.href).href)};
    window.musimoRendererFactory = renderer;
    window.dispatchEvent(new Event('musimo-renderer-ready'));`
  try {
    await new Promise<void>((resolve, reject) => {
      const cancelled = () => {
        cleanup()
        reject(signal.reason)
      }
      const loaded = () => {
        cleanup()
        resolve()
      }
      const cleanup = () => {
        signal.removeEventListener('abort', cancelled)
        context.removeEventListener('musimo-renderer-ready', loaded)
      }
      context.addEventListener('musimo-renderer-ready', loaded, { once: true })
      script.onerror = () => {
        cleanup()
        reject(new Error('The bundled visualizer could not load.'))
      }
      signal.addEventListener('abort', cancelled, { once: true })
      page.head.append(script)
    })
    signal.throwIfAborted()
    const factory: unknown = (context as unknown as Record<string, unknown>).musimoRendererFactory
    if (
      (typeof factory !== 'function' && typeof factory !== 'object') ||
      factory === null ||
      !('createVisualizer' in factory) ||
      typeof factory.createVisualizer !== 'function'
    ) {
      throw new Error('The bundled visualizer factory is unavailable.')
    }
    return { factory: factory as RendererFactory, remove: () => frame.remove() }
  } catch (error) {
    frame.remove()
    throw error
  }
}
