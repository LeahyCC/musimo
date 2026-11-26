import { describe, expect, it } from 'vitest'

import { shuffled, shuffleFrom, unshuffle } from './shuffle-order'

const list = ['a', 'b', 'c', 'd', 'e', 'f']

describe('shuffled', () => {
  it('keeps every song exactly once', () => {
    for (let run = 0; run < 50; run += 1) {
      expect([...shuffled(list)].sort()).toEqual(list)
    }
  })

  it('does not change the list it was given', () => {
    const before = [...list]
    shuffled(list)
    expect(list).toEqual(before)
  })

  it('reorders by the random source', () => {
    // A source of 0 swaps each slot with the first, which rotates the list by one.
    expect(shuffled(['a', 'b', 'c'], () => 0)).toEqual(['b', 'c', 'a'])
  })
})

describe('shuffleFrom', () => {
  it('plays the chosen song first and keeps the rest', () => {
    for (let run = 0; run < 20; run += 1) {
      const order = shuffleFrom(list, 3)
      expect(order[0]).toBe('d')
      expect([...order].sort()).toEqual(list)
    }
  })
})

describe('unshuffle', () => {
  it('puts the original order back with the playing song still playing', () => {
    const queue = ['e', 'b', 'f', 'a', 'c', 'd']
    expect(unshuffle(queue, 2, list)).toEqual({ items: list, index: 5 })
  })

  it('keeps a song queued by hand right after the playing one', () => {
    const queue = ['e', 'b', 'x', 'f', 'a', 'c', 'd']
    expect(unshuffle(queue, 1, list)).toEqual({
      items: ['a', 'b', 'x', 'c', 'd', 'e', 'f'],
      index: 1,
    })
  })

  it('keeps a hand-queued song playing when it is the one playing', () => {
    const queue = ['e', 'b', 'x', 'f']
    expect(unshuffle(queue, 2, list)).toEqual({ items: ['b', 'x', 'e', 'f'], index: 1 })
  })

  it('tells two copies of one song apart', () => {
    const one = { id: 's' }
    const two = { id: 's' }
    const other = { id: 't' }
    const result = unshuffle([two, other, one], 0, [one, other, two])
    expect(result.items).toEqual([one, other, two])
    expect(result.items[result.index]).toBe(two)
  })
})
