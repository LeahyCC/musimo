import { describe, expect, it } from 'vitest'

import type { DownloadJob, MusicResult } from '../../api'
import {
  ownedFraction,
  ownedShare,
  queuedTrackIds,
  releaseCoverage,
  trackCoverage,
} from './coverage'

const result = (id: number, over: Partial<MusicResult> = {}) =>
  ({ id, ownership: 'missing', track_count: 0, owned_count: 0, ...over }) as MusicResult
const job = (over: Partial<DownloadJob>) =>
  ({
    catalog: 'deezer',
    hidden: false,
    stage: 'queued',
    track_id: 1,
    album_id: 1,
    ...over,
  }) as DownloadJob

describe('queuedTrackIds', () => {
  it('lists catalog tracks with a job that has not finished', () => {
    const ids = queuedTrackIds([
      job({ track_id: 1 }),
      job({ track_id: 2, stage: 'done' }),
      job({ track_id: 3, stage: 'failed' }),
      job({ track_id: 4, hidden: true }),
      job({ track_id: 5, catalog: 'podcast' }),
    ])
    expect([...ids]).toEqual([1])
  })
})

describe('trackCoverage', () => {
  it('sorts tracks into owned, other edition, queued and missing', () => {
    const tracks = [
      result(1, { ownership: 'owned' }),
      result(2, { ownership: 'edition' }),
      result(3),
      result(4),
    ]
    expect(trackCoverage(tracks, new Set([3]))).toEqual({
      owned: 1,
      otherEdition: 1,
      queued: 1,
      missing: 1,
    })
  })

  it('does not count a track as queued when the file is already here', () => {
    const counts = trackCoverage([result(1, { ownership: 'owned' })], new Set([1]))
    expect(counts).toMatchObject({ owned: 1, queued: 0 })
  })
})

describe('releaseCoverage', () => {
  const releases = [
    result(10, { track_count: 10, owned_count: 6 }),
    result(11, { track_count: 5, owned_count: 0 }),
  ]

  it('adds up songs across releases', () => {
    expect(releaseCoverage(releases, [])).toEqual({
      owned: 6,
      otherEdition: 0,
      queued: 0,
      missing: 9,
    })
  })

  it('counts running jobs for these releases as queued, taken out of the missing', () => {
    const jobs = [job({ album_id: 11 }), job({ album_id: 11, track_id: 2 }), job({ album_id: 99 })]
    expect(releaseCoverage(releases, jobs)).toMatchObject({ owned: 6, queued: 2, missing: 7 })
  })

  it('never reports more owned songs than a release has', () => {
    const counts = releaseCoverage([result(1, { track_count: 3, owned_count: 9 })], [])
    expect(counts).toMatchObject({ owned: 3, missing: 0 })
  })
})

describe('ownedFraction and ownedShare', () => {
  it('say nothing until the release has a song count', () => {
    expect(ownedFraction({ owned_count: 0, track_count: 0 })).toBe('')
    expect(ownedShare({ owned_count: 0, track_count: 0 })).toBe(0)
  })

  it('give the fraction and the share of a counted release', () => {
    expect(ownedFraction({ owned_count: 7, track_count: 10 })).toBe('7/10')
    expect(ownedShare({ owned_count: 7, track_count: 10 })).toBe(0.7)
  })
})
