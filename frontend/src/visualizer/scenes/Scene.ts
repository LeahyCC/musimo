export type SceneContext = {
  device: GPUDevice
  format: GPUTextureFormat
  /** The 64-byte feature packet, uploaded once per frame by the renderer. */
  features: GPUBuffer
  /** True on a software rasteriser; scenes should scale their work down. */
  software: boolean
}

export interface Scene {
  /** One short line naming the scene's workload, for the overlay and tests. */
  readonly detail: string
  init(context: SceneContext): void
  resize(width: number, height: number): void
  /** Per-frame CPU work: camera, parameters. `features` is the latest packet. */
  update(features: Float32Array, dt: number): void
  render(encoder: GPUCommandEncoder, view: GPUTextureView): void
  dispose(): void
}
