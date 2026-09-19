import { describe, expect, it } from 'vitest'

import type { LibraryTrack } from './api'
import {
  chosenIndex,
  durationText,
  indexAfterMove,
  isPassiveNotice,
  playNextPosition,
  QUEUE_LIMIT,
  queueEntryKey,
  queueOverflow,
  songCount,
} from './player'

const song = (id: string): LibraryTrack => ({
  id,
  title: id,
  artist: 'Artist',
  album: 'Album',
  duration: 100,
  playCount: 0,
})

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

describe('queueOverflow', () => {
  it('lets a queue fill to the limit and no further', () => {
    expect(queueOverflow(QUEUE_LIMIT - 3, 3)).toBe('')
    expect(queueOverflow(0, QUEUE_LIMIT)).toBe('')
  })

  it('refuses with the size it would reach', () => {
    expect(queueOverflow(QUEUE_LIMIT - 2, 3)).toContain(`${QUEUE_LIMIT + 1}`)
    expect(queueOverflow(QUEUE_LIMIT - 2, 3)).toContain('Nothing was added')
    expect(queueOverflow(0, QUEUE_LIMIT + 1)).not.toBe('')
  })
})

describe('indexAfterMove', () => {
  it('keeps the playing track when a song from behind it moves past it', () => {
    // a b [c] d e: moving b to the end leaves c one place earlier.
    expect(indexAfterMove(2, 1, 4)).toBe(1)
  })

  it('keeps the playing track when a song from after it moves before it', () => {
    expect(indexAfterMove(2, 4, 1)).toBe(3)
  })

  it('leaves it alone when the move happens on one side', () => {
    expect(indexAfterMove(2, 3, 4)).toBe(2)
    expect(indexAfterMove(2, 0, 1)).toBe(2)
  })

  it('follows the playing track itself', () => {
    expect(indexAfterMove(2, 2, 4)).toBe(4)
  })
})

const queue = ['a', 'b', 'c', 'd'].map(song)
/** The queue's entries at these places, the way the player remembers the ones chosen by hand. */
const chosenAt = (...places: number[]) =>
  new Set(queue.filter((_, place) => places.includes(place)))

describe('playNextPosition', () => {
  it('goes straight after the playing track', () => {
    expect(playNextPosition(queue, 1, chosenAt())).toBe(2)
  })

  it('goes behind songs already chosen to play next, so they keep their order', () => {
    expect(playNextPosition(queue, 1, chosenAt(2, 3))).toBe(4)
  })

  it('ignores a chosen song that is not directly after the playing one', () => {
    expect(playNextPosition(queue, 0, chosenAt(3))).toBe(1)
  })
})

describe('chosenIndex', () => {
  it('leaves the pick to chance when nothing was chosen', () => {
    expect(chosenIndex(queue, 1, chosenAt())).toBe(-1)
  })

  it('takes the nearest chosen song after the playing one', () => {
    expect(chosenIndex(queue, 1, chosenAt(0, 2, 3))).toBe(2)
  })

  it('goes back to the first chosen song when none is left ahead', () => {
    expect(chosenIndex(queue, 3, chosenAt(1))).toBe(1)
  })
})

describe('queueEntryKey', () => {
  it('tells a song queued twice apart, and keeps an entry its key', () => {
    const first = song('a')
    const second = { ...first }
    expect(queueEntryKey(first)).not.toBe(queueEntryKey(second))
    expect(queueEntryKey(first)).toBe(queueEntryKey(first))
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
