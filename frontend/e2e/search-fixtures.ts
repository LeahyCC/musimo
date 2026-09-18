import type { Page } from '@playwright/test'

import type { MusicResult } from '../src/api'

/** An invented catalog record, missing from the library unless `over` says otherwise. */
export const musicResult = (id: number, over: Partial<MusicResult> = {}): MusicResult => ({
  id,
  kind: 'album',
  title: `Fixture ${id}`,
  artist: 'Fixture artist',
  artist_id: 7,
  album: '',
  album_id: id,
  art: '',
  duration: 180,
  year: 2020,
  explicit: false,
  preview: '',
  isrc: '',
  popularity: 1,
  track_count: 1,
  record_type: 'album',
  ownership: 'missing',
  matched_paths: [],
  matched_by: '',
  matched_album: '',
  owned_count: 0,
  coverage_verified: true,
  disc: 1,
  position: 1,
  ...over,
})

const albums = [
  musicResult(42, { title: 'Harbor Lights' }),
  musicResult(43, {
    title: 'Owned Shore',
    ownership: 'owned',
    owned_count: 1,
    matched_paths: ['/music/Owned Shore'],
  }),
  musicResult(44, { title: 'Half Tide', track_count: 2, owned_count: 1, ownership: 'edition' }),
]
const tracks = [
  musicResult(101, { kind: 'track', title: 'Morning Signal', album: 'Harbor Lights' }),
  musicResult(102, { kind: 'track', title: 'Low Water', album: 'Harbor Lights', explicit: true }),
]
const artist = musicResult(7, { kind: 'artist', title: 'Fixture artist', record_type: '' })

/**
 * Catalog search, album and artist pages from invented records, so a spec can open every
 * Discover screen without a provider. Register it after the origin guard in `playerFixtures`:
 * Playwright tries the most recently added route first.
 */
export async function searchFixtures(page: Page): Promise<void> {
  await page.route('**/api/search?*', (route) => {
    const tab = new URL(route.request().url()).searchParams.get('kind')
    const items =
      tab === 'track'
        ? tracks
        : tab === 'album'
          ? albums
          : tab === 'artist'
            ? [artist]
            : [...tracks, ...albums, artist]
    return route.fulfill({
      json: { items, total: items.length, next_index: null, cached: false },
    })
  })

  await page.route('**/api/album-years?*', (route) => route.fulfill({ json: {} }))

  await page.route('**/api/albums/*', (route) => {
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1))
    const album = albums.find((item) => item.id === id) ?? musicResult(id)
    return route.fulfill({
      json: {
        album,
        tracks: tracks.map((track) => ({ ...track, album: album.title, album_id: album.id })),
        label: 'Fixture label',
        duration: 360,
        complete: true,
      },
    })
  })

  // A regex, because a glob's `*` stops at `/` and would let `/top` through to a live provider.
  await page.route(/\/api\/artists\/7(\/top)?(\?.*)?$/, (route) =>
    route.fulfill(
      new URL(route.request().url()).pathname.endsWith('/top')
        ? { json: { tracks } }
        : {
            json: {
              artist: { id: 7, name: 'Fixture artist', art: '' },
              items: albums,
              next_index: null,
            },
          },
    ),
  )
}
