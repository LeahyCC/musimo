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
  'transitionActivity',
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

test('transition activity peaks mid-transition and is silent elsewhere, including after seeks', () => {
  const controller = new JourneyController(score)
  assert.equal(controller.sample(0).transitionActivity, 0, 'the first cue never fires an event')
  for (const cue of score.cues.slice(1)) {
    const before = controller.sample(cue.time - 0.001)
    const start = controller.sample(cue.time)
    const middle = controller.sample(cue.time + cue.transition / 2)
    const end = controller.sample(cue.time + cue.transition)
    const after = controller.sample(cue.time + cue.transition + 0.001)
    assert.equal(before.transitionActivity, 0, `${cue.label}: active before the window`)
    assert.equal(start.transitionActivity, 0, `${cue.label}: active at the window start`)
    assert(
      Math.abs(middle.transitionActivity - 1) < 1e-9,
      `${cue.label}: activity must peak at the midpoint`,
    )
    assert(end.transitionActivity < 1e-6, `${cue.label}: unsettled at the window end`)
    assert(after.transitionActivity < 1e-6, `${cue.label}: unsettled after the window`)
    // A seek landing mid-transition samples the same event as continuous playback.
    const seeker = new JourneyController(structuredClone(score))
    assert.equal(
      seeker.sample(cue.time + cue.transition / 2).transitionActivity,
      middle.transitionActivity,
      `${cue.label}: seek mid-transition changed the event`,
    )
    // Activity rises towards the midpoint and falls after it.
    const rising = controller.sample(cue.time + cue.transition * 0.25).transitionActivity
    const falling = controller.sample(cue.time + cue.transition * 0.75).transitionActivity
    assert(rising > 0.5 && rising < 1, `${cue.label}: rising edge too weak`)
    assert(falling > 0.5 && falling < 1, `${cue.label}: falling edge too weak`)
  }
  for (const time of [30, 120, 170, 250, 330]) {
    assert.equal(controller.sample(time).transitionActivity, 0, `mid-section at ${time}s`)
  }
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
