import type { Page, Route } from '@playwright/test'

import type { LibraryTrack } from '../src/api'

export const ORIGIN = 'http://127.0.0.1:18765'

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
 * The player routes every library spec needs: a ready Navidrome, an empty saved queue, and
 * real decodable audio so playback actually starts and pause states appear.
 */
export async function playerFixtures(
  page: Page,
  options: { sonicSimilarity?: boolean } = {},
): Promise<void> {
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
        extensions: options.sonicSimilarity ? ['sonicSimilarity', 'songLyrics'] : [],
        sonic_similarity: options.sonicSimilarity ?? false,
        detail: 'Navidrome is ready',
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
  await page.route('**/api/player/scrobble', (route) => route.fulfill({ status: 204 }))
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
