import assert from 'node:assert/strict'
import { test } from 'node:test'

import { journeyFor, preparedSongs } from '../src/songs.ts'

test('the prepared Dive recording resolves to its journey score', () => {
  const [dive] = preparedSongs
  assert.ok(dive)
  const score = journeyFor(dive.sha256)
  assert.ok(score)
  assert.equal(score.recording.sha256, dive.sha256)
  assert.equal(score.recording.duration, dive.duration)
  assert.equal(score.recording.analysisSampleRate, 44100)
  assert.ok(score.cues.length > 1)
  assert.ok(score.analysis)
  assert.ok(score.analysis.frames.length > 1000)
  assert.equal(score.analysis.columns[0], 'timeSeconds')
})

test('the lookup is case-insensitive and unknown recordings get nothing', () => {
  const [dive] = preparedSongs
  assert.ok(dive)
  assert.ok(journeyFor(dive.sha256.toUpperCase()))
  assert.equal(journeyFor('0'.repeat(64)), undefined)
})
