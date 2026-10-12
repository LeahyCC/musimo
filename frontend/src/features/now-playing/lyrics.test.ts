import { describe, expect, it } from 'vitest'

import { currentLineIndex, formatOffset, parseOffsets, withOffset } from './lyrics'

describe('currentLineIndex', () => {
  const starts = [1, 5, undefined, 9]

  it('is -1 before the first line', () => {
    expect(currentLineIndex(starts, 0.5)).toBe(-1)
  })

  it('picks the last line that has started', () => {
    expect(currentLineIndex(starts, 1)).toBe(0)
    expect(currentLineIndex(starts, 6)).toBe(1)
    expect(currentLineIndex(starts, 100)).toBe(3)
  })

  it('skips lines without a time', () => {
    expect(currentLineIndex([undefined, undefined], 10)).toBe(-1)
  })
})

describe('withOffset', () => {
  it('sets and replaces a track', () => {
    const first = withOffset(new Map(), 'a', 0.5)
    expect(withOffset(first, 'a', 1).get('a')).toBe(1)
  })

  it('stores nothing for zero', () => {
    expect(withOffset(new Map([['a', 1]]), 'a', 0).has('a')).toBe(false)
  })

  it('drops the oldest entries past the limit and keeps the newest', () => {
    let saved = new Map<string, number>()
    for (let index = 0; index < 5; index += 1) saved = withOffset(saved, `t${index}`, 0.5, 3)
    expect([...saved.keys()]).toEqual(['t2', 't3', 't4'])
  })

  it('moves a rewritten track to the newest slot', () => {
    let saved = new Map<string, number>()
    for (const id of ['a', 'b', 'c']) saved = withOffset(saved, id, 0.5, 3)
    saved = withOffset(saved, 'a', 1, 3)
    saved = withOffset(saved, 'd', 1, 3)
    expect([...saved.keys()]).toEqual(['c', 'a', 'd'])
  })
})

describe('parseOffsets', () => {
  it('reads a saved map', () => {
    expect(parseOffsets('{"a":0.5,"b":-1}').get('b')).toBe(-1)
  })

  it('ignores entries that are not numbers', () => {
    expect([...parseOffsets('{"a":"x","b":2}').keys()]).toEqual(['b'])
  })

  it('treats anything unreadable as empty', () => {
    expect(parseOffsets('').size).toBe(0)
    expect(parseOffsets('not json').size).toBe(0)
    expect(parseOffsets('[1,2]').size).toBe(0)
    expect(parseOffsets('null').size).toBe(0)
  })
})

describe('formatOffset', () => {
  it('shows the sign and one decimal', () => {
    expect(formatOffset(0)).toBe('0.0 s')
    expect(formatOffset(1.5)).toBe('+1.5 s')
    expect(formatOffset(-0.5)).toBe('-0.5 s')
  })
})
