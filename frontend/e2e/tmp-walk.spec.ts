import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import type { DownloadJob, MusicResult } from '../src/api'
import { ORIGIN } from './env'
import { librarySong, playerFixtures } from './library-fixtures'
import { emptyQueue } from './queue-fixtures'

const OUT = process.env.WALK_OUT ?? join(process.env.TEMP ?? '.', 'musimo-walk')

type Finding = { screen: string; overflow: string[]; console: string[]; pageScrollX: number }
const findings: Finding[] = []
let consoleErrors: string[] = []

test.beforeEach(async ({ page, isMobile }) => {
  if (!isMobile) await page.setViewportSize({ width: 1280, height: 800 })
  consoleErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
})

test.afterAll(() => {
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, `findings-${test.info().project.name}.json`), JSON.stringify(findings, null, 2))
})

async function shot(page: Page, name: string, options: { full?: boolean } = {}) {
  const project = test.info().project.name
  const dir = join(OUT, project)
  mkdirSync(dir, { recursive: true })
  await page.waitForTimeout(400)
  const probe = await page.evaluate(() => {
    const width = document.documentElement.clientWidth
    const out: string[] = []
    const describe = (element: Element) => {
      const id = element.id ? `#${element.id}` : ''
      const cls = element.className && typeof element.className === 'string'
        ? `.${element.className.trim().split(/\s+/).slice(0, 3).join('.')}`
        : ''
      const text = (element.textContent ?? '').trim().slice(0, 40)
      return `${element.tagName.toLowerCase()}${id}${cls} "${text}"`
    }

    for (const element of document.querySelectorAll('body *')) {
      if (!(element instanceof HTMLElement)) continue
      const style = getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      const box = element.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) continue
      // Off-viewport right edge on a non-fixed, in-flow element.
      if (box.right > width + 1 && style.position !== 'fixed' && element.closest('dialog') === null)
        out.push(`right-edge ${Math.round(box.right - width)}px past viewport: ${describe(element)}`)
      // Text wider than its box, without an overflow container or ellipsis to explain it.
      const overflowX = style.overflowX
      if (
        element.scrollWidth > element.clientWidth + 2 &&
        element.clientWidth > 0 &&
        (overflowX === 'visible' || overflowX === 'hidden') &&
        style.textOverflow !== 'ellipsis' &&
        !element.querySelector('[style*="overflow"]') &&
        element.tagName !== 'INPUT' &&
        element.tagName !== 'TEXTAREA' &&
        element.tagName !== 'SELECT'
      )
        out.push(`content ${element.scrollWidth - element.clientWidth}px wider than box: ${describe(element)}`)
    }
    return { out: out.slice(0, 40), scrollX: document.documentElement.scrollWidth - width }
  })
  findings.push({ screen: name, overflow: probe.out, console: [...consoleErrors], pageScrollX: probe.scrollX })
  consoleErrors = []
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: options.full ?? true })
}

// ---------- catalog fixtures ----------
const base: MusicResult = {
  id: 101,
  kind: 'track',
  title: 'Recording 1',
  artist: 'Fixture artist',
  artist_id: 7,
  album: 'Fixture album',
  album_id: 42,
  art: '',
  duration: 180,
  year: 2020,
  explicit: false,
  preview: '',
  isrc: '',
  popularity: 1,
  track_count: 12,
  record_type: 'album',
  ownership: 'missing',
  matched_paths: [],
  matched_by: '',
  matched_album: '',
  owned_count: 0,
  coverage_verified: true,
  disc: 1,
  position: 1,
}
const LONG = 'An Unreasonably Long Title That Keeps Going Well Past Any Sensible Width (Deluxe Remastered Anniversary Edition)'
const tracks: MusicResult[] = Array.from({ length: 12 }, (_, i) => ({
  ...base,
  id: 101 + i,
  title: i === 1 ? LONG : i === 2 ? 'Short' : `Recording ${i + 1}`,
  artist: i === 3 ? 'Fixture artist featuring Another Very Long Collaborator Name and Friends' : base.artist,
  position: i + 1,
  duration: 120 + i * 37,
  explicit: i % 4 === 0,
  ownership: i === 0 ? 'owned' : i === 4 ? 'partial' : 'missing',
  preview: i < 6 ? 'preview' : '',
  popularity: 100 - i,
}))
const albums: MusicResult[] = Array.from({ length: 8 }, (_, i) => ({
  ...base,
  id: 42 + i,
  kind: 'album',
  title: i === 1 ? LONG : `Fixture album ${i + 1}`,
  album: i === 1 ? LONG : `Fixture album ${i + 1}`,
  album_id: 42 + i,
  year: 2020 - i,
  record_type: i === 2 ? 'ep' : i === 3 ? 'single' : 'album',
  ownership: i === 0 ? 'partial' : i === 5 ? 'owned' : 'missing',
  owned_count: i === 0 ? 5 : i === 5 ? 12 : 0,
  coverage_verified: i !== 6,
  track_count: 12,
}))
const artists: MusicResult[] = Array.from({ length: 5 }, (_, i) => ({
  ...base,
  id: 7 + i,
  kind: 'artist',
  title: i === 1 ? 'The Extraordinarily Long Named Orchestra of Somewhere Far Away' : `Fixture artist ${i + 1}`,
  artist_id: 7 + i,
}))

async function catalogFixtures(page: Page) {
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== ORIGIN) await route.abort()
    else await route.fallback()
  })
  await emptyQueue(page)
  await page.route('**/api/search?*', (route) => {
    const url = new URL(route.request().url())
    const kind = url.searchParams.get('kind')
    const q = url.searchParams.get('q') ?? ''
    if (q === 'zzz') return route.fulfill({ json: { items: [], total: 0, next_index: null, cached: false } })
    if (q === 'boom') return route.fulfill({ status: 503, json: { detail: 'Catalog unavailable: upstream timed out' } })
    const items = kind === 'album' ? albums : kind === 'artist' ? artists : tracks
    return route.fulfill({ json: { items, total: items.length, next_index: null, cached: false } })
  })

  await page.route('**/api/album-years?*', (route) =>
    route.fulfill({ json: Object.fromEntries(albums.map((album) => [String(album.id), album.year])) }),
  )

  await page.route(/\/api\/albums\/(\d+)/, (route) => {
    const id = Number(new URL(route.request().url()).pathname.split('/').pop())
    const album = albums.find((item) => item.id === id) ?? { ...albums[0], id, album_id: id }
    return route.fulfill({
      json: {
        album,
        tracks: tracks.map((track) => ({ ...track, album_id: id, album: album.title })),
        label: 'Fixture label · 2020 Fixture Records',
        duration: tracks.reduce((sum, track) => sum + track.duration, 0),
        complete: true,
      },
    })
  })

  await page.route(/\/api\/artists\/7(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { artist: { id: 7, name: 'Fixture artist', art: '' }, items: albums, next_index: null } }),
  )
  await page.route('**/api/artists/7/top', (route) => route.fulfill({ json: { tracks: tracks.slice(0, 5) } }))
  await page.route('**/api/artists/7/download-plan*', (route) =>
    route.fulfill({
      json: {
        albums: albums.map((album, i) => ({
          id: album.id,
          title: album.title,
          art: '',
          year: String(album.year),
          error: i === 6 ? 'Lookup failed' : '',
          tracks: Array.from({ length: 3 }, (_, t) => ({ id: album.id * 10 + t, duration: 180, owned: t === 0 && i === 0, identity: `isrc:${album.id}-${t}` })),
        })),
      },
    }),
  )
  await page.route('**/api/preview/*', (route) => route.fulfill({ json: { url: `${ORIGIN}/assets/e2e-silence.wav`, source: 'fixture' } }))
}

// ---------- download fixtures ----------
const failedBase: DownloadJob = {
  id: 'failed-job',
  batch_id: 'album-batch',
  batch_label: 'Fixture album',
  album_id: 42,
  track_id: 101,
  format: 'original',
  target: '/music',
  stage: 'failed',
  desired: 'run',
  meta: { id: 101, title: 'Recording 1', artist: 'Fixture artist', album: 'Fixture album', art: '', duration: 180 },
  candidates: [],
  selected: '',
  check_match: false,
  attempts: 1,
  retry_at: 0,
  progress: 0,
  downloaded: 0,
  total: 0,
  speed: 0,
  eta: null,
  error_code: 'NO_MATCH',
  error: 'No sufficiently close recording found',
  retryable: false,
  error_hint: 'No matching recording was found on YouTube.',
  error_fix: 'card:pick',
  tool_tail: '',
  tool_version: '',
  warnings: [],
  final_path: '',
  codec: '',
  actual_bitrate: 0,
  created_at: 1,
  updated_at: 1,
  hidden: false,
}
const job = (index: number, over: Partial<DownloadJob>): DownloadJob => ({
  ...failedBase,
  id: `job-${index}`,
  track_id: 200 + index,
  meta: { ...failedBase.meta, id: 200 + index, title: index === 2 ? LONG : `Recording ${index}` },
  created_at: index,
  updated_at: index,
  ...over,
})
const queueJobs: DownloadJob[] = [
  job(0, { stage: 'downloading', progress: 0.42, downloaded: 4_200_000, total: 10_000_000, speed: 850_000, eta: 7, error_code: '', error: '', error_hint: '', error_fix: '', tool_version: 'yt-dlp 2026.08.01' }),
  job(1, { stage: 'converting', progress: 1, downloaded: 10_000_000, total: 10_000_000, error_code: '', error: '', error_hint: '', error_fix: '' }),
  job(2, { stage: 'queued', error_code: '', error: '', error_hint: '', error_fix: '', batch_id: '', batch_label: '' }),
  job(3, { stage: 'queued', error_code: '', error: '', error_hint: '', error_fix: '', retry_at: Date.now() / 1000 + 90, attempts: 2 }),
  job(4, { stage: 'paused', desired: 'pause', error_code: '', error: '', error_hint: '', error_fix: '' }),
]
const doneJobs: DownloadJob[] = [
  job(5, { stage: 'done', error_code: '', error: '', error_hint: '', error_fix: '', codec: 'opus', actual_bitrate: 161000, final_path: '/music/Fixture artist/Fixture album/Recording 5.opus', warnings: ['Navidrome scan delayed', 'Artwork fallback used'] }),
  job(6, { stage: 'done', error_code: '', error: '', error_hint: '', error_fix: '', codec: 'mp3', actual_bitrate: 320000, final_path: '/music/Fixture artist/Fixture album/Recording 6.mp3', batch_id: '', batch_label: '' }),
  job(7, { stage: 'cancelled', error_code: '', error: '', error_hint: '', error_fix: '' }),
]
const failedJobs: DownloadJob[] = [
  job(8, { attempts: 3, candidates: Array.from({ length: 3 }, (_, pick) => ({ id: `cand-${pick}`, title: `Candidate ${pick} with a fairly long title for the picker`, artist: 'Fixture artist', duration: 180 + pick, score: 0.4 + pick / 10, topic: pick === 0, reason: 'duration close' })), tool_tail: Array.from({ length: 8 }, (_, line) => `[youtube] line ${line}: some log output that is fairly long and wraps`).join('\n') }),
  job(9, { error_code: 'DEST_UNWRITABLE', error: 'Destination is missing or read-only', error_hint: 'The destination folder is missing or not writable.', error_fix: 'settings:destination', retryable: true }),
  job(10, { batch_id: '', batch_label: '', error_code: 'SOURCE_BLOCKED', error: 'YouTube blocked the request', error_hint: 'YouTube is blocking downloads from this address.', error_fix: 'diagnostics:youtube', retryable: true, attempts: 4 }),
  job(11, { batch_id: 'album-batch-2', batch_label: LONG, error_code: 'FFMPEG', error: 'ffmpeg exited with status 1', error_hint: '', error_fix: '', retryable: true }),
]

async function downloadFixtures(page: Page, options: { sourcePaused?: boolean; paused?: boolean; jobs?: DownloadJob[] } = {}) {
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== ORIGIN) await route.abort()
    else await route.fallback()
  })
  const jobs = options.jobs ?? [...queueJobs, ...doneJobs, ...failedJobs]
  const controls = { paused: options.paused ?? false, source_paused: options.sourcePaused ?? false }
  const failed = jobs.filter((item) => item.stage === 'failed')
  const reasons = new Map<string, { code: string; message: string; count: number; hint?: string; fix?: string }>()
  for (const item of failed) {
    const reason = reasons.get(item.error_code) ?? { code: item.error_code, message: item.error, count: 0, hint: item.error_hint, fix: item.error_fix }
    reason.count += 1
    reasons.set(item.error_code, reason)
  }
  const summary = { active: jobs.filter((item) => ['queued', 'downloading', 'converting', 'paused'].includes(item.stage)).length, failed: failed.length, failure_reasons: [...reasons.values()] }
  await page.route('**/api/snapshot', async (route) => {
    const live = await route.fetch()
    const body: unknown = await live.json()
    const snapshot = body !== null && typeof body === 'object' ? { ...(body as object) } : {}
    await route.fulfill({ json: { ...snapshot, jobs, controls, summary } })
  })

  await page.route('**/api/jobs*', (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({ json: { jobs, controls, summary } })
  })
  await page.route('**/api/history?*', (route) => route.fulfill({ json: { jobs: [...doneJobs, ...failedJobs], total: 7 } }))
  await page.route(/\/api\/albums\/(\d+)/, (route) =>
    route.fulfill({ json: { album: albums[0], tracks, label: 'Fixture label', duration: 1800, complete: true } }),
  )
}

// ---------- library fixtures ----------
const library = [
  librarySong('s1', { title: 'Beacon', genre: 'Jazz', year: 1999, playCount: 12 }),
  librarySong('s2', { title: LONG, genre: 'Rock', year: 2011, playCount: 4, artist: 'Harbor Static and the Long Named Ensemble' }),
  librarySong('s3', { title: 'Cinder', genre: 'Jazz', year: 2011, playCount: 30 }),
  librarySong('s4', { title: 'Driftwood', genre: 'Ambient', year: 2020, playCount: 0, album: 'Stone Lines', albumId: 'album-2', coverArt: 'cover-2' }),
]
const libraryAlbums = [
  { id: 'album-1', name: 'Clear Water', artist: 'Harbor Static', artistId: 'artist-1', coverArt: 'cover-1', songCount: 3, duration: 642, genre: 'Jazz', year: 2011, playCount: 46 },
  { id: 'album-2', name: LONG, artist: 'Harbor Static and the Long Named Ensemble', artistId: 'artist-1', coverArt: 'cover-2', songCount: 1, duration: 214, genre: 'Ambient', year: 2020, playCount: 0 },
  { id: 'album-3', name: 'Stone Lines', artist: 'Other Artist', artistId: 'artist-2', songCount: 9, duration: 2000, genre: 'Rock', year: 1999, playCount: 4 },
  { id: 'album-4', name: 'Fourth', artist: 'Other Artist', artistId: 'artist-2', coverArt: 'cover-4', songCount: 2, duration: 300, genre: 'Rock', year: 2005, playCount: 1 },
  { id: 'album-5', name: 'Fifth Album', artist: 'Harbor Static', artistId: 'artist-1', coverArt: 'cover-5', songCount: 5, duration: 900, genre: 'Jazz', year: 2015, playCount: 8 },
]
const libraryArtists = [
  { id: 'artist-1', name: 'Harbor Static', coverArt: 'artist-cover-1', albumCount: 3 },
  { id: 'artist-2', name: 'Other Artist With A Considerably Longer Name Than Usual', albumCount: 2 },
  { id: 'artist-3', name: 'Third', coverArt: 'artist-cover-3', albumCount: 1 },
]

async function libraryFixtures(page: Page, options: { empty?: boolean; configured?: boolean; available?: boolean } = {}) {
  await playerFixtures(page, { sonicSimilarity: true })
  await emptyQueue(page)
  if (options.configured === false || options.available === false) {
    await page.route('**/api/player/capabilities', (route) =>
      route.fulfill({
        json: { configured: options.configured !== false, available: false, version: '', extensions: [], sonic_similarity: false, detail: options.configured === false ? 'Navidrome is not configured' : 'Navidrome returned 502 Bad Gateway' },
      }),
    )
  }
  const items = <T,>(list: T[]) => (options.empty ? [] : list)
  await page.route('**/api/library/albums?**', (route) => route.fulfill({ json: { items: items(libraryAlbums), next_offset: null } }))
  await page.route('**/api/library/artists?**', (route) => route.fulfill({ json: { items: items(libraryArtists), next_offset: null } }))
  await page.route((url) => url.pathname === '/api/library/tracks', (route) => {
    const url = new URL(route.request().url())
    const genres = url.searchParams.getAll('genre')
    const list = genres.length ? library.filter((item) => genres.includes(item.genre ?? '')) : library
    return route.fulfill({ json: { items: items(list), next_offset: null, total: items(list).length, genres: ['Jazz', 'Rock', 'Ambient'], years: [2020, 2011, 1999] } })
  })
  await page.route((url) => url.pathname === '/api/library/tracks/selection', (route) => route.fulfill({ json: { items: library, total: library.length } }))
  await page.route((url) => url.pathname === '/api/library/tracks/search', (route) => route.fulfill({ json: { items: library } }))
  const playlists = [
    { id: 'liked', name: 'Liked', songCount: 2, duration: 400, public: false, owner: 'listener', changed: '2026-09-01T00:00:00Z' },
    { id: 'road', name: 'Road trip', songCount: 1, duration: 214, public: true, owner: 'listener', changed: '2026-09-03T00:00:00Z' },
    { id: 'long', name: LONG, songCount: 40, duration: 8000, public: true, owner: 'listener', changed: '2026-09-05T00:00:00Z' },
  ]
  await page.route((url) => url.pathname === '/api/library/playlists', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { items: items(playlists), liked_id: 'liked' } })
      : route.fulfill({ json: { ...playlists[1], id: 'new', name: 'New playlist', entry: [] } }),
  )

  await page.route(/\/api\/library\/playlists\/(liked|road|long)$/, (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop() ?? ''
    const playlist = playlists.find((item) => item.id === id)
    return route.fulfill({ json: { ...playlist, entry: id === 'liked' ? library.slice(0, 2) : id === 'road' ? [library[1]] : library } })
  })
  await page.route(/\/api\/library\/playlists\/(liked|road|long)\/songs$/, (route) => route.fulfill({ json: { ...playlists[1], entry: [library[1], library[0]] } }))
  await page.route(/\/api\/library\/albums\/album-\d$/, (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop() ?? ''
    const album = libraryAlbums.find((item) => item.id === id) ?? libraryAlbums[0]
    return route.fulfill({ json: { ...album, song: library.filter((item) => item.albumId === id).length ? library.filter((item) => item.albumId === id) : library } })
  })

  await page.route(/\/api\/library\/artists\/artist-\d$/, (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop() ?? ''
    const artist = libraryArtists.find((item) => item.id === id) ?? libraryArtists[0]
    return route.fulfill({ json: { ...artist, album: libraryAlbums.filter((item) => item.artistId === id) } })
  })
  await page.route(/\/api\/library\/artists\/artist-\d\/tracks$/, (route) => route.fulfill({ json: { items: library } }))
  await page.route('**/api/player/lyrics/*', (route) =>
    route.fulfill({ json: { items: [{ synced: true, line: [{ start: 0, value: 'Morning finds the water' }, { start: 4000, value: 'Light on the harbour wall' }, { start: 9000, value: 'Static in the tide' }] }] } }),
  )

  await page.route('**/api/player/radio/*', (route) =>
    route.fulfill({ json: { items: library.slice(1).map((entry, i) => ({ entry, similarity: 0.9 - i / 10 })) } }),
  )
}

// =============== screens ===============

test('home and search', async ({ page }) => {
  await catalogFixtures(page)
  await page.goto('/')
  await expect(page.locator('#main')).toBeVisible()
  await shot(page, '01-home')

  await page.goto('/search?q=fixture')
  await expect(page.getByText('Recording 1', { exact: true }).first()).toBeVisible()
  await shot(page, '02-search-top')
  for (const tab of ['Tracks', 'Albums', 'Artists']) {
    await page.getByRole('button', { name: tab, exact: true }).first().click()
    await page.waitForTimeout(300)
    await shot(page, `03-search-${tab.toLowerCase()}`)
  }
  await page.goto('/search?q=zzz')
  await page.waitForTimeout(500)
  await shot(page, '04-search-empty')
  await page.goto('/search?q=boom')
  await page.waitForTimeout(500)
  await shot(page, '05-search-error')
})

test('search loading', async ({ page }) => {
  await catalogFixtures(page)
  await page.route('**/api/search?*', () => new Promise(() => undefined))
  await page.goto('/search?q=slow')
  await page.waitForTimeout(800)
  await shot(page, '06-search-loading')
})

test('album and artist pages', async ({ page }) => {
  await catalogFixtures(page)
  await page.goto('/albums/42?track=103')
  await expect(page.getByText('Short', { exact: true })).toBeVisible()
  await shot(page, '10-album-highlight')
  // Preview playing from album
  await page.getByRole('button', { name: /Play preview|Preview/ }).first().click().catch(() => undefined)
  await page.waitForTimeout(600)
  await shot(page, '11-album-preview-playing')

  await page.goto('/artists/7')
  await expect(page.getByRole('heading', { name: 'Fixture artist' }).first()).toBeVisible()
  await page.waitForTimeout(500)
  await shot(page, '12-artist')
  await page.getByRole('button', { name: 'Download all albums' }).click()
  await expect(page.getByRole('dialog', { name: 'Choose albums to download' })).toBeVisible()
  await page.waitForTimeout(400)
  await shot(page, '13-artist-download-sheet', { full: false })
  await page.getByRole('button', { name: 'Close download selection' }).click()
  await page.getByRole('button', { name: 'Download all music' }).click()
  await expect(page.getByRole('dialog', { name: 'Choose music to download' })).toBeVisible()
  await page.waitForTimeout(400)
  await shot(page, '13b-artist-download-sheet-music', { full: false })
})

test('album loading and missing', async ({ page }) => {
  await catalogFixtures(page)
  await page.route(/\/api\/albums\/999/, () => new Promise(() => undefined))
  await page.goto('/albums/999')
  await page.waitForTimeout(600)
  await shot(page, '14-album-loading')
  await page.route(/\/api\/albums\/998/, (route) => route.fulfill({ status: 404, json: { detail: 'Album not found' } }))
  await page.goto('/albums/998')
  await page.waitForTimeout(600)
  await shot(page, '15-album-error')
  await page.goto('/nowhere')
  await page.waitForTimeout(300)
  await shot(page, '16-not-found')
})

test('library screens', async ({ page }) => {
  await libraryFixtures(page)
  await page.goto('/library')
  await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible()
  await page.waitForTimeout(400)
  await shot(page, '20-library-home')
  await page.getByRole('button', { name: 'List view' }).click()
  await page.waitForTimeout(300)
  await shot(page, '20b-library-home-list')
  await page.getByRole('button', { name: 'Grid view' }).click()

  await page.goto('/library/albums')
  await page.waitForTimeout(400)
  await shot(page, '21-library-albums')
  await page.goto('/library/artists')
  await page.waitForTimeout(400)
  await shot(page, '22-library-artists')
  await page.goto('/library/tracks')
  await expect(page.getByText('4 of 4 loaded')).toBeVisible()
  await shot(page, '23-library-tracks')
  await page.getByText('All genres', { exact: true }).click()
  await page.waitForTimeout(200)
  await shot(page, '23b-library-tracks-genres-open')
  await page.getByLabel('Jazz').check()
  await page.getByText('Genres (1)', { exact: true }).click()
  await page.getByText('All years', { exact: true }).click()
  await page.waitForTimeout(200)
  await shot(page, '23c-library-tracks-years-open')
  await page.keyboard.press('Escape')

  await page.goto('/library/playlists')
  await page.waitForTimeout(400)
  await shot(page, '24-library-playlists')
  await page.goto('/library/playlists/road')
  await expect(page.getByRole('heading', { name: 'Road trip' })).toBeVisible()
  await shot(page, '25-library-playlist')
  await page.getByRole('button', { name: 'Rename' }).click()
  await page.waitForTimeout(200)
  await shot(page, '25b-library-playlist-rename')
  await page.keyboard.press('Escape')
  await page.getByLabel('Search songs to add').fill('a')
  await page.waitForTimeout(400)
  await shot(page, '25c-library-playlist-add-search')

  await page.goto('/library/albums/album-1')
  await expect(page.getByRole('heading', { name: 'Clear Water' })).toBeVisible()
  await shot(page, '26-library-album')
  await page.goto('/library/albums/album-2')
  await page.waitForTimeout(400)
  await shot(page, '26b-library-album-long')

  await page.goto('/library/artists/artist-1')
  await expect(page.getByRole('heading', { name: 'Harbor Static' }).first()).toBeVisible()
  await page.waitForTimeout(400)
  await shot(page, '27-library-artist')
  await page.getByRole('button', { name: 'All songs' }).click()
  await page.waitForTimeout(400)
  await shot(page, '28-library-artist-songs')
  await page.goto('/library/artists/artist-2')
  await page.waitForTimeout(400)
  await shot(page, '27b-library-artist-long')
})

test('library empty, loading and error states', async ({ page }) => {
  await libraryFixtures(page, { empty: true })
  await page.goto('/library')
  await page.waitForTimeout(500)
  await shot(page, '30-library-empty-home')
  await page.goto('/library/tracks')
  await page.waitForTimeout(500)
  await shot(page, '30b-library-empty-tracks')
  await page.goto('/library/playlists')
  await page.waitForTimeout(500)
  await shot(page, '30c-library-empty-playlists')
  await page.goto('/library/artists')
  await page.waitForTimeout(500)
  await shot(page, '30d-library-empty-artists')
  await page.goto('/now-playing')
  await page.waitForTimeout(500)
  await shot(page, '31-now-playing-empty')
})

test('library unconfigured and unavailable', async ({ page }) => {
  await libraryFixtures(page, { configured: false })
  await page.goto('/library')
  await page.waitForTimeout(500)
  await shot(page, '32-library-unconfigured')
  await page.goto('/now-playing')
  await page.waitForTimeout(500)
  await shot(page, '32b-now-playing-unconfigured')
})

test('library unavailable', async ({ page }) => {
  await libraryFixtures(page, { available: false })
  await page.goto('/library')
  await page.waitForTimeout(500)
  await shot(page, '33-library-unavailable')
})

test('library loading', async ({ page }) => {
  await libraryFixtures(page)
  await page.route('**/api/library/albums?**', () => new Promise(() => undefined))
  await page.goto('/library')
  await page.waitForTimeout(600)
  await shot(page, '34-library-loading')
  await page.route('**/api/library/albums/album-1', () => new Promise(() => undefined))
  await page.goto('/library/albums/album-1')
  await page.waitForTimeout(600)
  await shot(page, '34b-library-album-loading')
})

test('library API error', async ({ page }) => {
  await libraryFixtures(page)
  await page.route('**/api/library/albums?**', (route) => route.fulfill({ status: 502, json: { detail: 'Navidrome returned 502 Bad Gateway' } }))
  await page.goto('/library')
  await page.waitForTimeout(9000)
  await shot(page, '35-library-error')
})

test('now playing, stage, picker and palette', async ({ page, isMobile }) => {
  await libraryFixtures(page)
  await page.goto('/library/albums/album-1')
  await page.getByRole('button', { name: 'Play all' }).click()
  await expect(page.locator('.live-player')).toContainText('Beacon')
  await page.waitForTimeout(500)
  await shot(page, '40-player-footer')
  await page.getByRole('button', { name: 'Add Beacon to a playlist' }).click()
  await expect(page.getByRole('dialog', { name: 'Add track to playlist' })).toBeVisible()
  await page.waitForTimeout(400)
  await shot(page, '41-playlist-picker', { full: false })
  const row = page.locator('.playlist-picker-row').filter({ hasText: 'Road trip' })
  await row.getByRole('button', { name: /Show songs in/ }).click()
  await page.waitForTimeout(300)
  await shot(page, '41b-playlist-picker-expanded', { full: false })
  await page.getByRole('button', { name: 'Close playlist picker' }).click()

  await page.getByRole('link', { name: 'Open Now Playing' }).click()
  await expect(page.getByRole('heading', { name: 'Beacon' })).toBeVisible()
  await page.waitForTimeout(600)
  await shot(page, '42-now-playing')
  await page.getByRole('button', { name: 'Start AudioMuse radio' }).click().catch(() => undefined)
  await page.waitForTimeout(600)
  await shot(page, '42b-now-playing-radio')
  const stage = page.locator('.stage')
  if (!isMobile) {
    await stage.hover()
    await page.waitForTimeout(300)
    await shot(page, '43-stage-hover', { full: false })
    await stage.getByRole('button', { name: 'Full screen' }).click().catch(() => undefined)
    await page.waitForTimeout(600)
    await shot(page, '44-stage-fullscreen', { full: false })
    await page.keyboard.press('Escape')
  } else {
    await stage.tap().catch(() => undefined)
    await page.waitForTimeout(300)
    await shot(page, '43-stage-tap', { full: false })
  }

  await page.goto('/library')
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
  await page.waitForTimeout(300)
  await shot(page, '45-palette', { full: false })
  await page.getByLabel('Search commands or music').fill('now')
  await page.waitForTimeout(300)
  await shot(page, '45b-palette-filtered', { full: false })
  await page.getByLabel('Search commands or music').fill('zzzzzz')
  await page.waitForTimeout(300)
  await shot(page, '45c-palette-empty', { full: false })
})

test('downloads', async ({ page }) => {
  await downloadFixtures(page)
  await page.goto('/downloads')
  await expect(page.getByRole('button', { name: 'Queue (5)', exact: true })).toBeVisible()
  await page.waitForTimeout(500)
  await shot(page, '50-downloads-queue')
  await page.getByRole('button', { name: 'Done (2)', exact: true }).click()
  await page.waitForTimeout(400)
  await shot(page, '51-downloads-done')
  await page.getByRole('button', { name: 'Failed (4)', exact: true }).click()
  await page.waitForTimeout(400)
  await shot(page, '52-downloads-failed')
  const groups = page.getByRole('group', { name: 'Failures by download group' })
  await groups.getByRole('button', { name: /Fixture album \(/ }).click()
  await page.waitForTimeout(400)
  await shot(page, '52b-downloads-failed-group')
  await page.getByRole('button', { name: 'History' }).click()
  await page.waitForTimeout(500)
  await shot(page, '53-downloads-history')

  // Queue dock and sheet
  await page.goto('/search')
  const dock = page.getByRole('button', { name: /Open queue/ })
  await expect(dock).toBeVisible()
  await shot(page, '54-queue-dock', { full: false })
  await dock.click()
  await expect(page.getByRole('dialog', { name: 'Download queue' })).toBeVisible()
  await page.waitForTimeout(400)
  await shot(page, '55-queue-sheet', { full: false })
})

test('downloads paused, source paused and empty', async ({ page }) => {
  await downloadFixtures(page, { sourcePaused: true, paused: true })
  await page.goto('/downloads')
  await page.waitForTimeout(600)
  await shot(page, '56-downloads-source-paused')
})

test('downloads empty', async ({ page }) => {
  await downloadFixtures(page, { jobs: [] })
  await page.route('**/api/history?*', (route) => route.fulfill({ json: { jobs: [], total: 0 } }))
  await page.goto('/downloads')
  await page.waitForTimeout(600)
  await shot(page, '57-downloads-empty')
  await page.getByRole('button', { name: 'Failed (0)', exact: true }).click()
  await page.waitForTimeout(300)
  await shot(page, '57b-downloads-failed-empty')
  await page.getByRole('button', { name: 'Done (0)', exact: true }).click()
  await page.waitForTimeout(300)
  await shot(page, '57c-downloads-done-empty')
  await page.getByRole('button', { name: 'History' }).click()
  await page.waitForTimeout(300)
  await shot(page, '57d-downloads-history-empty')
})

test('downloads error', async ({ page }) => {
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== ORIGIN) await route.abort()
    else await route.fallback()
  })
  await page.route('**/api/snapshot', (route) => route.fulfill({ status: 503, json: { detail: 'Snapshot unavailable' } }))
  await page.route('**/api/jobs*', (route) => route.fulfill({ status: 503, json: { detail: 'Queue database is locked' } }))
  await page.goto('/downloads')
  await page.waitForTimeout(800)
  await shot(page, '58-downloads-error')
})

test('settings and diagnostics', async ({ page }) => {
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== ORIGIN) await route.abort()
    else await route.fallback()
  })
  await emptyQueue(page)
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Settings' }).first()).toBeVisible()
  await page.waitForTimeout(800)
  await shot(page, '60-settings-clean')
  const concurrency = page.getByLabel('Parallel downloads')
  await concurrency.fill('3').catch(() => undefined)
  const template = page.getByLabel('Folder and file naming')
  await template.fill('{artist}/{year} {album}/{title}').catch(() => undefined)
  await page.waitForTimeout(600)
  await shot(page, '61-settings-dirty')

  await page.goto('/diagnostics')
  await expect(page.getByRole('heading', { name: 'Diagnostics' }).first()).toBeVisible()
  await page.waitForTimeout(800)
  await shot(page, '62-diagnostics')
})

test('settings loading and error', async ({ page }) => {
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== ORIGIN) await route.abort()
    else await route.fallback()
  })
  await page.route('**/api/settings', () => new Promise(() => undefined))
  await page.route('**/api/snapshot', () => new Promise(() => undefined))
  await page.goto('/settings')
  await page.waitForTimeout(800)
  await shot(page, '63-settings-loading')
  await page.unroute('**/api/settings')
  await page.route('**/api/settings', (route) => route.fulfill({ status: 500, json: { detail: 'Settings store unavailable' } }))
  await page.route('**/api/diagnostics', (route) => route.fulfill({ status: 500, json: { detail: 'Diagnostics failed' } }))
  await page.goto('/settings')
  await page.waitForTimeout(800)
  await shot(page, '64-settings-error')
  await page.goto('/diagnostics')
  await page.waitForTimeout(800)
  await shot(page, '65-diagnostics-error')
})

test('live updates disconnected', async ({ page }) => {
  await catalogFixtures(page)
  await page.route('**/api/events*', (route) => route.abort())
  await page.goto('/search?q=fixture')
  await page.waitForTimeout(1500)
  await shot(page, '70-live-disconnected')
  await page.unroute('**/api/events*')
  await page.route('**/api/events*', () => new Promise(() => undefined))
  await page.route('**/api/snapshot', () => new Promise(() => undefined))
  await page.goto('/search?q=fixture')
  await page.waitForTimeout(1500)
  await shot(page, '71-live-connecting')
})

test('offline', async ({ page }) => {
  await catalogFixtures(page)
  await page.route('**/api/snapshot', (route) => route.abort())
  await page.route('**/api/events*', (route) => route.abort())
  await page.goto('/search?q=fixture')
  await page.waitForTimeout(2500)
  await shot(page, '72-offline')
})
