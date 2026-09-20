import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import type { LibraryTrack } from '../src/api'
import { bodyText, librarySong, playerFixtures, requestBody } from './library-fixtures'

// The test stream is 30 seconds of silence whatever the song says, so the songs say the same.
const song = (id: string, title: string) => librarySong(id, { title, duration: 30 })
const alpha = song('song-a', 'Alpha')
const bravo = song('song-b', 'Bravo')
const charlie = song('song-c', 'Charlie')
const delta = song('song-d', 'Delta')

type Scrobble = { id: string; submission: boolean }

/**
 * Restores this queue with its first song loaded and not playing, answers 404 for the streams of
 * `unplayable`, and records every scrobble.
 */
async function restoreQueue(page: Page, queue: LibraryTrack[], unplayable: string[] = []) {
  const scrobbles: Scrobble[] = []
  // Pinned so the stage does not depend on the machine's WebGPU.
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
async function playToTheEnd(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('contentinfo')).toContainText('Alpha')
  await page.keyboard.press('Space')
  const active = page.locator('audio.library-audio[data-role="active"]')
  await expect
    .poll(() => active.evaluate((element: HTMLAudioElement) => !element.paused))
    .toBe(true)

  await active.evaluate((element: HTMLAudioElement) => {
    element.currentTime = 27
  })
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
  await page.addInitScript(() => {
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
  })
  await restoreQueue(page, [alpha, bravo, charlie])
  await playToTheEnd(page)
  await expect(page.locator('audio.library-audio[data-role="standby"]')).toHaveAttribute(
    'src',
    /song-b/,
  )
  const now = await page.evaluate(() => Date.now())
  await page.clock.pauseAt(now + 1000)

  const log = () => page.evaluate(() => (window as unknown as { audioLog: string[] }).audioLog)
  await expect
    .poll(async () => (await log()).includes('ended:song-a'), { timeout: 15_000 })
    .toBe(true)

  // Bravo started while Alpha was still playing, so it was the worker that did it, not `ended`.
  const events = await log()
  expect(events).toContain('play:song-b')
  expect(events.indexOf('play:song-b')).toBeLessThan(events.indexOf('ended:song-a'))
})

test('both library elements feed the analyser, so the visualizer survives a handover', async ({
  page,
}) => {
  // Headless has no WebGPU to draw with, but the audio graph is the same: count the distinct
  // elements that get a source on it. One would mean every other song plays past the analyser.
  await page.addInitScript(() => {
    const wired = new Set<HTMLMediaElement>()
    const create = AudioContext.prototype.createMediaElementSource
    AudioContext.prototype.createMediaElementSource = function (element) {
      // Only the library pair counts. The graph is built around an element of Musimo's own that
      // never plays, which is not one of them.
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

test('a song that cannot be played is skipped and the player says which', async ({ page }) => {
  await restoreQueue(page, [alpha, bravo, charlie], ['song-b'])
  await playToTheEnd(page)
  const player = page.getByRole('contentinfo')
  await expect(player.getByRole('status')).toHaveText('Skipped Bravo, it could not be played', {
    timeout: 15_000,
  })
  await expect(player).toContainText('Charlie')
})

test('three failures in a row stop the queue with a message', async ({ page }) => {
  await restoreQueue(page, [alpha, bravo, charlie, delta], ['song-a', 'song-b', 'song-c'])
  await page.goto('/')
  const player = page.getByRole('contentinfo')
  await expect(player.getByRole('status')).toHaveText(
    /^Stopped after 3 tracks in a row could not be played/,
  )
  // The fourth song was never tried.
  await expect(player).toContainText('Charlie')
  await expect(player).not.toContainText('Delta')
})
