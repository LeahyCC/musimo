import type { Page } from '@playwright/test'

import type { DownloadJob, LibraryTrack, MusicResult } from '../src/api'
import { librarySong } from './library-fixtures'
import { musicResult } from './search-fixtures'

/* A small invented library with drawn covers, for the README screenshots and the phone walk. Every
   artist, album and song here is made up, and the covers are SVG drawn from the album's colors, so
   no real artwork or personal music reaches a screenshot. Register it after `playerFixtures` and
   `searchFixtures`, since Playwright tries the most recently added route first. */

type Cover = {
  from: string
  to: string
  ink: string
  motif: 'sun' | 'rings' | 'waves' | 'grid' | 'bars' | 'moon'
}

type ShowcaseAlbum = {
  id: string
  name: string
  artist: string
  year: number
  genre: string
  cover: Cover
  songs: readonly string[]
}

const ALBUMS: readonly ShowcaseAlbum[] = [
  {
    id: 'glass-garden',
    name: 'Glass Garden',
    artist: 'Mira Vale',
    year: 2025,
    genre: 'Dream pop',
    cover: { from: '#f6a6c1', to: '#6a5acd', ink: '#fff4e6', motif: 'sun' },
    songs: ['Greenhouse', 'Slow Bloom', 'Prism Hour', 'Wet Paint', 'Terrarium', 'Last Light In'],
  },
  {
    id: 'low-orbit',
    name: 'Low Orbit',
    artist: 'Kestrel',
    year: 2024,
    genre: 'Electronic',
    cover: { from: '#0b1d3a', to: '#13b5c8', ink: '#e9fbff', motif: 'rings' },
    songs: ['Apogee', 'Telemetry', 'Cold Start', 'Perigee', 'Burn Window', 'Splashdown'],
  },
  {
    id: 'copper-sun',
    name: 'Copper Sun',
    artist: 'Ama Okoro',
    year: 2023,
    genre: 'Afrobeat',
    cover: { from: '#ffb347', to: '#c0392b', ink: '#2b0f08', motif: 'bars' },
    songs: ['Market Day', 'Harmattan', 'Brass & Dust', 'Lagos at Four', 'Okada'],
  },
  {
    id: 'saltwater-radio',
    name: 'Saltwater Radio',
    artist: 'Juniper & Lowe',
    year: 2021,
    genre: 'Folk',
    cover: { from: '#d8e9e4', to: '#3f7f8c', ink: '#123036', motif: 'waves' },
    songs: ['Harbour Song', 'Static on the Line', 'Driftwood', 'Lighthouse Keeper', 'Ebb'],
  },
  {
    id: 'velvet-static',
    name: 'Velvet Static',
    artist: 'Neon Parish',
    year: 2020,
    genre: 'Synthwave',
    cover: { from: '#2a0845', to: '#ff2e88', ink: '#ffe1f0', motif: 'grid' },
    songs: ['Midnight Drive', 'Chrome Heart', 'VHS Summer', 'Afterglow', 'Night Shift'],
  },
  {
    id: 'paper-planets',
    name: 'Paper Planets',
    artist: 'Tomo Aoki',
    year: 2025,
    genre: 'Lo-fi',
    cover: { from: '#fde7c8', to: '#e58f65', ink: '#3b2a24', motif: 'moon' },
    songs: ['Rainy Kissaten', 'Origami', 'Bus 42', 'Tatami Nap', 'Late Library'],
  },
  {
    id: 'clear-water',
    name: 'Clear Water',
    artist: 'Harbor Static',
    year: 2026,
    genre: 'Ambient',
    cover: { from: '#c3e4a2', to: '#1f4d3a', ink: '#0e1f17', motif: 'waves' },
    songs: ['First Light', 'Second Tide', 'Still Pool', 'Reed Beds', 'Shallows'],
  },
  {
    id: 'heatwave-tapes',
    name: 'Heatwave Tapes',
    artist: 'Rosa Bloom',
    year: 2023,
    genre: 'Soul',
    cover: { from: '#ffd166', to: '#ef476f', ink: '#3d0b1a', motif: 'sun' },
    songs: ['Sugar on the Stove', 'Porch Light', 'Ninety Degrees', 'Call Me Sunday'],
  },
  {
    id: 'northern-lines',
    name: 'Northern Lines',
    artist: 'Fjell',
    year: 2019,
    genre: 'Post-rock',
    cover: { from: '#1b2a49', to: '#6fd3a4', ink: '#e8fff4', motif: 'bars' },
    songs: ['Aurora', 'Permafrost', 'Long Night', 'Thaw', 'Fjord'],
  },
  {
    id: 'midnight-market',
    name: 'Midnight Market',
    artist: 'Dulce Ramos',
    year: 2024,
    genre: 'Latin jazz',
    cover: { from: '#3a0ca3', to: '#f72585', ink: '#fff0f7', motif: 'moon' },
    songs: ['Mercado', 'Guava Smoke', 'Bolero for Two', 'Calle Luna'],
  },
  {
    id: 'echo-valley',
    name: 'Echo Valley',
    artist: 'The Long Grass',
    year: 2018,
    genre: 'Americana',
    cover: { from: '#e9c46a', to: '#6b4226', ink: '#2a1a0e', motif: 'sun' },
    songs: ['Dust Road', 'Porchlight Waltz', 'Creek Bed', 'Barn Dance'],
  },
  {
    id: 'night-bus',
    name: 'Night Bus Hymns',
    artist: 'The Lanterns',
    year: 2024,
    genre: 'Indie',
    cover: { from: '#222831', to: '#f4a259', ink: '#fff3e0', motif: 'grid' },
    songs: ['Last Stop', 'Sodium Lights', 'Upper Deck', 'Night Fare', 'Home by Two'],
  },
]

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-')
const artistId = (name: string) => `artist-${slug(name)}`

/** A cover drawn from two colors and a motif. Square, so it fits every cover slot. */
function coverSvg({ from, to, ink, motif }: Cover): string {
  const shapes: Record<Cover['motif'], string> = {
    sun: `<circle cx="300" cy="330" r="150" fill="${ink}" opacity=".9"/><rect y="400" width="600" height="200" fill="${to}" opacity=".85"/><g stroke="${ink}" stroke-width="6" opacity=".5">${[
      430, 460, 495, 535,
    ]
      .map((y) => `<line x1="0" y1="${y}" x2="600" y2="${y}"/>`)
      .join('')}</g>`,
    rings:
      [210, 160, 110, 60]
        .map(
          (r, i) =>
            `<circle cx="380" cy="230" r="${r}" fill="none" stroke="${ink}" stroke-width="${4 + i * 3}" opacity="${0.35 + i * 0.18}"/>`,
        )
        .join('') + `<circle cx="380" cy="230" r="26" fill="${ink}"/>`,
    waves: [0, 1, 2, 3, 4, 5]
      .map(
        (i) =>
          `<path d="M0 ${300 + i * 48} C150 ${250 + i * 48} 300 ${350 + i * 48} 600 ${290 + i * 48}" fill="none" stroke="${ink}" stroke-width="10" opacity="${0.25 + i * 0.12}"/>`,
      )
      .join(''),
    grid:
      `<circle cx="300" cy="250" r="140" fill="${ink}" opacity=".85"/><rect y="250" width="600" height="350" fill="${from}"/>` +
      [0, 1, 2, 3, 4, 5, 6]
        .map(
          (i) =>
            `<line x1="0" y1="${270 + i * i * 9}" x2="600" y2="${270 + i * i * 9}" stroke="${to}" stroke-width="4"/>`,
        )
        .join('') +
      [-3, -2, -1, 0, 1, 2, 3]
        .map(
          (i) =>
            `<line x1="${300 + i * 40}" y1="250" x2="${300 + i * 220}" y2="600" stroke="${to}" stroke-width="4"/>`,
        )
        .join(''),
    bars: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
      .map((i) => {
        const h = 80 + ((i * 97) % 260)
        return `<rect x="${40 + i * 54}" y="${520 - h}" width="34" height="${h}" rx="17" fill="${ink}" opacity="${0.45 + (i % 3) * 0.2}"/>`
      })
      .join(''),
    moon: `<circle cx="400" cy="200" r="110" fill="${ink}"/><circle cx="445" cy="170" r="100" fill="${from}" opacity=".92"/>${[
      0, 1, 2, 3, 4, 5, 6, 7,
    ]
      .map(
        (i) =>
          `<circle cx="${60 + ((i * 131) % 480)}" cy="${80 + ((i * 89) % 420)}" r="${3 + (i % 3) * 2}" fill="${ink}" opacity=".7"/>`,
      )
      .join('')}`,
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="600" height="600" fill="url(#g)"/>${shapes[motif]}</svg>`
}

const ARTIST_COVERS: Record<string, Cover> = Object.fromEntries(
  ALBUMS.map((album) => [
    artistId(album.artist),
    { ...album.cover, motif: album.cover.motif === 'rings' ? 'moon' : 'rings' },
  ]),
)

function songsOf(album: ShowcaseAlbum): LibraryTrack[] {
  return album.songs.map((title, index) =>
    librarySong(`${album.id}-${index + 1}`, {
      title,
      artist: album.artist,
      artistId: artistId(album.artist),
      album: album.name,
      albumId: album.id,
      coverArt: album.id,
      duration: 170 + ((index * 53 + album.name.length * 7) % 140),
      track: index + 1,
      year: album.year,
      genre: album.genre,
      playCount: (album.songs.length - index) * 3 + album.name.length,
      codec: index % 3 === 0 ? 'flac' : 'mp3',
    }),
  )
}

const ALL_SONGS = ALBUMS.flatMap(songsOf)
const albumById = new Map(ALBUMS.map((album) => [album.id, album]))
const albumJson = (album: ShowcaseAlbum) => {
  const songs = songsOf(album)
  return {
    id: album.id,
    name: album.name,
    artist: album.artist,
    artistId: artistId(album.artist),
    coverArt: album.id,
    songCount: songs.length,
    duration: songs.reduce((sum, song) => sum + song.duration, 0),
    year: album.year,
    genre: album.genre,
    created: `2026-10-${String(18 - ALBUMS.indexOf(album)).padStart(2, '0')}T12:00:00Z`,
  }
}

const ARTISTS = [...new Set(ALBUMS.map((album) => album.artist))].map((name) => ({
  id: artistId(name),
  name,
  coverArt: artistId(name),
  albumCount: ALBUMS.filter((album) => album.artist === name).length,
}))

/** The queue the footer, dock and Now Playing show: Glass Garden, second song playing. */
export const SHOWCASE_QUEUE = [
  ...songsOf(ALBUMS[0]!),
  ...songsOf(ALBUMS[1]!).slice(0, 3),
  ...songsOf(ALBUMS[5]!).slice(0, 2),
]
export const SHOWCASE_NOW = SHOWCASE_QUEUE[1]!

const playlist = (id: string, name: string, entry: readonly LibraryTrack[], cover?: string) => ({
  id,
  name,
  songCount: entry.length,
  duration: entry.reduce((sum, song) => sum + song.duration, 0),
  public: id === 'sunday',
  owner: 'Listener',
  changed: '2026-10-17T09:00:00Z',
  coverArt: cover,
  entry,
})

const pick = (...ids: string[]) => ids.map((id) => ALL_SONGS.find((song) => song.id === id)!)
const PLAYLISTS = [
  playlist(
    'liked',
    'Liked',
    pick('glass-garden-3', 'low-orbit-2', 'copper-sun-1', 'velvet-static-1', 'paper-planets-1'),
  ),
  playlist(
    'sunday',
    'Slow Sunday',
    pick(
      'saltwater-radio-1',
      'paper-planets-2',
      'clear-water-1',
      'heatwave-tapes-2',
      'echo-valley-2',
      'glass-garden-2',
    ),
    'saltwater-radio',
  ),
  playlist(
    'late-drive',
    'Late night drive',
    pick('velvet-static-1', 'night-bus-2', 'low-orbit-3', 'midnight-market-4', 'velvet-static-4'),
    'velvet-static',
  ),
  playlist(
    'run',
    'Morning run',
    pick('copper-sun-1', 'copper-sun-4', 'northern-lines-1', 'low-orbit-5', 'heatwave-tapes-3'),
    'copper-sun',
  ),
  playlist(
    'focus',
    'Deep focus',
    pick('clear-water-2', 'low-orbit-1', 'paper-planets-5', 'northern-lines-4'),
    'low-orbit',
  ),
]

/** A week of plays, newest first, so Home has something to continue, jump back to and count. */
function history(now: number) {
  const plays = [
    'glass-garden-2',
    'glass-garden-1',
    'low-orbit-2',
    'paper-planets-1',
    'copper-sun-1',
    'velvet-static-1',
    'saltwater-radio-1',
    'night-bus-2',
    'low-orbit-3',
    'glass-garden-3',
    'copper-sun-4',
    'midnight-market-1',
    'heatwave-tapes-2',
    'northern-lines-1',
    'paper-planets-2',
    'glass-garden-3',
    'low-orbit-2',
    'velvet-static-4',
    'echo-valley-2',
    'clear-water-1',
  ]
  return plays.map((id, index) => {
    const song = ALL_SONGS.find((item) => item.id === id)!
    return {
      id: song.id,
      title: song.title,
      artist: song.artist,
      album: song.album,
      duration: song.duration,
      artistId: song.artistId,
      albumId: song.albumId,
      coverArt: song.coverArt,
      playedAt: now - 1000 * 60 * (12 + index * 410),
    }
  })
}

/** Catalog results that point their art at the drawn covers, for the Search screens. */
const catalogAlbums: MusicResult[] = [
  musicResult(42, {
    title: 'Glass Garden',
    artist: 'Mira Vale',
    art: '/api/player/art/glass-garden',
    year: 2025,
    track_count: 6,
    ownership: 'owned',
    owned_count: 6,
    matched_paths: ['/music/Mira Vale/Glass Garden'],
  }),
  musicResult(43, {
    title: 'Hothouse (Deluxe)',
    artist: 'Mira Vale',
    art: '/api/player/art/heatwave-tapes',
    year: 2026,
    track_count: 14,
    owned_count: 6,
    ownership: 'edition',
  }),
  musicResult(44, {
    title: 'Undertow EP',
    artist: 'Mira Vale',
    art: '/api/player/art/saltwater-radio',
    year: 2022,
    track_count: 4,
    record_type: 'ep',
  }),
  musicResult(45, {
    title: 'Paper Lanterns',
    artist: 'Mira Vale',
    art: '/api/player/art/paper-planets',
    year: 2021,
    track_count: 10,
  }),
  musicResult(46, {
    title: 'Night Garden',
    artist: 'Mira Vale',
    art: '/api/player/art/midnight-market',
    year: 2019,
    track_count: 9,
  }),
  musicResult(47, {
    title: 'Bloom Remixes',
    artist: 'Mira Vale',
    art: '/api/player/art/velvet-static',
    year: 2024,
    track_count: 7,
    record_type: 'single',
  }),
]
const catalogTracks: MusicResult[] = [
  musicResult(101, {
    kind: 'track',
    title: 'Slow Bloom',
    artist: 'Mira Vale',
    album: 'Glass Garden',
    album_id: 42,
    art: '/api/player/art/glass-garden',
    ownership: 'owned',
    duration: 232,
    popularity: 90,
  }),
  musicResult(102, {
    kind: 'track',
    title: 'Hothouse',
    artist: 'Mira Vale',
    album: 'Hothouse (Deluxe)',
    album_id: 43,
    art: '/api/player/art/heatwave-tapes',
    duration: 204,
    popularity: 80,
  }),
  musicResult(103, {
    kind: 'track',
    title: 'Undertow',
    artist: 'Mira Vale',
    album: 'Undertow EP',
    album_id: 44,
    art: '/api/player/art/saltwater-radio',
    duration: 251,
    explicit: true,
    popularity: 70,
  }),
  musicResult(104, {
    kind: 'track',
    title: 'Prism Hour',
    artist: 'Mira Vale',
    album: 'Glass Garden',
    album_id: 42,
    art: '/api/player/art/glass-garden',
    ownership: 'owned',
    duration: 219,
    popularity: 60,
  }),
  musicResult(105, {
    kind: 'track',
    title: 'Lantern Walk',
    artist: 'Mira Vale',
    album: 'Paper Lanterns',
    album_id: 45,
    art: '/api/player/art/paper-planets',
    duration: 188,
    popularity: 50,
  }),
]
const catalogArtist = musicResult(7, {
  kind: 'artist',
  title: 'Mira Vale',
  art: '/api/player/art/artist-mira-vale',
  record_type: '',
  album_id: 0,
})

export async function showcaseFixtures(page: Page, listenerId = ''): Promise<void> {
  const now = Date.now()
  await page.addInitScript(
    ([id, plays]) => {
      if (id) localStorage.setItem(`musimo.play-history.${id}`, plays)
    },
    [listenerId, JSON.stringify(history(now))] as const,
  )

  await page.route('**/api/player/art/**', (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1) ?? '')
    const cover =
      albumById.get(id)?.cover ??
      ARTIST_COVERS[id] ??
      ALBUMS[(id.length * 7) % ALBUMS.length]!.cover
    return route.fulfill({ contentType: 'image/svg+xml', body: coverSvg(cover) })
  })

  await page.route('**/api/player/queue', (route) =>
    route.fulfill(
      route.request().method() === 'GET'
        ? { json: { current: SHOWCASE_NOW.id, position: 74, entry: SHOWCASE_QUEUE } }
        : { status: 204 },
    ),
  )

  await page.route(/\/api\/library\/albums(\?.*)?$/, (route) => {
    const params = new URL(route.request().url()).searchParams
    const size = Number(params.get('size') ?? 60)
    const sort = params.get('sort')
    const list = [...ALBUMS]
    if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name))
    return route.fulfill({
      json: {
        items: list.slice(0, size).map(albumJson),
        next_offset: null,
        total: ALBUMS.length,
        genres: [...new Set(ALBUMS.map((album) => album.genre))].sort(),
        years: [...new Set(ALBUMS.map((album) => album.year))].sort(),
      },
    })
  })

  await page.route(/\/api\/library\/albums\/[^/?]+$/, (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1) ?? '')
    const album = albumById.get(id)
    if (!album) return route.fulfill({ status: 404, json: { detail: 'Not found' } })
    return route.fulfill({ json: { ...albumJson(album), song: songsOf(album) } })
  })

  await page.route(/\/api\/library\/artists(\?.*)?$/, (route) =>
    route.fulfill({ json: { items: ARTISTS, next_offset: null, total: ARTISTS.length } }),
  )

  await page.route(/\/api\/library\/artists\/[^/?]+$/, (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1) ?? '')
    const artist = ARTISTS.find((item) => item.id === id)
    if (!artist) return route.fulfill({ status: 404, json: { detail: 'Not found' } })
    const album = ALBUMS.filter((item) => item.artist === artist.name).map(albumJson)
    return route.fulfill({ json: { ...artist, album } })
  })

  await page.route(/\/api\/library\/artists\/[^/?]+\/tracks$/, (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2) ?? '')
    return route.fulfill({ json: { items: ALL_SONGS.filter((song) => song.artistId === id) } })
  })

  await page.route(
    (url) => url.pathname === '/api/library/tracks',
    (route) => {
      const size = Number(new URL(route.request().url()).searchParams.get('size') ?? 100)
      return route.fulfill({
        json: {
          items: ALL_SONGS.slice(0, size),
          next_offset: null,
          total: ALL_SONGS.length,
          genres: [...new Set(ALBUMS.map((album) => album.genre))].sort(),
          years: [...new Set(ALBUMS.map((album) => album.year))].sort(),
        },
      })
    },
  )

  await page.route(
    (url) => url.pathname === '/api/library/tracks/search',
    (route) => route.fulfill({ json: { items: ALL_SONGS.slice(0, 8) } }),
  )

  await page.route(
    (url) => url.pathname === '/api/library/playlists',
    (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ json: { items: PLAYLISTS, liked_id: 'liked' } })
        : route.fallback(),
  )

  await page.route(/\/api\/library\/playlists\/[^/?]+$/, (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1) ?? '')
    const found = PLAYLISTS.find((item) => item.id === id)
    return found
      ? route.fulfill({ json: found })
      : route.fulfill({ status: 404, json: { detail: 'Not found' } })
  })

  await page.route('**/api/player/lyrics/**', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            synced: true,
            line: [
              'Light comes in through the broken pane',
              'Every leaf a little window',
              'I could stay here till the rain',
              'Slow bloom, slow bloom',
              'Nothing here is in a hurry',
              'Slow bloom, slow bloom',
              'Let the glass hold all the worry',
            ].map((value, index) => ({ start: index * 9000, value })),
          },
        ],
      },
    }),
  )

  await page.route('**/api/search?*', (route) => {
    const kind = new URL(route.request().url()).searchParams.get('kind')
    const items =
      kind === 'track'
        ? catalogTracks
        : kind === 'album'
          ? catalogAlbums
          : kind === 'artist'
            ? [catalogArtist]
            : [...catalogTracks, ...catalogAlbums, catalogArtist]
    return route.fulfill({ json: { items, total: items.length, next_index: null, cached: false } })
  })

  await page.route('**/api/albums/*', (route) => {
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1))
    const album = catalogAlbums.find((item) => item.id === id) ?? catalogAlbums[0]!
    const tracks = ALBUMS[0]!.songs.map((title, index) =>
      musicResult(500 + index, {
        kind: 'track',
        title,
        artist: album.artist,
        album: album.title,
        album_id: album.id,
        art: album.art,
        duration: 190 + index * 11,
        position: index + 1,
        ownership: album.ownership === 'owned' ? 'owned' : index < 2 ? 'owned' : 'missing',
      }),
    )
    return route.fulfill({
      json: { album, tracks, label: 'Greenhouse Records', duration: 1388, complete: true },
    })
  })

  await page.route(/\/api\/artists\/7(\/top)?(\?.*)?$/, (route) =>
    route.fulfill(
      new URL(route.request().url()).pathname.endsWith('/top')
        ? { json: { tracks: catalogTracks } }
        : {
            json: {
              artist: { id: 7, name: 'Mira Vale', art: '/api/player/art/artist-mira-vale' },
              items: catalogAlbums,
              next_index: null,
            },
          },
    ),
  )
}

/**
 * A download queue in motion: a Hothouse album batch with one song downloading, one converting,
 * one tagging and two waiting, and two finished. Serves `/api/jobs` and the snapshot's jobs, so it
 * replaces `emptyQueue` for the Downloads screenshot.
 */
export async function showcaseQueue(page: Page): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  const job = (index: number, stage: string, over: Partial<DownloadJob> = {}): DownloadJob => {
    const title = [
      'Hothouse',
      'Fern Light',
      'Condensation',
      'Orchid Hours',
      'Humid',
      'Petal Count',
      'Glasshouse Kids',
    ][index]!
    return {
      id: `job-${index}`,
      batch_id: 'hothouse',
      batch_label: 'Hothouse (Deluxe)',
      album_id: 43,
      catalog: 'deezer',
      source: 'youtube',
      track_id: 600 + index,
      format: 'original',
      target: '/music',
      stage,
      desired: 'run',
      meta: {
        id: 600 + index,
        title,
        artist: 'Mira Vale',
        album: 'Hothouse (Deluxe)',
        art: '/api/player/art/heatwave-tapes',
        duration: 200 + index * 13,
      },
      candidates: [],
      selected: '',
      check_match: false,
      attempts: 1,
      lap: 0,
      laps: 0,
      retry_at: 0,
      progress: 0,
      downloaded: 0,
      total: 0,
      speed: 0,
      eta: null,
      error_code: '',
      error: '',
      retryable: false,
      error_hint: '',
      error_fix: '',
      tool_tail: '',
      tool_version: '',
      warnings: [],
      notes: [],
      final_path: '',
      codec: '',
      actual_bitrate: 0,
      created_at: now - 600 + index,
      updated_at: now - 10,
      hidden: false,
      ...over,
    }
  }
  const jobs = [
    job(0, 'done', {
      final_path: '/music/Mira Vale/Hothouse (Deluxe)/01 Hothouse.opus',
      codec: 'opus',
      actual_bitrate: 160,
    }),
    job(1, 'done', {
      final_path: '/music/Mira Vale/Hothouse (Deluxe)/02 Fern Light.opus',
      codec: 'opus',
      actual_bitrate: 160,
    }),
    job(2, 'downloading', {
      progress: 0.62,
      downloaded: 3_900_000,
      total: 6_300_000,
      speed: 1_400_000,
      eta: 2,
    }),
    job(3, 'converting', { progress: 0.4 }),
    job(4, 'tagging'),
    job(5, 'queued'),
    job(6, 'queued'),
  ]
  const body = {
    jobs,
    controls: { paused: false, source_paused: false },
    summary: { active: 5, failed: 0, failure_reasons: [] },
  }
  await page.route('**/api/snapshot', async (route) => {
    const live = await route.fetch()
    const snapshot: unknown = live.ok() ? await live.json() : {}
    await route.fulfill({ json: { ...(snapshot as object), ...body } })
  })

  await page.route('**/api/jobs', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: body }) : route.fallback(),
  )
}

/**
 * The isolated stack's own Diagnostics, with its music folder reported writable and a roomy disk,
 * as a working install reads. The stack mounts /music read-only, so without this every
 * screenshot would show the folder checks failing.
 */
export async function showcaseDiagnostics(page: Page): Promise<void> {
  await page.route('**/api/diagnostics', async (route) => {
    const live = await route.fetch()
    const body = (await live.json()) as { disks: { path: string }[] }
    const roomy = { free_bytes: 2_400_000_000_000, total_bytes: 4_000_000_000_000 }
    await route.fulfill({
      json: {
        ...body,
        disks: body.disks.map((disk) =>
          disk.path === '/music' ? { ...disk, ...roomy, exists: true, writable: true } : disk,
        ),
      },
    })
  })
}
