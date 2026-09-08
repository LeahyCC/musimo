import assert from 'node:assert/strict'
import test from 'node:test'

import { seedFor, songMapSchema, VisualizerDirector } from '../src/visualizer-director.ts'

const features = (time: number, energy = 0.3) => ({
  time,
  energy,
  bass: energy,
  body: energy,
  air: energy,
  onset: 0,
  width: 0,
})
const map = songMapSchema.parse({
  version: 1,
  duration: 30,
  hop: 1,
  energy: Array(30).fill(0.5),
  bass: Array(30).fill(0.4),
  body: Array(30).fill(0.3),
  air: Array(30).fill(0.2),
  beats: [0, 0.5, 1, 1.5, 2],
  confidence: 0.9,
  sections: [
    { start: 0, end: 10, identity: 0, energy: 0.3 },
    { start: 10, end: 20, identity: 1, energy: 0.8 },
    { start: 20, end: 30, identity: 0, energy: 0.3 },
  ],
})

test('seeking reconstructs a recurring section and does not fabricate a first visit', () => {
  const director = new VisualizerDirector()
  director.update(features(1), map, false)
  assert.equal(director.update(features(22), map, false).phase, 'Return')
  assert.equal(director.update(features(1), map, false).phase, 'Emerge')
})

test('a known upcoming release builds tension; unknown live input makes no future claim', () => {
  const director = new VisualizerDirector()
  assert.equal(director.update(features(8), map, false).phase, 'Build')
  assert.equal(new VisualizerDirector().update(features(8), null, false).phase, 'Emerge')
})

test('hold preserves the composition while the audio bands still change', () => {
  const director = new VisualizerDirector()
  const initial = director.update(features(1), null, false)
  const held = director.update(features(1.05, 0.9), null, true)
  assert.equal(held.opening, initial.opening)
  assert.equal(held.bass, 0.9)
})

test('a track retains its seed and malformed maps cannot enter the director', () => {
  assert.equal(seedFor('same-track'), seedFor('same-track'))
  assert.notEqual(seedFor('same-track'), seedFor('other-track'))
  assert.equal(songMapSchema.safeParse({ ...map, energy: [Infinity] }).success, false)
})

test('a newly available map fades in and hold survives seeking', () => {
  const director = new VisualizerDirector()
  director.update(features(1, 0.1), null, false)
  const adopted = director.update(features(1.02, 0.1), map, false)
  assert.ok(adopted.bass > 0.1 && adopted.bass < 0.12)
  const held = director.update(features(22), map, true)
  assert.equal(held.opening, adopted.opening)
  assert.equal(held.identity, adopted.identity)
})
