import { describe, expect, it } from 'vitest'

import { durationText, isPassiveNotice, songCount } from './player'

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

describe('isPassiveNotice', () => {
  it('holds back the lines that only say where the sound comes from', () => {
    expect(isPassiveNotice('Your Navidrome library')).toBe(true)
    expect(isPassiveNotice('Queue restored. Press play to continue.')).toBe(true)
  })

  it('lets errors, confirmations and empty text through', () => {
    expect(isPassiveNotice('This library track could not be played.')).toBe(false)
    expect(isPassiveNotice('Created playlist Road trip.')).toBe(false)
    expect(isPassiveNotice('')).toBe(false)
  })
})
