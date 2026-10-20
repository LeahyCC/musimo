import { describe, expect, it } from 'vitest'

import type { MusicResult } from '../../api'
import {
  albumBatchStatus,
  artistQueueBucket,
  choiceCall,
  downloadPress,
  editionSentence,
  heldResult,
  houseBody,
  needsChoiceSentence,
} from './holding-choice'

function track(patch: Partial<MusicResult>): MusicResult {
  return {
    id: 1,
    kind: 'track',
    title: 'Song',
    artist: 'Artist',
    artist_id: 1,
    album: 'Album',
    album_id: 1,
    art: '',
    duration: 180,
    year: null,
    explicit: false,
    preview: '',
    isrc: '',
    spotify_id: '',
    popularity: 0,
    track_count: 0,
    record_type: '',
    ownership: 'missing',
    matched_paths: [],
    matched_by: '',
    matched_album: '',
    matched_song: '',
    owned_count: 0,
    coverage_verified: false,
    disc: 1,
    position: 1,
    ...patch,
  }
}

describe('download button choice', () => {
  it('hides the button for an exact download or a holding', () => {
    expect(downloadPress({ ownership: 'owned', matched_by: 'download' })).toBe('hide')
    expect(downloadPress({ ownership: 'missing', matched_by: 'download' })).toBe('hide')
    expect(downloadPress({ ownership: 'owned', matched_by: 'holding' })).toBe('hide')
    expect(downloadPress({ ownership: 'owned', matched_by: '' })).toBe('hide')
  })

  it('opens the dialog for an ISRC match and does not queue until Save another copy', () => {
    expect(downloadPress({ ownership: 'owned', matched_by: 'isrc' })).toBe('ask')
    expect(downloadPress({ ownership: 'edition', matched_by: 'tags' })).toBe('ask')
    expect(downloadPress({ ownership: 'owned', matched_by: 'mbid' })).toBe('ask')
    expect(choiceCall('cancel')).toBeNull()
    expect(choiceCall('house')).toBe('holdings')
    expect(choiceCall('copy')).toBe('jobs')
  })

  it('keeps the house copy on the existing file', () => {
    const item = track({
      ownership: 'owned',
      matched_by: 'isrc',
      matched_song: 'tr-aaaaaaaaaaaaaaaa',
      matched_paths: ['/music/old.flac'],
    })
    const held = heldResult(item, {
      trackId: 1,
      spotifyId: '',
      songId: 'tr-aaaaaaaaaaaaaaaa',
      path: '/music/old.flac',
    })
    expect(held.ownership).toBe('owned')
    expect(held.matched_by).toBe('holding')
    expect(held.matched_song).toBe('tr-aaaaaaaaaaaaaaaa')
    expect(held.matched_paths).toEqual(['/music/old.flac'])
    expect(houseBody('isrc')).toContain('same ISRC')
    expect(houseBody('mbid')).toContain('MusicBrainz')
    expect(houseBody('tags')).toContain('artist, title, and duration')
    expect(editionSentence('edition', 'Other Album')).toBe(
      'That file is on "Other Album", a different album.',
    )
    expect(editionSentence('owned', 'Other Album')).toBe('')
  })

  it('counts uncertain batch tracks in one sentence', () => {
    expect(needsChoiceSentence(1)).toBe(
      '1 track match a file already here. Download those one at a time to choose.',
    )

    expect(needsChoiceSentence(2)).toBe(
      '2 tracks match a file already here. Download those one at a time to choose.',
    )
  })

  it('uses the choice sentence when an album batch queued nothing', () => {
    const sentence = needsChoiceSentence(1)
    expect(albumBatchStatus(0, { jobs: [], needs_choice: 1 })).toEqual({
      link: sentence,
      choice: '',
    })
    expect(albumBatchStatus(0, { jobs: [{ id: 'a' }], needs_choice: 2 }).link).toBe('1 queued')
    expect(albumBatchStatus(0, { jobs: [], needs_choice: 0 }).link).toBe('Nothing missing')
  })

  it('leaves an uncertain artist track out of the queue count', () => {
    expect(artistQueueBucket({ owned: false, skip: 'choice' }, true, false)).toBe('choice')
    expect(artistQueueBucket({ owned: true, skip: 'choice' }, false, false)).toBe('choice')
    expect(artistQueueBucket({ owned: true, skip: 'owned' }, false, false)).toBe('owned')
    expect(artistQueueBucket({ owned: true, skip: '' }, false, false)).toBe('download')
    expect(artistQueueBucket({ owned: true, skip: '' }, true, false)).toBe('owned')
  })
})
