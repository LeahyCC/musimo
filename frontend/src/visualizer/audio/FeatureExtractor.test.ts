import { describe, expect, it } from 'vitest'

import {
  bandBins,
  dbToLinear,
  DEFAULT_BANDS,
  Envelope,
  F,
  FeatureExtractor,
  PACKET_LENGTH,
} from './FeatureExtractor'

const SAMPLE_RATE = 48000
const FFT_SIZE = 2048
const DT = 1 / 60

/** A frame of dB values from a function of frequency, as the analyser would fill it. */
function spectrum(level: (hz: number) => number, fftSize = FFT_SIZE) {
  const bins = fftSize / 2
  const frame = new Float32Array(bins)
  for (let bin = 0; bin < bins; bin++) frame[bin] = level((bin * SAMPLE_RATE) / fftSize)
  return frame
}

const silence = () => -Infinity
const flat = (db: number) => () => db
const only = (low: number, high: number, db: number) => (hz: number) =>
  hz >= low && hz < high ? db : -100

/** Deterministic noise for jitter tests. */
function random(seed: number) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

describe('dbToLinear', () => {
  it('maps silence to 0 and 0 dB to 1', () => {
    expect(dbToLinear(-Infinity)).toBe(0)
    expect(dbToLinear(0)).toBe(1)
    expect(dbToLinear(-20)).toBeCloseTo(0.1)
  })
})

describe('bandBins', () => {
  it('covers the band at both fft sizes', () => {
    expect(bandBins(60, 250, 2048, SAMPLE_RATE)).toEqual([3, 11])
    expect(bandBins(60, 250, 4096, SAMPLE_RATE)).toEqual([5, 21])
  })

  it('never returns an empty or out-of-range span', () => {
    expect(bandBins(20, 25, 2048, SAMPLE_RATE)).toEqual([1, 2])
    expect(bandBins(20000, 30000, 2048, SAMPLE_RATE)).toEqual([853, 1024])
  })
})

describe('Envelope', () => {
  it('reaches 63% of a step after one attack time and falls to 37% after one release time', () => {
    const envelope = new Envelope(10, 150)
    const step = 0.001
    for (let t = 0; t < 0.01; t += step) envelope.step(1, step)
    expect(envelope.value).toBeCloseTo(1 - Math.exp(-1), 1)
    for (let t = 0; t < 0.15; t += step) envelope.step(0, step)
    expect(envelope.value).toBeCloseTo(Math.exp(-1) * (1 - Math.exp(-1)), 1)
  })
})

describe('FeatureExtractor', () => {
  const make = (fftSize = FFT_SIZE) =>
    new FeatureExtractor({ sampleRate: SAMPLE_RATE, fftSize, nominalFrameRate: 60 })

  it('has the documented packet length and indices', () => {
    expect(PACKET_LENGTH).toBe(16)
    expect(F.treble).toBe(4)
    expect(F.tempo).toBe(11)
    expect(F.dt).toBe(13)
    expect(make().packet).toHaveLength(PACKET_LENGTH)
  })

  it('collapses a bass-only spectrum into the bass band', () => {
    const extractor = make()
    let packet: Float32Array = extractor.packet
    for (let frame = 0; frame < 120; frame++)
      packet = extractor.update(spectrum(only(80, 200, -20)), DT)
    expect(packet[F.bass]).toBeGreaterThan(0.95)
    for (const index of [F.sub, F.lowMid, F.highMid, F.treble]) {
      expect(packet[index]).toBeLessThan(0.1)
    }
    expect(packet[F.energy]).toBeGreaterThan(0.9)
  })

  it('collapses the same tone the same way at fftSize 4096', () => {
    const extractor = make(4096)
    let packet: Float32Array = extractor.packet
    for (let frame = 0; frame < 120; frame++) {
      packet = extractor.update(spectrum(only(2000, 3000, -20), 4096), DT)
    }
    expect(packet[F.highMid]).toBeGreaterThan(0.95)
    expect(packet[F.bass]).toBeLessThan(0.1)
  })

  it('reads silence as zero without onsets', () => {
    const extractor = make()
    let onsets = 0
    let packet: Float32Array = extractor.packet
    for (let frame = 0; frame < 300; frame++) {
      packet = extractor.update(spectrum(silence), DT)
      onsets += packet[F.onset] ?? 0
    }
    expect(onsets).toBe(0)
    for (let index = 0; index < 12; index++) expect(packet[index]).toBe(0)
    expect(packet[F.time]).toBeCloseTo(5, 1)
  })

  it('gives treble a faster attack than sub, per the defaults', () => {
    const extractor = make()
    const wide = spectrum(only(20, 16000, -20))
    let packet: Float32Array = extractor.packet
    // After one frame of a step, the faster band has climbed further.
    packet = extractor.update(spectrum(only(20, 16000, -100)), DT)
    packet = extractor.update(wide, DT)
    expect(packet[F.treble]).toBeGreaterThan(packet[F.sub] ?? 0)
    expect(DEFAULT_BANDS[4]?.attackMs).toBeLessThan(DEFAULT_BANDS[0]?.attackMs ?? 0)
  })

  it('detects every click in a click train and none in between, then finds its tempo', () => {
    const extractor = make()
    const quiet = spectrum(flat(-40))
    const click = spectrum(flat(-10))
    const onsetFrames: number[] = []
    let tempo = 0
    // Two clicks a second for twelve seconds: 120 beats per minute.
    for (let frame = 0; frame < 720; frame++) {
      const packet = extractor.update(frame % 30 === 0 ? click : quiet, DT)
      if (packet[F.onset]) onsetFrames.push(frame)
      tempo = packet[F.tempo] ?? 0
    }
    // The first click lands before the window has anything to compare with.
    const expected = Array.from({ length: 23 }, (_, i) => (i + 1) * 30)
    expect(onsetFrames).toEqual(expected)
    expect(tempo).toBeGreaterThan(117)
    expect(tempo).toBeLessThan(123)
  })

  it('reads a kick and snare pattern at the beat, not the bar', () => {
    // 140 BPM at 70 frames a second is 30 frames a beat. Beats alternate a
    // strong and a slightly softer hit, so the two-beat lag correlates as well
    // as the one-beat lag and a naive pick would say 70.
    const extractor = new FeatureExtractor({
      sampleRate: SAMPLE_RATE,
      fftSize: FFT_SIZE,
      nominalFrameRate: 70,
    })
    const quiet = spectrum(flat(-40))
    const strong = spectrum(flat(-10))
    const soft = spectrum(flat(-13))
    let tempo = 0
    for (let frame = 0; frame < 70 * 12; frame++) {
      const beat = frame % 30 === 0
      const frameIn = beat ? ((frame / 30) % 2 === 0 ? strong : soft) : quiet
      tempo = extractor.update(frameIn, 1 / 70)[F.tempo] ?? 0
    }
    expect(tempo).toBeGreaterThan(137)
    expect(tempo).toBeLessThan(143)
  })

  it('pulses to 1 on a click and decays afterwards', () => {
    const extractor = make()
    const quiet = spectrum(flat(-40))
    for (let frame = 0; frame < 60; frame++) extractor.update(quiet, DT)
    const hit = extractor.update(spectrum(flat(-10)), DT)
    expect(hit[F.onset]).toBe(1)
    expect(hit[F.beatPulse]).toBe(1)
    expect(hit[F.onsetStrength]).toBeGreaterThan(0.5)
    const later = extractor.update(quiet, DT)
    expect(later[F.beatPulse]).toBeLessThan(1)
    expect(later[F.beatPulse]).toBeGreaterThan(0.8)
    let packet: Float32Array = later
    for (let frame = 0; frame < 60; frame++) packet = extractor.update(quiet, DT)
    expect(packet[F.beatPulse]).toBeLessThan(0.01)
  })

  it('rarely calls steady jitter an onset', () => {
    const extractor = make()
    const next = random(7)
    let onsets = 0
    for (let frame = 0; frame < 600; frame++) {
      const packet = extractor.update(
        spectrum(() => -40 + (next() - 0.5) * 4),
        DT,
      )
      onsets += packet[F.onset] ?? 0
    }
    expect(onsets).toBeLessThanOrEqual(3)
  })

  it('clamps a wild frame step and keeps time', () => {
    const extractor = make()
    const packet = extractor.update(spectrum(silence), 5)
    expect(packet[F.dt]).toBeCloseTo(0.1)
    expect(packet[F.time]).toBeCloseTo(0.1)
  })
})
