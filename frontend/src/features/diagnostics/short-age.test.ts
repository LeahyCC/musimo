import { describe, expect, it } from 'vitest'

import { shortAge } from './short-age'

const now = new Date(2026, 9, 17, 12, 0, 0)
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000)

describe('shortAge', () => {
  it('says now for under a minute, and for a clock that ran backwards', () => {
    expect(shortAge(ago(0), now)).toBe('NOW')
    expect(shortAge(ago(59), now)).toBe('NOW')
    expect(shortAge(ago(-30), now)).toBe('NOW')
  })

  it('counts minutes, hours and days, rounding down', () => {
    expect(shortAge(ago(60), now)).toBe('1M')
    expect(shortAge(ago(59 * 60 + 59), now)).toBe('59M')
    expect(shortAge(ago(3600), now)).toBe('1H')
    expect(shortAge(ago(23 * 3600 + 3599), now)).toBe('23H')
    expect(shortAge(ago(86_400), now)).toBe('1D')
    expect(shortAge(ago(6 * 86_400 + 86_399), now)).toBe('6D')
  })

  it('names the date once it is a week old', () => {
    expect(shortAge(new Date(2026, 9, 10, 9, 0, 0), now)).toBe('OCT 10')
    expect(shortAge(new Date(2026, 0, 2), now)).toBe('JAN 2')
  })
})
