import { describe, expect, it } from 'vitest'

import type { LibraryTrack } from './api'
import {
  chosenIndex,
  decodeChosen,
  durationText,
  EDITED_SOURCE,
  encodeChosen,
  failureLimitNotice,
  indexAfterMove,
  isPassiveNotice,
  MAX_FAILURES,
  playNextPosition,
  PRELOAD_LEAD_SECONDS,
  preloadDue,
  QUEUE_LIMIT,
  queueEntryKey,
  queueHash,
  queueOverflow,
  queueSource,
  RESTORED_SOURCE,
  skippedNotice,
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

describe('queueSource', () => {
  it('keeps the collection through edits while the playing song is its own', () => {
    expect(queueSource('album:1', false, false)).toBe('album:1')
    expect(queueSource('album:1', true, false)).toBe('album:1')
  })

  it('is the listener’s queue while the playing song is one they added', () => {
    expect(queueSource('album:1', true, true)).toBe(EDITED_SOURCE)
  })

  it('makes an edited queue of unknown origin the listener’s own', () => {
    expect(queueSource(RESTORED_SOURCE, false, false)).toBe(RESTORED_SOURCE)
    expect(queueSource(RESTORED_SOURCE, true, false)).toBe(EDITED_SOURCE)
    expect(queueSource('', true, false)).toBe(EDITED_SOURCE)
  })

  it('leaves the sources that already stand for themselves alone', () => {
    expect(queueSource(EDITED_SOURCE, true, false)).toBe(EDITED_SOURCE)
    expect(queueSource('history', true, false)).toBe('history')
  })
})

describe('queueHash', () => {
  it('is the same for the same songs in the same order', () => {
    expect(queueHash(['a', 'b', 'c'])).toBe(queueHash(['a', 'b', 'c']))
  })

  it('changes with the order, the songs and the length', () => {
    const base = queueHash(['a', 'b', 'c'])
    expect(queueHash(['a', 'c', 'b'])).not.toBe(base)
    expect(queueHash(['a', 'b', 'd'])).not.toBe(base)
    expect(queueHash(['a', 'b'])).not.toBe(base)
    expect(queueHash([])).not.toBe(base)
  })

  it('does not run ids together', () => {
    expect(queueHash(['ab', 'c'])).not.toBe(queueHash(['a', 'bc']))
  })
})

describe('encodeChosen and decodeChosen', () => {
  it('keeps nothing when nothing was chosen', () => {
    expect(encodeChosen(queue, chosenAt())).toBe('')
  })

  it('finds the same entries again in a queue restored from the same ids', () => {
    const saved = encodeChosen(queue, chosenAt(1, 3))
    // A restore builds new entries from the saved ids, so only their places can carry over.
    const restored = queue.map((item) => ({ ...item }))
    const found = decodeChosen(restored, saved)
    expect(found.size).toBe(2)
    expect(found.has(restored[1] as LibraryTrack)).toBe(true)
    expect(found.has(restored[3] as LibraryTrack)).toBe(true)
  })

  it('keeps a song queued twice apart by its place', () => {
    const twice = [song('a'), song('b'), song('a')]
    const found = decodeChosen(twice, encodeChosen(twice, new Set([twice[2] as LibraryTrack])))
    expect(found.size).toBe(1)
    expect(found.has(twice[2] as LibraryTrack)).toBe(true)
    expect(found.has(twice[0] as LibraryTrack)).toBe(false)
  })

  it('drops the lot when the restored queue is not the one they were saved for', () => {
    const saved = encodeChosen(queue, chosenAt(1))
    expect(decodeChosen([...queue].reverse(), saved).size).toBe(0)
    expect(decodeChosen(queue.slice(0, 3), saved).size).toBe(0)
    expect(decodeChosen([...queue, song('e')], saved).size).toBe(0)
  })

  it('reads nothing from text that is missing, broken or the wrong shape', () => {
    expect(decodeChosen(queue, '').size).toBe(0)
    expect(decodeChosen(queue, 'not json').size).toBe(0)
    expect(decodeChosen(queue, 'null').size).toBe(0)
    expect(decodeChosen(queue, '[1,2]').size).toBe(0)
    expect(
      decodeChosen(queue, JSON.stringify({ hash: queueHash(['a', 'b', 'c', 'd']) })).size,
    ).toBe(0)
  })

  it('ignores places that are not in the queue', () => {
    const hash = queueHash(queue.map((item) => item.id))
    const saved = JSON.stringify({ hash, at: [1, 9, -1, 1.5, 'x', null] })
    expect([...decodeChosen(queue, saved)]).toEqual([queue[1]])
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
    expect(isPassiveNotice(skippedNotice('Delta'))).toBe(false)
    expect(isPassiveNotice(failureLimitNotice)).toBe(false)
  })
})

describe('preloadDue', () => {
  it('waits until the last seconds of a long track', () => {
    expect(preloadDue(200, 0)).toBe(false)
    expect(preloadDue(200, 200 - PRELOAD_LEAD_SECONDS - 1)).toBe(false)
    expect(preloadDue(200, 200 - PRELOAD_LEAD_SECONDS)).toBe(true)
    expect(preloadDue(200, 199)).toBe(true)
  })

  it('is due at once for a track shorter than the lead', () => {
    expect(preloadDue(PRELOAD_LEAD_SECONDS - 5, 0)).toBe(true)
    expect(preloadDue(PRELOAD_LEAD_SECONDS, 0)).toBe(true)
  })

  it('does not guess when the length is not known', () => {
    expect(preloadDue(0, 0)).toBe(false)
    expect(preloadDue(-1, 0)).toBe(false)
  })
})

describe('skippedNotice', () => {
  it('names the track that was skipped', () => {
    expect(skippedNotice('Delta')).toBe('Skipped Delta, it could not be played')
  })

  it('stops after the number of failures in a row that the notice states', () => {
    expect(failureLimitNotice).toContain(`Stopped after ${MAX_FAILURES} tracks in a row`)
  })
})
