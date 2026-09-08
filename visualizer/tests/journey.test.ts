import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { JourneyController } from '../src/journey.ts'
import type { JourneyScore, JourneyState } from '../src/journey.ts'

const score = JSON.parse(
  readFileSync(new URL('../songs/dive-extended-mix.song.json', import.meta.url), 'utf8'),
) as JourneyScore
const numeric = [
  'orbit',
  'current',
  'bloom',
  'intensity',
  'variation',
  'energy',
  'onset',
  'texture',
] as const

test('the authored recording returns to a recognisable form and crosses every cue continuously', () => {
  const controller = new JourneyController(score)
  const start = controller.sample(30)
  const flowering = controller.sample(120)
  const quiet = controller.sample(170)
  const returnVisit = controller.sample(240)
  assert.equal(start.orbit, 1)
  assert.equal(flowering.bloom, 1)
  assert.equal(quiet.current, 1)
  assert.equal(returnVisit.bloom, 1)
  assert(returnVisit.variation > flowering.variation)
  assert(quiet.intensity < flowering.intensity / 2)
  for (const cue of score.cues.slice(1)) {
    for (const time of [cue.time, cue.time + cue.transition]) {
      const before = controller.sample(time - 0.00001)
      const after = controller.sample(time + 0.00001)
      for (const key of numeric)
        assert(Math.abs(after[key] - before[key]) < 0.0001, `${cue.label}: ${key}`)
    }
  }
  const ordered = new Map<number, JourneyState>()
  for (let time = 0; time <= score.recording.duration; time += 0.5) {
    const state = controller.sample(time)
    numeric.forEach((key) =>
      assert(Number.isFinite(state[key]) && state[key] >= 0 && state[key] <= 1),
    )
    assert(Math.abs(state.orbit + state.current + state.bloom - 1) < 1e-9)
    ordered.set(time, state)
  }
  for (const [time, state] of [...ordered.entries()].reverse())
    assert.deepEqual(controller.sample(time), state)
  score.cues[0].intensity = 0.99
  assert.equal(controller.sample(0).intensity, 0.25, 'score mutation changed a prepared controller')
})

test('invalid feature grids and overlapping transitions cannot silently drive the renderer', () => {
  const overlap = structuredClone(score)
  overlap.cues[1].transition = 100
  assert.throws(() => new JourneyController(overlap), /overlapping/)
  const invalid = structuredClone(score)
  invalid.analysis = {
    hopSeconds: 0.05,
    columns: ['timeSeconds', 'rmsDb', 'centroidHz', 'flatness', 'flux'],
    frames: [[0, -20, 500, 0.2, NaN]],
  }
  assert.throws(() => new JourneyController(invalid), /feature grid/)
})
