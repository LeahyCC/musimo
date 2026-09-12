/**
 * Messages between the player thread and the feature worker. The spectrum
 * buffer travels by transfer in both directions, so the two sides hand one
 * Float32Array back and forth instead of allocating per frame.
 */
import { FeatureExtractor, PACKET_LENGTH } from './FeatureExtractor'
import type { FeatureOptions } from './FeatureExtractor'

export type ToWorker =
  | { type: 'configure'; options: FeatureOptions }
  | { type: 'frame'; spectrum: Float32Array; dt: number }

export type FromWorker = {
  type: 'features'
  /** A fresh copy of the packet; the receiver owns it. */
  packet: Float32Array
  /** The spectrum buffer, handed back for the next frame. */
  spectrum: Float32Array
}

export type Post = (message: FromWorker, transfer: Transferable[]) => void

/** The worker's whole behaviour, kept out of the worker file so it can be unit tested. */
export function createFeatureWorkerSession(post: Post) {
  let extractor: FeatureExtractor | null = null
  return {
    handle(message: ToWorker) {
      if (message.type === 'configure') {
        extractor = new FeatureExtractor(message.options)
        return
      }
      const { spectrum, dt } = message
      // A frame before configuration has no meaning; return the buffer so the
      // pump is not starved, with an all-zero packet.
      const packet = extractor
        ? extractor.update(spectrum, dt).slice()
        : new Float32Array(PACKET_LENGTH)
      post({ type: 'features', packet, spectrum }, [packet.buffer, spectrum.buffer])
    },
  }
}
