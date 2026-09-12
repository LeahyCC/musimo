/**
 * The player-thread side of the feature worker. Owns one spectrum buffer
 * that shuttles to the worker and back, so a frame costs no allocation, and
 * keeps the newest packet for the renderer to read.
 */
import { PACKET_LENGTH } from './FeatureExtractor'
import type { FromWorker, ToWorker } from './features.protocol'

export class FeatureClient {
  readonly packet = new Float32Array(PACKET_LENGTH)
  private readonly worker: Worker
  private spare: Float32Array<ArrayBuffer> | null

  constructor(private readonly analyser: AnalyserNode) {
    this.worker = new Worker(new URL('./features.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (event: MessageEvent<FromWorker>) => {
      this.packet.set(event.data.packet)
      this.spare = event.data.spectrum
    }
    this.worker.onerror = (event) => console.error('Feature worker failed:', event.message)
    this.send({
      type: 'configure',
      options: { sampleRate: analyser.context.sampleRate, fftSize: analyser.fftSize },
    })
    this.spare = new Float32Array(analyser.frequencyBinCount)
  }

  /** Read the analyser and send a frame, unless the last one is still away. */
  pump(dt: number) {
    const spectrum = this.spare
    if (!spectrum) return
    this.spare = null
    this.analyser.getFloatFrequencyData(spectrum)
    this.send({ type: 'frame', spectrum, dt }, [spectrum.buffer])
  }

  private send(message: ToWorker, transfer: Transferable[] = []) {
    this.worker.postMessage(message, transfer)
  }

  dispose() {
    this.worker.terminate()
  }
}
