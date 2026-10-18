import type { Locator, Page, Route } from '@playwright/test'

import type { LibraryTrack } from '../src/api'
import { ORIGIN } from './env'

export { ORIGIN }

/** WebKit media can bypass page routing. Opt in only for mocked, successful stream tests. */
export async function generatedPlayerAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const source = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')
    const requested = new WeakMap<HTMLMediaElement, string>()
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      configurable: true,
      get(this: HTMLMediaElement) {
        return this.hasAttribute('src')
          ? (requested.get(this) ?? String(source?.get?.call(this) ?? ''))
          : ''
      },
      set(this: HTMLMediaElement, value: string) {
        requested.set(this, new URL(value, location.href).href)
        source?.set?.call(
          this,
          value.includes('/api/player/stream/') ? '/assets/e2e-silence.wav' : value,
        )
      },
    })
  })
}

export const librarySong = (id: string, over: Partial<LibraryTrack> = {}): LibraryTrack => ({
  id,
  title: `Song ${id}`,
  artist: 'Harbor Static',
  artistId: 'artist-1',
  album: 'Clear Water',
  albumId: 'album-1',
  coverArt: 'cover-1',
  duration: 214,
  track: 1,
  playCount: 0,
  ...over,
})

/**
 * On a phone the library's sort, filter and view controls live in the Filter sheet, so a spec that
 * reaches for one opens it first. A desktop shows them in the toolbar and this does nothing.
 */
export async function openLibraryFilters(page: Page, isMobile: boolean): Promise<void> {
  if (isMobile) await page.getByRole('button', { name: /^Filter( \(\d+\))?$/ }).click()
}

/** The other half: the sheet is modal, so the page behind it waits until Done. */
export async function closeLibraryFilters(page: Page, isMobile: boolean): Promise<void> {
  if (isMobile) await page.getByRole('button', { name: 'Done', exact: true }).click()
}

/**
 * The library's sort control. A desktop toolbar has one called "Sort", the phone's Filter sheet one
 * called "Sort <view>", and only the one on screen exists.
 */
export function librarySort(page: Page, view: string): Locator {
  return page.locator(`select[aria-label="Sort ${view}"], select[aria-label="Sort"]`)
}

/**
 * Switches between library views the way a person does on that screen: a chip in the phone's row.
 * A wide Classic screen switches from the sidebar, which these specs stand in for with a
 * client-side navigation, so the player keeps playing and the view reopens with the choices it had.
 */
export async function openLibraryView(
  page: Page,
  isMobile: boolean,
  view: 'Albums' | 'Artists' | 'Tracks' | 'Playlists',
): Promise<void> {
  if (isMobile) {
    await page
      .getByRole('navigation', { name: 'Library views' })
      .getByRole('button', { name: view, exact: true })
      .click()

    return
  }
  await page.evaluate((path) => {
    history.pushState(history.state, '', path)
    dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
  }, `/library/${view.toLowerCase()}`)
}

/**
 * The "Show" filter of the artists and playlists views: a chip in the desktop toolbar, and in the
 * phone's sheet a select named for what it filters.
 */
export function libraryShow(page: Page, sheetLabel: string): Locator {
  return page.locator(`select[aria-label="${sheetLabel}"], select[aria-label="Show"]`)
}

/**
 * Opens or closes the Genre or Year picker. A desktop toolbar draws it as a chip named "Genre", and
 * the phone's sheet as a row that reads "All genres", or "Genres (1)" once one is picked.
 */
export async function toggleLibraryFacet(
  page: Page,
  isMobile: boolean,
  facet: 'Genre' | 'Year',
  picked = 0,
): Promise<void> {
  if (!isMobile) {
    await page.getByRole('button', { name: new RegExp(`^${facet}`) }).click()
    return
  }
  const plural = `${facet.toLowerCase()}s`
  await page.getByText(picked ? `${facet}s (${picked})` : `All ${plural}`, { exact: true }).click()
}

/** Read a request body as data rather than casting it to a shape it may not have. */
export function requestBody(route: Route): Record<string, unknown> {
  const body: unknown = route.request().postDataJSON()
  return body !== null && typeof body === 'object' ? { ...(body as object) } : {}
}

export function bodyText(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  return typeof value === 'string' ? value : undefined
}

export function bodyNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key]
  return typeof value === 'number' ? value : undefined
}

/**
 * The player routes every library spec needs: a ready library, an empty saved queue, and
 * real decodable audio so playback actually starts and pause states appear.
 */
export async function playerFixtures(page: Page): Promise<void> {
  await page.route('**/*', async (route) => {
    // A provider outage or remote asset must never determine a browser test result.
    if (new URL(route.request().url()).origin !== ORIGIN) await route.abort()
    else await route.fallback()
  })

  await page.route('**/api/player/capabilities', (route) =>
    route.fulfill({
      json: {
        configured: true,
        available: true,
        version: '0.63.2',
        detail: 'Playing from your music folders',
      },
    }),
  )

  await page.route('**/api/player/queue', (route) =>
    route.fulfill(
      route.request().method() === 'GET'
        ? { json: { current: '', position: 0, entry: [] } }
        : { status: 204 },
    ),
  )
  await page.route('**/api/player/queue/writer', (route) => route.fulfill({ json: { epoch: 1 } }))
  await page.route('**/api/player/scrobble', (route) => route.fulfill({ status: 204 }))
  // No waveform unless a spec brings one, so Now Playing draws its plain seek bar everywhere else.
  await page.route('**/api/player/waveform/**', (route) =>
    route.fulfill({ status: 404, json: { detail: 'No waveform' } }),
  )

  await page.route('**/api/player/stream/**', async (route) => {
    const silence = await route.fetch({ url: `${ORIGIN}/assets/e2e-silence.wav` })
    await route.fulfill({ response: silence })
  })

  await page.route('**/api/player/art/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#283d31"/></svg>',
    }),
  )
}
