import { describe, expect, it } from 'vitest'

import { consumeUpcoming, dropForRoom, needsMore, reshuffle, SHUFFLE_AHEAD } from './shuffle-deck'

describe('library shuffle window', () => {
  it('fetches more only when the playing song is near the end of the loaded window', () => {
    expect(needsMore(500, 0, 1000)).toBe(false)
    expect(needsMore(500, 500 - SHUFFLE_AHEAD, 1000)).toBe(true)
    expect(needsMore(10, 9, 0)).toBe(true)
  })

  it('drops played songs to stay inside the saved queue, and never the one playing', () => {
    expect(dropForRoom(400, 200, 200)).toBe(100)
    expect(dropForRoom(100, 0, 50)).toBe(0)
    expect(dropForRoom(500, 10, 200)).toBe(10)
  })

  it('keeps ids the server did not account for and drops ones it knows are gone', () => {
    expect(consumeUpcoming(['a', 'b', 'c', 'd'], ['a', 'b'], ['a'], ['b'])).toEqual(['c', 'd'])
    expect(consumeUpcoming(['a', 'b', 'c'], ['a', 'b'], [], [])).toEqual(['a', 'b', 'c'])
  })

  it('starts a new pass without the songs still in the queue', () => {
    const next = reshuffle(['a', 'b', 'c', 'd'], new Set(['b', 'c']))
    expect(next).toHaveLength(2)
    expect(next.slice().sort()).toEqual(['a', 'd'])
  })
})
