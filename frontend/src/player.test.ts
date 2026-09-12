import { describe, expect, it } from 'vitest'

import { durationText, songCount } from './player'

describe('durationText', () => {
  it('shows minutes and zero-padded seconds', () => {
    expect(durationText(0)).toBe('0:00')
    expect(durationText(65)).toBe('1:05')
    expect(durationText(3599.9)).toBe('59:59')
  })
})

describe('songCount', () => {
  it('pluralises', () => {
    expect(songCount(1)).toBe('1 song')
    expect(songCount(2)).toBe('2 songs')
  })
})
