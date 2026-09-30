// butterchurn ships JavaScript only. These are the parts Musimo calls.

declare module 'butterchurn' {
  /** A MilkDrop preset as butterchurn loads it. Musimo never looks inside one. */
  export type MilkdropPreset = object

  export type Visualizer = {
    connectAudio(node: AudioNode): void
    disconnectAudio(node: AudioNode): void
    loadPreset(preset: MilkdropPreset, blendSeconds?: number): Promise<void>
    setRendererSize(width: number, height: number): void
    setCanvas(canvas: HTMLCanvasElement): void
    render(): void
  }

  const butterchurn: {
    createVisualizer(
      context: AudioContext,
      canvas: HTMLCanvasElement,
      options: { width: number; height: number },
    ): Visualizer
  }
  export default butterchurn
}

declare module 'butterchurn/dist/isSupported.min.js' {
  /** True where the browser has WebGL 2 and Web Audio. */
  const isSupported: () => boolean
  export default isSupported
}

declare module 'butterchurn-presets' {
  import type { MilkdropPreset } from 'butterchurn'

  /** The base pack, keyed by preset name. */
  const presets: Record<string, MilkdropPreset>
  export default presets
}

declare module 'butterchurn-presets/presetPackMeta.js' {
  /** The names in the base pack, without the presets themselves. */
  export function getBasePresetKeys(): { presets: string[] }
}
