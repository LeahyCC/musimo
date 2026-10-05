import { describe, expect, it } from 'vitest'

import { dropForRoom, needsMore, SHUFFLE_AHEAD, stillWaiting } from './shuffle-deck'

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

  it('counts songs the server has not sent yet', () => {
    expect(stillWaiting({ seed: 's', cursor: 500, total: 100_000 })).toBe(99_500)
    expect(stillWaiting({ seed: '', cursor: 3, total: 3 })).toBe(0)
  })
})
