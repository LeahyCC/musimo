import { describe, expect, it } from 'vitest'

import { F, PACKET_LENGTH } from './FeatureExtractor'
import { createFeatureWorkerSession } from './features.protocol'
import type { FromWorker } from './features.protocol'

describe('feature worker session', () => {
  it('hands the spectrum buffer back with a packet, and zeros before configuration', () => {
    const posted: { message: FromWorker; transfer: Transferable[] }[] = []
    const session = createFeatureWorkerSession((message, transfer) =>
      posted.push({ message, transfer }),
    )
    const spectrum = new Float32Array(1024).fill(-20)

    session.handle({ type: 'frame', spectrum, dt: 1 / 60 })
    expect(posted[0]?.message.packet).toHaveLength(PACKET_LENGTH)
    expect(posted[0]?.message.packet.every((value) => value === 0)).toBe(true)
    expect(posted[0]?.message.spectrum).toBe(spectrum)
    expect(posted[0]?.transfer).toEqual([posted[0]?.message.packet.buffer, spectrum.buffer])

    session.handle({ type: 'configure', options: { sampleRate: 48000, fftSize: 2048 } })
    session.handle({ type: 'frame', spectrum, dt: 1 / 60 })
    session.handle({ type: 'frame', spectrum, dt: 1 / 60 })
    const second = posted[2]?.message.packet
    expect(second?.[F.time]).toBeCloseTo(2 / 60)
    expect(second?.[F.energy]).toBeGreaterThan(0)
    // Each packet is the receiver's own copy, not the extractor's live array.
    expect(posted[1]?.message.packet).not.toBe(second)
  })
})
