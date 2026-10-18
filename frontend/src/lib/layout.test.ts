import { describe, expect, it } from 'vitest'

import { parseHomeSections, parseLayout } from './layout'

describe('parseLayout', () => {
  it('reads the two layouts', () => {
    expect(parseLayout('classic')).toBe('classic')
    expect(parseLayout('room')).toBe('room')
  })

  it('falls back to classic for anything else', () => {
    expect(parseLayout(null)).toBe('classic')
    expect(parseLayout('')).toBe('classic')
    expect(parseLayout('Room')).toBe('classic')
    expect(parseLayout('"room"')).toBe('classic')
  })
})

describe('parseHomeSections', () => {
  const allShown = {
    continue: true,
    stats: true,
    jump: true,
    fresh: true,
    mostPlayed: true,
    octive: true,
  }

  it('shows every section when nothing usable is stored', () => {
    expect(parseHomeSections(undefined)).toEqual(allShown)
    expect(parseHomeSections(null)).toEqual(allShown)
    expect(parseHomeSections('stats')).toEqual(allShown)
    expect(parseHomeSections(['stats'])).toEqual(allShown)
    expect(parseHomeSections(42)).toEqual(allShown)
  })

  it('hides only the sections stored as false', () => {
    expect(parseHomeSections({ stats: false, octive: false })).toEqual({
      ...allShown,
      stats: false,
      octive: false,
    })
  })

  it('treats a value that is not a boolean as shown', () => {
    expect(parseHomeSections({ stats: 'false', jump: 0, fresh: null })).toEqual(allShown)
  })

  it('drops keys it does not know', () => {
    expect(parseHomeSections({ podcasts: false, continue: false })).toEqual({
      ...allShown,
      continue: false,
    })
  })
})
