import { describe, expect, it } from 'vitest'

import { parseSleepChoice, sleepChoiceLabel, sleepChoiceValue } from './sleep-timer'

describe('parseSleepChoice', () => {
  it('reads the two end options and the four lengths', () => {
    expect(parseSleepChoice('track')).toEqual({ kind: 'track' })
    expect(parseSleepChoice('queue')).toEqual({ kind: 'queue' })
    for (const minutes of [15, 30, 45, 60])
      expect(parseSleepChoice(String(minutes))).toEqual({ kind: 'minutes', minutes })
  })

  it('is null for Off and for anything that is not offered', () => {
    expect(parseSleepChoice('off')).toBeNull()
    expect(parseSleepChoice('')).toBeNull()
    expect(parseSleepChoice('20')).toBeNull()
    expect(parseSleepChoice('90')).toBeNull()
  })

  it('round-trips through the select value', () => {
    for (const value of ['track', 'queue', '15', '60']) {
      const choice = parseSleepChoice(value)
      expect(choice && sleepChoiceValue(choice)).toBe(value)
    }
  })
})

describe('sleepChoiceLabel', () => {
  it('says what the timer waits for', () => {
    expect(sleepChoiceLabel({ kind: 'track' })).toBe('the end of this track')
    expect(sleepChoiceLabel({ kind: 'queue' })).toBe('the end of the album or queue')
    expect(sleepChoiceLabel({ kind: 'minutes', minutes: 30 })).toBe('30 minutes')
  })
})
