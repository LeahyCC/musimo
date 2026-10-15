import { describe, expect, it } from 'vitest'

import { DOZE_MS, OUTCOME_MS, PERK_MS, petMood } from './pet-mood'
import type { PetInputs } from './pet-mood'

const NOW = 1_000_000

const base: PetInputs = {
  now: NOW,
  thinking: false,
  scanning: false,
  offline: false,
  outcome: null,
  unread: false,
  loaded: false,
  playing: false,
  pausedAt: null,
  trackChangedAt: null,
  sleepTimer: false,
}
const mood = (changes: Partial<PetInputs>) => petMood({ ...base, ...changes })

describe('petMood', () => {
  it('is idle with nothing loaded and nothing happening', () => {
    expect(mood({})).toEqual({ state: 'idle', until: null })
  })

  it('listens while music plays, and only then', () => {
    expect(mood({ loaded: true, playing: true }).state).toBe('listening')
    expect(mood({ loaded: true, playing: false, pausedAt: NOW }).state).toBe('idle')
  })

  it('perks up briefly on a track change, then listens again', () => {
    const changed = mood({ loaded: true, playing: true, trackChangedAt: NOW - 100 })
    expect(changed).toEqual({ state: 'happy', until: NOW - 100 + PERK_MS })
    expect(mood({ loaded: true, playing: true, trackChangedAt: NOW - PERK_MS }).state).toBe(
      'listening',
    )
    // A track change while paused is not a reaction to anything heard.
    expect(mood({ loaded: true, trackChangedAt: NOW - 100, pausedAt: NOW }).state).toBe('idle')
  })

  it('dozes off after a few minutes paused and says when that will be', () => {
    const paused = mood({ loaded: true, pausedAt: NOW - 1000 })
    expect(paused).toEqual({ state: 'idle', until: NOW - 1000 + DOZE_MS })
    expect(mood({ loaded: true, pausedAt: NOW - DOZE_MS }).state).toBe('sleeping')
  })

  it('sleeps while the sleep timer runs', () => {
    expect(mood({ loaded: true, playing: true, sleepTimer: true }).state).toBe('sleeping')
    // With nothing loaded there is nothing for a timer to stop.
    expect(mood({ sleepTimer: true }).state).toBe('idle')
  })

  it('shows a request in flight above everything else', () => {
    expect(
      mood({ thinking: true, scanning: true, offline: true, loaded: true, playing: true }).state,
    ).toBe('thinking')
  })

  it('is busy during a library scan and offline without a model server', () => {
    expect(mood({ scanning: true, offline: true }).state).toBe('busy')
    expect(mood({ offline: true, loaded: true, playing: true }).state).toBe('offline')
  })

  it('holds a reply pose for a while, then falls back to playback', () => {
    for (const outcome of ['talking', 'happy', 'confused', 'sorry'] as const) {
      const fresh = mood({ outcome: { mood: outcome, at: NOW - 10 }, loaded: true, playing: true })
      expect(fresh).toEqual({ state: outcome, until: NOW - 10 + OUTCOME_MS })
    }
    const old = mood({
      outcome: { mood: 'sorry', at: NOW - OUTCOME_MS },
      loaded: true,
      playing: true,
    })
    expect(old.state).toBe('listening')
  })

  it('keeps talking while an unseen reply waits', () => {
    expect(mood({ unread: true, loaded: true, playing: true }).state).toBe('talking')
    expect(mood({ unread: true, outcome: { mood: 'happy', at: NOW } }).state).toBe('happy')
  })
})
