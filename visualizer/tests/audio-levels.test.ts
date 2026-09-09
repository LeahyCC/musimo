import assert from 'node:assert/strict'
import { test } from 'node:test'

import { AudioLevelAnalyser } from '../src/audio-levels.ts'
import { createAudioFrame } from '../src/pcm.ts'

const frame = createAudioFrame()

// Butterchurn takes the window rectangularly, so a bare sine smears across the
// whole spectrum and lands in every band at once. Shaping each synthetic window
// with a Hann envelope keeps a test tone inside the band it belongs to. Real
// recordings are broadband and need no such help.
const hann = (index: number) => 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / 1024)

function fill(sample: (index: number) => number) {
  for (let index = 0; index < 1024; index++) {
    const byte = Math.max(0, Math.min(255, Math.floor(128 + sample(index) * 128)))
    frame.timeByteArray[index] = byte
    frame.timeByteArrayL[index] = byte
    frame.timeByteArrayR[index] = byte
  }
}

const tone = (hz: number, offset: number) => (index: number) =>
  0.9 * hann(index) * Math.sin((2 * Math.PI * hz * (offset + index)) / 44100)

// Mean of each band over the opening frames of a fresh analyser. Every band
// starts from the same long average there, so the three are directly
// comparable; once a steady tone has been running the analyser normalises each
// band by its own history and they all converge on 1.
function openingBands(hz: number, frames = 10) {
  const analyser = new AudioLevelAnalyser()
  const total = { bass: 0, mid: 0, treb: 0 }
  for (let index = 0; index < frames; index++) {
    fill(tone(hz, index * 1024))
    const levels = analyser.update(frame)
    total.bass += levels.bass / frames
    total.mid += levels.mid / frames
    total.treb += levels.treb / frames
  }
  return total
}

test('silence settles on 1.0 in every band', () => {
  const analyser = new AudioLevelAnalyser()
  let levels = analyser.update(frame)
  fill(() => 0)
  for (let index = 0; index < 1500; index++) levels = analyser.update(frame)
  // Butterchurn holds the bands at 1.0 once the long average falls under its
  // floor, so quiet passages read as "nothing unusual" rather than as zero.
  assert.deepEqual(levels, {
    bass: 1,
    mid: 1,
    treb: 1,
    vol: 1,
    bassAtt: 1,
    midAtt: 1,
    trebAtt: 1,
    volAtt: 1,
  })
})

test('a 5 kHz tone reads as treble', () => {
  const bands = openingBands(5000)
  assert.ok(bands.treb > bands.mid, `treb ${bands.treb} should exceed mid ${bands.mid}`)
  assert.ok(bands.treb > bands.bass, `treb ${bands.treb} should exceed bass ${bands.bass}`)
})

test('a 60 Hz tone reads as bass rather than mid', () => {
  const bands = openingBands(60)
  assert.ok(bands.bass > bands.mid, `bass ${bands.bass} should exceed mid ${bands.mid}`)
})

// Butterchurn's equalize curve multiplies the lowest bins by nearly zero and
// the top of the band by 0.12, and samplePcm hands over 8-bit bytes. The
// quantisation floor of any loud tone therefore outweighs a 60 Hz fundamental
// in the treble sum, so `bass > treb` is not a property this analyser has. What
// each band does track is its own frequency range, which is what this checks.
test('each band follows its own frequency range', () => {
  const low = openingBands(60)
  const middle = openingBands(1000)
  const high = openingBands(5000)
  assert.ok(low.bass > high.bass * 20, `bass ${low.bass} vs ${high.bass}`)
  assert.ok(middle.mid > low.mid * 3, `mid ${middle.mid} vs ${low.mid}`)
  assert.ok(middle.mid > high.mid * 3, `mid ${middle.mid} vs ${high.mid}`)
  assert.ok(high.treb > low.treb, `treb ${high.treb} vs ${low.treb}`)
})

test('vol averages the three bands and the analyser resets to its idle state', () => {
  const analyser = new AudioLevelAnalyser()
  for (let index = 0; index < 40; index++) {
    fill(tone(220, index * 1024))
    analyser.update(frame)
  }
  fill(tone(220, 40 * 1024))
  const levels = analyser.update(frame)
  assert.ok(Math.abs(levels.vol - (levels.bass + levels.mid + levels.treb) / 3) < 1e-6)
  assert.ok(Math.abs(levels.volAtt - (levels.bassAtt + levels.midAtt + levels.trebAtt) / 3) < 1e-6)

  // A seek rebuilds from a reset analyser, so the same frames must replay the
  // same levels.
  analyser.reset()
  const replayed = []
  for (let index = 0; index < 41; index++) {
    fill(tone(220, index * 1024))
    replayed.push(analyser.update(frame))
  }
  assert.deepEqual(replayed[40], levels)
})

test('onset stays at zero through silence', () => {
  const analyser = new AudioLevelAnalyser()
  fill(() => 0)
  let onset = -1
  for (let index = 0; index < 200; index++) {
    analyser.update(frame)
    onset = analyser.onset
  }
  assert.equal(onset, 0)
})

// A broadband burst every 30 frames is a 2 Hz click train at the renderer's
// fixed 60 Hz step. Flux only fires on the rising edge, so each click reads as
// a spike that then decays under the release constant until the next one.
test('a click train peaks at each click and settles low between them', () => {
  const analyser = new AudioLevelAnalyser()
  const period = 30
  const cycles = 5
  const click = (index: number) =>
    0.5 * (tone(220, 0)(index) + tone(2200, 0)(index) + tone(6000, 0)(index))
  const values: number[] = []
  for (let index = 0; index < period * cycles; index++) {
    fill(index % period === 0 ? click : () => 0)
    analyser.update(frame)
    values.push(analyser.onset)
  }
  assert.ok(
    values.every((value) => value >= 0 && value <= 1),
    'onset left 0..1',
  )
  const lastCycle = values.slice((cycles - 1) * period, cycles * period)
  const peak = Math.max(...lastCycle)
  const trough = Math.min(...lastCycle.slice(5))
  assert.ok(peak > 0.05, `a click should raise onset above baseline: ${peak}`)
  assert.ok(peak > trough * 1.5, `peak ${peak} should clear the trough ${trough}`)
})

// Sustained sound is the case a flux-over-average design gets wrong: the mean
// of that ratio is 1 by construction, so a steady mix reads as one long onset.
// Grading flux between its baseline and recent peak has to settle near 0 on a
// steady broadband signal and still register a burst inside it.
test('a steady broadband signal settles near zero and a burst inside it still registers', () => {
  const analyser = new AudioLevelAnalyser()
  let state = 7
  const noise = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296 - 0.5
  }
  const bed = (offset: number, burst: boolean) => (index: number) => {
    const t = (offset + index) / 44100
    const mix =
      0.25 * Math.sin(2 * Math.PI * 110 * t) +
      0.15 * Math.sin(2 * Math.PI * 1500 * t) +
      0.1 * Math.sin(2 * Math.PI * 5000 * t) +
      0.15 * noise()
    return burst ? mix + 0.5 * noise() : mix
  }
  const values: number[] = []
  for (let index = 0; index < 260; index++) {
    fill(bed(index * 735, index === 200))
    analyser.update(frame)
    values.push(analyser.onset)
  }
  assert.ok(values.every((value) => value >= 0 && value <= 1))
  const steady = values.slice(120, 200).sort((a, b) => a - b)
  const median = steady[Math.floor(steady.length / 2)]
  const burst = Math.max(...values.slice(200, 212))
  assert.ok(median < 0.1, `steady sound should read near zero, got median ${median}`)
  assert.ok(
    burst > median * 3 && burst > 0.1,
    `burst ${burst} should clear the steady level ${median}`,
  )
})
