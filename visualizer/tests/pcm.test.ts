import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createAudioFrame, samplePcm } from '../src/pcm.ts'

test('prepared PCM follows media time, pads silence and preserves stereo', () => {
  const left = Float32Array.from({ length: 44100 * 2 }, (_, index) => Math.sin(index / 37) * 0.8)
  const right = Float32Array.from(left, (value) => -value)
  const pcm = { sampleRate: 44100, left, right }
  const frame = createAudioFrame()
  samplePcm(pcm, 0, frame)
  assert.ok(frame.timeByteArrayL.every((value) => value === 128))
  samplePcm(pcm, 0.75, frame)
  const expected = new Uint8Array(frame.timeByteArrayL)
  assert.ok(frame.timeByteArray.every((value) => value === 128))
  assert.notDeepEqual(frame.timeByteArrayL, frame.timeByteArrayR)
  for (const refresh of [30, 60, 144]) {
    for (let i = 0; i < refresh; i++) samplePcm(pcm, i / refresh, frame)
    samplePcm(pcm, 0.75, frame)
    assert.deepEqual(frame.timeByteArrayL, expected)
  }
  samplePcm(pcm, 0.5, frame, 0.25)
  assert.deepEqual(frame.timeByteArrayL, expected)
  samplePcm(pcm, 3, frame)
  assert.ok(frame.timeByteArrayL.every((value) => value === 128))
})
