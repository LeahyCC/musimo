import { describe, expect, it } from 'vitest'

import type { MusicResult } from '../../api'
import {
  ACCOUNT_SOURCE,
  accountStreamStopped,
  BUSY,
  canAccountPlay,
  catalogAction,
  COMMAND_REQUIRED,
  FREE_ACCOUNT,
  sourceName,
  toQueueTrack,
  UNAVAILABLE,
} from './account-play'
import type { DeezerListen } from './account-play'

const signedIn: DeezerListen = {
  ready: true,
  detail: '',
  command: true,
  cached: [],
  unavailable: [],
}

const track = (patch: Partial<MusicResult> = {}): MusicResult =>
  ({
    id: 7,
    kind: 'track',
    title: 'Song',
    artist: 'Artist',
    artist_id: 1,
    album: 'Album',
    album_id: 2,
    art: 'https://cdn.example/art.jpg',
    duration: 180,
    year: 2001,
    explicit: false,
    preview: 'https://cdn.example/preview.mp3',
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
  }) as MusicResult

describe('catalog rows', () => {
  it('offers Play when the account is signed in', () => {
    expect(
      catalogAction({
        item: track(),
        playingPreview: false,
        playingAccount: false,
        fetching: false,
        listen: signedIn,
      }),
    ).toMatchObject({
      label: 'Play',
      press: 'play',
    })
  })

  it('stays on Preview when the account is not usable', () => {
    const listen: DeezerListen = { ...signedIn, ready: false, detail: '' }
    expect(
      catalogAction({
        item: track(),
        playingPreview: false,
        playingAccount: false,
        fetching: false,
        listen,
      }),
    ).toMatchObject({
      label: 'Preview',
      press: 'preview',
    })
  })

  it('says so when a free account cannot play a full song', () => {
    const listen: DeezerListen = { ...signedIn, ready: false, detail: FREE_ACCOUNT }
    expect(
      catalogAction({
        item: track(),
        playingPreview: false,
        playingAccount: false,
        fetching: false,
        listen,
      }).title,
    ).toBe(FREE_ACCOUNT)
  })

  it('stays on Preview and names the command when none is set', () => {
    const listen: DeezerListen = { ...signedIn, command: false }
    const action = catalogAction({
      item: track(),
      playingPreview: false,
      playingAccount: false,
      fetching: false,
      listen,
    })
    expect(action.label).toBe('Preview')
    expect(action.title).toBe(COMMAND_REQUIRED)
    expect(canAccountPlay(track(), listen)).toBe(false)
  })

  it('offers Play for a saved file that already plays, even with an empty command', () => {
    const listen: DeezerListen = { ...signedIn, command: false, cached: [7] }
    expect(canAccountPlay(track(), listen)).toBe(true)
  })

  it('plays an owned song from the library file', () => {
    const item = track({ ownership: 'owned', matched_song: 'tr-abc' })
    const queued = toQueueTrack(item)
    expect(queued.origin).toBe('library')
    expect(queued.id).toBe('tr-abc')
  })

  it('keeps a Deezer song on the account', () => {
    const queued = toQueueTrack(track())
    expect(queued).toMatchObject({ id: 'dz-7', origin: 'deezer', deezerId: 7 })
  })

  it('stays unavailable when a clip exists', () => {
    const listen: DeezerListen = { ...signedIn, unavailable: [7] }
    expect(
      catalogAction({
        item: track(),
        playingPreview: false,
        playingAccount: false,
        fetching: false,
        listen,
      }),
    ).toMatchObject({
      label: 'Unavailable',
      title: UNAVAILABLE,
      disabled: true,
    })
  })

  it('leaves a Spotify row on Preview', () => {
    const item = track({ id: 0, spotify_id: 'sp1' })
    expect(
      catalogAction({
        item,
        playingPreview: false,
        playingAccount: false,
        fetching: false,
        listen: signedIn,
      }),
    ).toMatchObject({
      label: 'Preview',
      press: 'preview',
    })
    expect(canAccountPlay(item, signedIn)).toBe(false)
  })

  it('cancels a fetch from the loading label', () => {
    expect(
      catalogAction({
        item: track(),
        playingPreview: false,
        playingAccount: false,
        fetching: true,
        listen: signedIn,
      }),
    ).toMatchObject({
      label: 'Fetching…',
      title: 'Cancel',
      press: 'cancel',
    })
  })
})

describe('source names', () => {
  it('names the account, the library and a preview', () => {
    expect(
      sourceName(
        {
          id: 'dz-1',
          title: '',
          artist: '',
          album: '',
          duration: 1,
          playCount: 0,
          origin: 'deezer',
        },
        null,
      ),
    ).toBe(ACCOUNT_SOURCE)

    expect(
      sourceName(
        {
          id: 'tr-1',
          title: '',
          artist: '',
          album: '',
          duration: 1,
          playCount: 0,
          origin: 'library',
        },
        null,
      ),
    ).toBe('Library')
    expect(sourceName(null, { spotify_id: '' })).toBe('Preview')
    expect(sourceName(null, { spotify_id: 'sp' })).toBe('Spotify preview')
  })

  it('stops an account stream when the sign-in is gone', () => {
    expect(accountStreamStopped('deezer', false)).toBe(true)
    expect(accountStreamStopped('deezer', true)).toBe(false)
    expect(accountStreamStopped('library', false)).toBe(false)
  })
})

describe('busy account', () => {
  it('uses the sentence the server returns', () => {
    expect(BUSY).toBe('The Deezer account is busy.')
  })
})
