import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

import type { LibraryTrack } from '../src/api'
import { DEFAULT_THEME } from '../src/theme/themes'
import { librarySong, playerFixtures } from './library-fixtures'
import { emptyQueue } from './queue-fixtures'
import { searchFixtures } from './search-fixtures'
import { LIGHT_THEME, rgb, themeVars } from './theme-fixtures'

/* Every route under the light fixture theme. The theme is the opposite of the built-in one, so a
   surface that still paints a color of its own shows up as a dark patch: the computed backgrounds
   below catch the chrome, and the saved screenshots are for a person to look over. */

const first = librarySong('song-1', { title: 'First Light', duration: 180 })
const second = librarySong('song-2', { title: 'Second Tide', duration: 200, track: 2 })
const songs: LibraryTrack[] = [first, second]

const libraryAlbum = {
  id: 'album-1',
  name: 'Clear Water',
  artist: 'Harbor Static',
  artistId: 'artist-1',
  coverArt: 'cover-1',
  songCount: 2,
  duration: 380,
  year: 2026,
  genre: 'Ambient',
}

/** The library, playlists, lyrics and a restored queue, so the footer player is showing. */
async function libraryFixtures(page: Page) {
  await page.route('**/api/player/queue', (route) =>
    route.fulfill(
      route.request().method() === 'GET'
        ? { json: { current: first.id, position: 0, entry: songs } }
        : { status: 204 },
    ),
  )

  await page.route('**/api/library/albums?**', (route) =>
    route.fulfill({
      json: {
        items: [libraryAlbum],
        next_offset: null,
        total: 1,
        genres: ['Ambient'],
        years: [2026],
      },
    }),
  )

  await page.route('**/api/library/albums/album-1', (route) =>
    route.fulfill({ json: { ...libraryAlbum, song: songs } }),
  )

  await page.route('**/api/library/artists?**', (route) =>
    route.fulfill({
      json: {
        items: [{ id: 'artist-1', name: 'Harbor Static', coverArt: 'a1', albumCount: 1 }],
        next_offset: null,
        total: 1,
      },
    }),
  )

  await page.route('**/api/library/artists/artist-1', (route) =>
    route.fulfill({
      json: {
        id: 'artist-1',
        name: 'Harbor Static',
        coverArt: 'a1',
        albumCount: 1,
        album: [libraryAlbum],
      },
    }),
  )

  await page.route('**/api/library/artists/artist-1/tracks', (route) =>
    route.fulfill({ json: { items: songs } }),
  )

  await page.route(
    (url) => url.pathname === '/api/library/tracks',
    (route) =>
      route.fulfill({
        json: { items: songs, next_offset: null, total: 2, genres: ['Ambient'], years: [2026] },
      }),
  )
  const playlist = (id: string, name: string, entry: LibraryTrack[]) => ({
    id,
    name,
    songCount: entry.length,
    duration: entry.length * 180,
    public: false,
    owner: 'listener',
    changed: '2026-09-01T00:00:00Z',
    entry,
  })
  await page.route(
    (url) => url.pathname === '/api/library/playlists',
    (route) =>
      route.fulfill({
        json: {
          items: [playlist('road', 'Road trip', songs), playlist('liked', 'Liked', [])],
          liked_id: 'liked',
        },
      }),
  )

  await page.route(/\/api\/library\/playlists\/liked$/, (route) =>
    route.fulfill({ json: playlist('liked', 'Liked', []) }),
  )

  await page.route(/\/api\/library\/playlists\/road$/, (route) =>
    route.fulfill({ json: playlist('road', 'Road trip', songs) }),
  )

  await page.route(
    (url) => url.pathname === '/api/library/tracks/search',
    (route) => route.fulfill({ json: { items: songs } }),
  )

  await page.route('**/api/player/lyrics/**', (route) =>
    route.fulfill({
      json: { items: [{ line: [{ start: 0, value: 'Morning finds the water' }] }] },
    }),
  )
}

type Walk = {
  name: string
  path: string
  /** Something that only renders once the route has its data. */
  ready: (page: Page) => Locator
  /** A route with no card, panel or empty state of its own, so the card check has nothing to read. */
  cardless?: true
  /** A route that hides the footer player, because the page has its own transport. */
  playerHidden?: true
}

const ROUTES: Walk[] = [
  {
    name: 'discover',
    path: '/',
    ready: (page) => page.getByRole('heading', { level: 1, name: /Find it/ }),
    cardless: true,
  },
  {
    name: 'search',
    path: '/search?q=Fixture',
    ready: (page) => page.getByRole('link', { name: 'Harbor Lights' }).first(),
  },
  {
    name: 'search-tracks',
    cardless: true,
    path: '/search?q=Fixture&tab=track',
    ready: (page) => page.getByText('Morning Signal').first(),
  },
  {
    name: 'search-podcasts',
    path: '/search?q=Fixture&tab=podcast',
    ready: (page) => page.getByRole('link', { name: 'Tide Tables' }),
  },
  {
    name: 'podcast',
    cardless: true,
    path: '/podcasts/77',
    ready: (page) => page.getByRole('heading', { name: 'Tide Tables', level: 1 }),
  },
  {
    name: 'album',
    cardless: true,
    path: '/albums/42',
    ready: (page) => page.getByRole('heading', { name: 'Harbor Lights', level: 1 }),
  },
  {
    name: 'artist',
    path: '/artists/7',
    ready: (page) => page.getByRole('heading', { name: 'Discography' }),
  },
  {
    name: 'library',
    path: '/library',
    ready: (page) => page.getByRole('button', { name: 'Open Clear Water' }),
  },
  {
    name: 'library-albums',
    path: '/library/albums',
    ready: (page) => page.getByRole('button', { name: 'Open Clear Water' }),
  },
  {
    name: 'library-album',
    path: '/library/albums/album-1',
    ready: (page) => page.getByRole('heading', { name: 'Clear Water' }),
    cardless: true,
  },
  {
    name: 'library-artists',
    path: '/library/artists',
    ready: (page) => page.getByText('Harbor Static').first(),
  },
  {
    name: 'library-artist',
    path: '/library/artists/artist-1',
    ready: (page) => page.getByRole('heading', { name: 'Harbor Static' }),
  },
  {
    name: 'library-artist-album',
    path: '/library/artists/artist-1/albums/album-1',
    ready: (page) => page.getByRole('heading', { name: 'Clear Water' }),
    cardless: true,
  },
  {
    name: 'library-artist-songs',
    path: '/library/artists/artist-1/songs',
    ready: (page) => page.getByRole('main').getByText('Second Tide'),
    cardless: true,
  },
  {
    name: 'library-tracks',
    cardless: true,
    path: '/library/tracks',
    ready: (page) => page.getByRole('main').getByText('Second Tide'),
  },
  {
    name: 'library-playlists',
    path: '/library/playlists',
    ready: (page) => page.getByText('Road trip').first(),
    cardless: true,
  },
  {
    name: 'library-playlist',
    path: '/library/playlists/road',
    ready: (page) => page.getByRole('heading', { name: 'Road trip' }),
    cardless: true,
  },
  {
    name: 'now-playing',
    cardless: true,
    playerHidden: true,
    path: '/now-playing',
    ready: (page) => page.getByText('Morning finds the water'),
  },
  {
    name: 'downloads',
    path: '/downloads',
    ready: (page) => page.getByRole('heading', { name: 'Downloads', level: 1 }),
  },
  {
    name: 'settings',
    path: '/settings',
    ready: (page) => page.getByRole('heading', { name: 'Your library', level: 2 }),
  },
  {
    name: 'settings-user',
    path: '/settings/user',
    ready: (page) => page.getByRole('heading', { name: 'Your settings', level: 1 }),
  },
  {
    name: 'diagnostics',
    path: '/diagnostics',
    ready: (page) => page.getByRole('heading', { name: 'System readiness' }),
  },
]

/** The color a person sees behind an element: its own, or the nearest ancestor's that is not clear. */
async function backgroundOf(target: Locator): Promise<string> {
  return target.evaluate((element) => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor
      if (color !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(color)) return color
    }
    return 'transparent'
  })
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([active, custom, vars]) => {
      localStorage.setItem('musimo.theme', active)
      localStorage.setItem('musimo.custom-themes', custom)
      localStorage.setItem('musimo.theme-vars', vars)
      // Pinned so the stage looks the same headless and headed; see docs/testing.md.
      localStorage.setItem('musimo.now-playing-view', 'artwork')
    },
    [
      LIGHT_THEME.id,
      JSON.stringify({ version: 1, themes: [LIGHT_THEME] }),
      JSON.stringify(themeVars(LIGHT_THEME)),
    ] as const,
  )
  await playerFixtures(page)
  await emptyQueue(page)
  await searchFixtures(page)
  await libraryFixtures(page)
})

for (const route of ROUTES) {
  test(`${route.name} repaints under a light theme`, async ({
    page,
    browserName,
    isMobile,
  }, info) => {
    // One engine at each of the two widths: Chromium at 1280x800, the phone project at 390x844.
    test.skip(browserName !== 'chromium', 'Walked on Chromium and the phone project.')
    if (!isMobile) await page.setViewportSize({ width: 1280, height: 800 })

    await page.goto(route.path)
    await expect(route.ready(page)).toBeVisible()
    const player = page.locator('footer.live-player')
    if (route.playerHidden) await expect(player).toBeHidden()
    else await expect(player).toContainText('First Light')

    const colors = DEFAULT_THEME.colors
    const chrome = {
      body: await backgroundOf(page.locator('body')),
      nav: await backgroundOf(page.locator('.sidebar')),
      player: route.playerHidden ? undefined : await backgroundOf(player),
    }
    // The light values themselves for the chrome, not only "not the dark ones": a surface that
    // went clear would show the light canvas through and pass a weaker check. A card may sit on
    // the canvas by design (the library grid does), so it is held to not being any dark surface.
    expect(chrome.body).toBe(rgb(LIGHT_THEME.colors['--color-canvas']))
    expect(chrome.nav).toBe(rgb(LIGHT_THEME.colors['--color-sidebar']))
    if (!route.playerHidden) expect(chrome.player).toBe(rgb(LIGHT_THEME.colors['--color-raised']))

    // A card is whichever boxed surface the route has first: a music or library card, a panel.
    // Only the routes that say so have none; anywhere else a missing card is a missing surface.
    const card = page
      .locator("#main article, #main [data-ui='panel'], #main [data-ui='empty-panel']")
      .first()
    if (!route.cardless) {
      await expect(card, `${route.name} card`).toHaveCount(1)
      const background = await backgroundOf(card)
      for (const token of ['--color-canvas', '--color-raised', '--color-sunken'] as const) {
        expect(background, `${route.name} card`).not.toBe(rgb(colors[token]))
      }
    }

    const shot = info.outputPath(`${route.name}-${isMobile ? 'phone' : 'desktop'}.png`)
    await page.screenshot({ path: shot, fullPage: true })
    await info.attach(route.name, { path: shot, contentType: 'image/png' })

    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations).toEqual([])
  })
}
