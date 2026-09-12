/**
 * One GPUDevice for the whole app. Requested lazily, kept as a module
 * singleton so it outlives any component, and dropped when the browser
 * reports it lost so the next request starts again.
 */

export type GpuInfo = {
  vendor: string
  architecture: string
  device: string
  description: string
  /** A CPU rasteriser such as SwiftShader: keep the particle count small. */
  software: boolean
}

export type Gpu = {
  device: GPUDevice
  format: GPUTextureFormat
  info: GpuInfo
  lost: boolean
}

let current: Gpu | null = null
let pending: Promise<Gpu | null> | null = null
const lostListeners = new Set<() => void>()

export const hasWebGpu = () => typeof navigator !== 'undefined' && Boolean(navigator.gpu)

/** Runs when the device is lost, after the singleton has been cleared. */
export function onGpuLost(listener: () => void) {
  lostListeners.add(listener)
  return () => lostListeners.delete(listener)
}

export function acquireGpu(): Promise<Gpu | null> {
  if (current && !current.lost) return Promise.resolve(current)
  pending ??= request().finally(() => {
    pending = null
  })

  return pending
}

async function request(): Promise<Gpu | null> {
  if (!hasWebGpu()) return null
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) return null
    const device = await adapter.requestDevice()
    const info = adapter.info
    const gpu: Gpu = {
      device,
      format: navigator.gpu.getPreferredCanvasFormat(),
      info: {
        vendor: info.vendor,
        architecture: info.architecture,
        device: info.device,
        description: info.description,
        software: /swiftshader|llvmpipe|software/i.test(
          `${info.architecture} ${info.description} ${info.device}`,
        ),
      },
      lost: false,
    }
    device.addEventListener('uncapturederror', (event) => {
      console.error('WebGPU error:', event.error.message)
    })

    void device.lost.then((reason) => {
      gpu.lost = true
      if (current === gpu) current = null
      if (reason.reason !== 'destroyed') console.warn('WebGPU device lost:', reason.message)
      for (const listener of lostListeners) listener()
    })
    current = gpu
    return gpu
  } catch (error) {
    console.warn('WebGPU unavailable:', error)
    return null
  }
}

/** Configure a canvas for this device; the context is per canvas, the device is not. */
export function configureCanvas(gpu: Gpu, canvas: HTMLCanvasElement) {
  const context = canvas.getContext('webgpu')
  if (!context) return null
  context.configure({ device: gpu.device, format: gpu.format, alphaMode: 'opaque' })
  return context
}
