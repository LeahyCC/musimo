import type { Page } from '@playwright/test'

import type { LibraryTrack } from '../src/api'
import { bodyText, librarySong, playerFixtures, requestBody } from './library-fixtures'
import { toasts } from './nav'
import { expect, test } from './test'

// The test stream is 30 seconds of silence whatever the song says, so the songs say the same.
const song = (id: string, title: string) => librarySong(id, { title, duration: 30 })
const alpha = song('song-a', 'Alpha')
const bravo = song('song-b', 'Bravo')
const charlie = song('song-c', 'Charlie')
const delta = song('song-d', 'Delta')
// How much sooner than the real end the hidden-tab test's songs say they end.
const EARLY_END = 5

type Scrobble = { id: string; submission: boolean }

/**
 * Restores this queue with its first song loaded and not playing, answers 404 for the streams of
 * `unplayable`, and records every scrobble.
 */
async function restoreQueue(page: Page, queue: LibraryTrack[], unplayable: string[] = []) {
  const scrobbles: Scrobble[] = []
  // Pinned so the stage does not depend on the machine's graphics.
  await page.addInitScript(() => localStorage.setItem('musimo.now-playing-view', 'artwork'))
  await playerFixtures(page)
  await page.route('**/api/player/queue', (route) =>
    route.fulfill(
      route.request().method() === 'GET'
        ? { json: { current: queue[0]?.id ?? '', position: 0, entry: queue } }
        : { status: 204 },
    ),
  )

  await page.route('**/api/player/scrobble', async (route) => {
    const body = requestBody(route)
    scrobbles.push({ id: bodyText(body, 'id') ?? '', submission: body.submission === true })
    await route.fulfill({ status: 204 })
  })
  await page.route('**/api/player/lyrics/**', (route) => route.fulfill({ json: { items: [] } }))
  for (const id of unplayable)
    await page.route(`**/api/player/stream/${id}`, (route) => route.fulfill({ status: 404 }))
  return scrobbles
}

/** Starts the restored queue and moves the playing song to its last seconds. */
async function playToTheEnd(page: Page, seconds = 27) {
  await page.goto('/')
  await expect(page.getByRole('contentinfo')).toContainText('Alpha')
  await page.keyboard.press('Space')
  const active = page.locator('audio.library-audio[data-role="active"]')
  await expect
    .poll(() => active.evaluate((element: HTMLAudioElement) => !element.paused))
    .toBe(true)

  await active.evaluate((element: HTMLAudioElement, at) => {
    element.currentTime = at
  }, seconds)
}

test('the next song loads into the standby element and takes over when the song ends', async ({
  page,
}) => {
  const scrobbles = await restoreQueue(page, [alpha, bravo, charlie])
  await playToTheEnd(page)
  const active = page.locator('audio.library-audio[data-role="active"]')
  const standby = page.locator('audio.library-audio[data-role="standby"]')

  // Loaded while Alpha still plays, then the two swap roles.
  await expect(standby).toHaveAttribute('src', /song-b/)
  await expect(active).toHaveAttribute('src', /song-b/, { timeout: 15_000 })
  await expect(page.getByRole('contentinfo')).toContainText('Bravo')
  await expect
    .poll(() => active.evaluate((element: HTMLAudioElement) => !element.paused))
    .toBe(true)

  // What follows the element is the song, not the element.
  await expect
    .poll(() => page.evaluate(() => navigator.mediaSession.metadata?.title ?? ''))
    .toBe('Bravo')
  await expect.poll(() => scrobbles).toContainEqual({ id: 'song-a', submission: true })
  await expect.poll(() => scrobbles).toContainEqual({ id: 'song-b', submission: false })
})

test('a hidden tab with slow timers starts the next song before the last one ends', async ({
  page,
  browserName,
}) => {
  // Chromium lets a worker's timers run while audio plays in a hidden tab. WebKit and Firefox hold
  // them back too, and there the `ended` event does the handover, as it did before the worker.
  test.skip(browserName !== 'chromium', 'Only Chromium keeps worker timers unthrottled.')
  // A hidden tab holds the page's timers to about one a second. The clock is installed before the
  // page loads and frozen once the song plays, which is slower still: the only timer that can run
  // is the worker's. Media events are not timers, so the audio and its events carry on.
  await page.clock.install()
  await page.addInitScript((earlyEnd) => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true })
    Object.defineProperty(document, 'hidden', { get: () => true, configurable: true })
    // What the media elements report, in order. Media events do not bubble, so this listens while
    // they travel down.
    const log: string[] = []
    Object.assign(window, { audioLog: log })
    for (const type of ['play', 'ended'])
      document.addEventListener(
        type,
        (event) => {
          const src = (event.target as HTMLAudioElement).getAttribute('src') ?? ''
          log.push(`${type}:${src.split('/').pop()}`)
        },
        true,
      )
    // The library elements say each stream is five seconds shorter than it is, and the songs say
    // the same. The player then times the handover for an end five seconds before the real one,
    // so `ended` cannot get there first however busy the machine is. Left to the real end, the
    // handover is 40 ms early, and a loaded machine lets `ended` win that race.
    const real = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'duration')?.get
    Object.defineProperty(HTMLMediaElement.prototype, 'duration', {
      configurable: true,
      get(this: HTMLMediaElement) {
        const length = real?.call(this) as number
        return this.classList.contains('library-audio') && Number.isFinite(length)
          ? length - earlyEnd
          : length
      },
    })
  }, EARLY_END)
  const early = (track: LibraryTrack) => ({ ...track, duration: 30 - EARLY_END })
  await restoreQueue(page, [alpha, bravo, charlie].map(early))
  await playToTheEnd(page, 27 - EARLY_END)
  await expect(page.locator('audio.library-audio[data-role="standby"]')).toHaveAttribute(
    'src',
    /song-b/,
  )
  const now = await page.evaluate(() => Date.now())
  await page.clock.pauseAt(now + 1000)

  const log = () => page.evaluate(() => (window as unknown as { audioLog: string[] }).audioLog)
  await expect
    .poll(async () => (await log()).includes('play:song-b'), { timeout: 15_000 })
    .toBe(true)

  // Bravo started while Alpha was still playing, so it was the worker that did it, not `ended`.
  expect(await log()).not.toContain('ended:song-a')
})

test('both library elements feed the analyser, so the visualizer survives a handover', async ({
  page,
}) => {
  // The picture is not checked here, only the audio graph: count the distinct elements that get a
  // source on it. One would mean every other song plays past the analyser.
  await page.addInitScript(() => {
    const wired = new Set<HTMLMediaElement>()
    const create = AudioContext.prototype.createMediaElementSource
    AudioContext.prototype.createMediaElementSource = function (element) {
      // Only the library pair counts.
      if (element.classList.contains('library-audio')) wired.add(element)
      document.documentElement.dataset.wired = String(wired.size)
      return create.call(this, element)
    }
  })
  await restoreQueue(page, [alpha, bravo])
  await playToTheEnd(page)
  await expect(page.getByRole('contentinfo')).toContainText('Bravo', { timeout: 15_000 })
  await expect(page.locator('html')).toHaveAttribute('data-wired', '2')
})

test('a quiet track is boosted the same on both library elements', async ({ page }) => {
  // +6 dB is about twice as loud, and a peak of 0.3 leaves room for it. At full volume the
  // element cannot go past 1, so the rest has to come from that element's gain stage, and both
  // elements must have one or every other track would miss it.
  const quiet = (id: string, title: string) =>
    librarySong(id, {
      title,
      duration: 30,
      replayGain: { trackGain: 6, trackPeak: 0.3 },
    })
  await page.addInitScript(() => {
    localStorage.setItem('musimo.player-volume', '1')
    const boosts = new Map<HTMLMediaElement, GainNode>()
    const source = AudioContext.prototype.createMediaElementSource
    AudioContext.prototype.createMediaElementSource = function (element) {
      const node = source.call(this, element)
      const connect = node.connect.bind(node)
      node.connect = ((target: AudioNode) => {
        if (target instanceof GainNode) boosts.set(element, target)
        return connect(target)
      }) as typeof node.connect

      return node
    }

    // Read back by the test: the gain on whichever library element is playing.
    Object.assign(window, {
      playingBoost: () => {
        const active = document.querySelector<HTMLAudioElement>(
          'audio.library-audio[data-role="active"]',
        )
        return active ? (boosts.get(active)?.gain.value ?? 0) : 0
      },
    })
  })
  await restoreQueue(page, [quiet('song-a', 'Alpha'), quiet('song-b', 'Bravo')])
  await playToTheEnd(page)
  const boost = () =>
    page.evaluate(() => (window as unknown as { playingBoost: () => number }).playingBoost())

  await expect.poll(boost).toBeCloseTo(10 ** (6 / 20), 1)
  await expect(page.getByRole('contentinfo')).toContainText('Bravo', { timeout: 15_000 })
  await expect.poll(boost).toBeCloseTo(10 ** (6 / 20), 1)
})

/** The stream ids fetched by the prefetcher, as opposed to the audio elements. */
function prefetchedStreams(page: Page) {
  const ids: string[] = []
  page.on('request', (request) => {
    const match = /\/api\/player\/stream\/([^/?]+)/.exec(request.url())
    if (match?.[1] && request.resourceType() === 'fetch') ids.push(match[1])
  })

  return ids
}

test('the next two songs are fetched ahead, long before the standby element loads', async ({
  page,
}) => {
  await restoreQueue(page, [alpha, bravo, charlie, delta])
  const prefetched = prefetchedStreams(page)
  // Past the prefetch delay, and well before the last 15 seconds when the standby element loads.
  await playToTheEnd(page, 6)
  await expect.poll(() => prefetched).toEqual(['song-b', 'song-c'])
  const standby = page.locator('audio.library-audio[data-role="standby"]')
  await expect(standby).not.toHaveAttribute('src', /song-b/)
})

test('a metered connection fetches nothing ahead', async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'connection', {
      value: { saveData: true },
      configurable: true,
    }),
  )
  await restoreQueue(page, [alpha, bravo, charlie])
  const prefetched = prefetchedStreams(page)
  await playToTheEnd(page)
  const standby = page.locator('audio.library-audio[data-role="standby"]')
  await expect(standby).toHaveAttribute('src', /song-b/)
  expect(prefetched).toEqual([])
})

test('a metered connection preloads the metadata only', async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'connection', {
      value: { saveData: true },
      configurable: true,
    }),
  )
  await restoreQueue(page, [alpha, bravo])
  await playToTheEnd(page)
  const standby = page.locator('audio.library-audio[data-role="standby"]')
  await expect(standby).toHaveAttribute('src', /song-b/)
  await expect
    .poll(() => standby.evaluate((element: HTMLAudioElement) => element.preload))
    .toBe('metadata')
})

/** Makes the playing element report a dropped connection, as a busy or restarting server would. */
async function dropConnection(page: Page) {
  await page.locator('audio.library-audio[data-role="active"]').evaluate((element) => {
    Object.defineProperty(element, 'error', {
      configurable: true,
      get: () => ({ code: MediaError.MEDIA_ERR_NETWORK }),
    })
    element.dispatchEvent(new Event('error'))
    // The reload replaces the error, as a real one would.
    setTimeout(() => Reflect.deleteProperty(element, 'error'), 0)
  })
}

test('a dropped connection reloads the song where it stopped instead of skipping it', async ({
  page,
}) => {
  await restoreQueue(page, [alpha, bravo])
  const streams: string[] = []
  page.on('request', (request) => {
    if (request.resourceType() === 'media' && request.url().includes('song-a')) {
      streams.push(request.url())
    }
  })
  await playToTheEnd(page, 10)
  const active = page.locator('audio.library-audio[data-role="active"]')
  const before = streams.length
  await dropConnection(page)
  await expect.poll(() => streams.length).toBeGreaterThan(before)
  await expect
    .poll(() => active.evaluate((element: HTMLAudioElement) => !element.paused))
    .toBe(true)
  await expect(page.getByRole('contentinfo')).toContainText('Alpha')
  expect(await active.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(
    9,
  )
  await expect(toasts(page)).not.toContainText('Skipped')
})

test('a song that cannot be played is skipped and the player says which', async ({ page }) => {
  await restoreQueue(page, [alpha, bravo, charlie], ['song-b'])
  await playToTheEnd(page)
  const player = page.getByRole('contentinfo')
  await expect(toasts(page)).toHaveText('Skipped Bravo, it could not be played', {
    timeout: 15_000,
  })
  await expect(player).toContainText('Charlie')
})

test('three failures in a row stop the queue with a message', async ({ page }) => {
  await restoreQueue(page, [alpha, bravo, charlie, delta], ['song-a', 'song-b', 'song-c'])
  await page.goto('/')
  const player = page.getByRole('contentinfo')
  await expect(
    toasts(page).getByText(/^Stopped after 3 tracks in a row could not be played/),
  ).toBeVisible()
  // The fourth song was never tried.
  await expect(player).toContainText('Charlie')
  await expect(player).not.toContainText('Delta')
})
