import type { Page } from '@playwright/test'

import { libraryAlbumsSchema, type LibraryTrack } from '../src/api'
import { PREFETCH_AFTER_SECONDS } from '../src/features/player/track-prefetch'
import { bodyText, librarySong, playerFixtures, requestBody } from './library-fixtures'
import { toasts } from './nav'
import { expect, test } from './test'

// The test stream is 30 seconds of silence whatever the song says, so the songs say the same.
const song = (id: string, title: string) => librarySong(id, { title, duration: 30 })
const alpha = song('song-a', 'Alpha')
const bravo = song('song-b', 'Bravo')
const charlie = song('song-c', 'Charlie')
const delta = song('song-d', 'Delta')
// Long enough for a request started at the prefetch point to have reached the page's listener.
const NO_PREFETCH_WAIT_MS = 1500
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
async function playToTheEnd(page: Page, seconds = 27, path = '/') {
  await page.goto(path)
  // Now Playing has no footer. Its heading is the song.
  const player =
    path === '/now-playing'
      ? page.getByRole('heading', { level: 1 })
      : page.getByRole('contentinfo')
  await expect(player).toContainText('Alpha')
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

test('the prefetched start of the next song answers the element from the browser cache', async ({
  page,
  request,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Only Chromium has the DevTools protocol.')
  test.setTimeout(60_000)
  // No stream mock: a mocked response is never cached, and any route turns the cache off for the
  // whole page. The real stream route, the real local files and the real cache have to agree.
  expect((await request.post('/api/library/scan')).ok()).toBeTruthy()
  await expect
    .poll(
      async () => {
        const response = await request.get('/api/library/albums?q=Local%20Playback%20Fixture')
        return libraryAlbumsSchema.parse(await response.json()).items.length
      },
      { timeout: 30_000 },
    )
    .toBe(1)
  const response = await request.get('/api/library/albums?q=Local%20Playback%20Fixture')
  const album = libraryAlbumsSchema.parse(await response.json()).items[0]!
  // The listener fixture's route would switch the cache off. The page keeps the name it stored.
  await page.unroute('**/api/listeners')

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  const streams = new Map<string, { requestId: string; type: string }[]>()
  const servedFromCache = new Set<string>()
  cdp.on('Network.requestWillBeSent', (event) => {
    const id = /\/api\/player\/stream\/([^/?]+)/.exec(event.request.url)?.[1]
    if (id)
      streams.set(id, [
        ...(streams.get(id) ?? []),
        { requestId: event.requestId, type: event.type ?? '' },
      ])
  })
  // Chrome says "served from cache" in two ways: this event for its memory cache, and a flag on
  // the response for its disk cache. A media request is answered from the disk cache.
  cdp.on('Network.requestServedFromCache', (event) => servedFromCache.add(event.requestId))
  cdp.on('Network.responseReceived', (event) => {
    if (event.response.fromDiskCache) servedFromCache.add(event.requestId)
  })

  await page.goto(`/library/albums/${album.id}`)
  await page.getByRole('button', { name: 'Play all', exact: true }).click()
  const active = page.locator('audio.library-audio[data-role="active"]')
  const standby = page.locator('audio.library-audio[data-role="standby"]')
  await expect
    .poll(() => active.evaluate((element: HTMLAudioElement) => element.currentTime), {
      timeout: 15_000,
    })
    .toBeGreaterThan(PREFETCH_AFTER_SECONDS)

  // The prefetch is a fetch() for the second song, made while the first still plays.
  await expect
    .poll(() => [...streams.values()].flat().filter((item) => item.type === 'Fetch').length)
    .toBe(1)
  const [secondId] = [...streams.entries()].find(([, items]) => items[0]?.type === 'Fetch') ?? []
  expect(secondId).toBeTruthy()

  // Into the last 15 seconds, when the standby element loads the second song.
  await active.evaluate((element: HTMLAudioElement) => {
    element.currentTime = element.duration - 10
  })
  await expect(standby).toHaveAttribute('src', new RegExp(`/${secondId}$`))
  await expect
    .poll(() => (streams.get(secondId!) ?? []).some((item) => item.type === 'Media'))
    .toBe(true)
  const firstMedia = streams.get(secondId!)!.find((item) => item.type === 'Media')!
  await expect.poll(() => servedFromCache.has(firstMedia.requestId)).toBe(true)
})

test('the next Deezer song is prepared only in the last minute of the playing one', async ({
  page,
}) => {
  const echo = librarySong('dz-9', {
    title: 'Echo',
    duration: 30,
    origin: 'deezer',
    deezerId: 9,
  })
  await restoreQueue(page, [alpha, echo])
  // The test stream is 30 seconds long. The library elements report that plus a length set from
  // the test, so Alpha can be a long song at first and then one with under a minute left.
  await page.addInitScript(() => {
    Object.assign(window, { extraLength: 270 })
    const real = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'duration')?.get
    Object.defineProperty(HTMLMediaElement.prototype, 'duration', {
      configurable: true,
      get(this: HTMLMediaElement) {
        const length = real?.call(this) as number
        const extra = (window as unknown as { extraLength: number }).extraLength
        return this.classList.contains('library-audio') && Number.isFinite(length)
          ? length + extra
          : length
      },
    })
  })
  const prepares: string[] = []
  // Only the prepare: a POST for the song. The account's track list is asked for as well.
  await page.route('**/api/player/account/dz-9', async (route) => {
    if (route.request().method() === 'POST') prepares.push(route.request().url())
    await route.fulfill({ json: { play: 'busy', detail: 'The Deezer account is busy.' } })
  })

  await playToTheEnd(page, 6)
  const active = page.locator('audio.library-audio[data-role="active"]')
  await expect
    .poll(() => active.evaluate((element: HTMLAudioElement) => element.currentTime))
    .toBeGreaterThan(PREFETCH_AFTER_SECONDS)
  // Past the prefetch point with five minutes to go: nothing is asked of the server.
  await page.waitForTimeout(NO_PREFETCH_WAIT_MS)
  expect(prepares).toEqual([])

  // Inside the last minute the prepare goes out, once.
  await page.evaluate(() => Object.assign(window, { extraLength: 0 }))
  await expect.poll(() => prepares).toHaveLength(1)
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
  // Past the point where a prefetch would have started, and still before the standby element
  // loads at 15 seconds from the end. The delay below runs out the time an in-flight fetch needs.
  await playToTheEnd(page, 6)
  const active = page.locator('audio.library-audio[data-role="active"]')
  await expect
    .poll(() => active.evaluate((element: HTMLAudioElement) => element.currentTime))
    .toBeGreaterThan(PREFETCH_AFTER_SECONDS)
  await page.waitForTimeout(NO_PREFETCH_WAIT_MS)
  expect(prefetched).toEqual([])
  const standby = page.locator('audio.library-audio[data-role="standby"]')
  await expect(standby).not.toHaveAttribute('src', /song-b/)
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

// NETWORK_RETRY_DELAY_MS in the player: the first reload waits this long, each later one longer.
const RETRY_DELAY_MS = 1000

type MediaEntry = { type: string; src: string; time: number; paused: boolean }

/**
 * Records what the library elements report, in order, as `window.mediaLog`. Media events do not
 * bubble, so this listens while they travel down.
 */
async function logMedia(page: Page) {
  await page.addInitScript(() => {
    const log: { type: string; src: string; time: number; paused: boolean }[] = []
    Object.assign(window, { mediaLog: log })
    for (const type of ['emptied', 'loadstart', 'loadedmetadata', 'seeked', 'playing'])
      document.addEventListener(
        type,
        (event) => {
          const element = event.target
          if (!(element instanceof HTMLAudioElement)) return
          if (!element.classList.contains('library-audio')) return
          const src = (element.getAttribute('src') ?? '').split('/').pop() ?? ''
          log.push({ type, src, time: element.currentTime, paused: element.paused })
        },
        true,
      )
  })
}

/** What the library elements have reported since entry `from`. */
const mediaSince = (page: Page, from: number) =>
  page.evaluate(
    (start) => (window as unknown as { mediaLog: MediaEntry[] }).mediaLog.slice(start),
    from,
  )

const mediaCount = (page: Page) =>
  page.evaluate(() => (window as unknown as { mediaLog: MediaEntry[] }).mediaLog.length)

/**
 * Makes the playing element report a dropped connection, as a busy or restarting server would,
 * and gives back where it was. The error stays until the element starts loading again, as a real
 * one does. The test stream itself keeps playing, so only the events logged by `logMedia` show
 * whether the player really loaded it again.
 */
async function dropConnection(page: Page) {
  return page.locator('audio.library-audio[data-role="active"]').evaluate((element) => {
    Object.defineProperty(element, 'error', {
      configurable: true,
      get: () => ({ code: MediaError.MEDIA_ERR_NETWORK }),
    })

    element.addEventListener('loadstart', () => Reflect.deleteProperty(element, 'error'), {
      once: true,
    })
    element.dispatchEvent(new Event('error'))
    return (element as HTMLAudioElement).currentTime
  })
}

/**
 * Plays the restored queue from `seconds` in, and waits until the stream is really playing there.
 * `playToTheEnd` returns once play is pressed, which can be before the first metadata is in, and
 * a drop then would race the song's own first load.
 */
async function playFrom(page: Page, seconds: number, path = '/') {
  await playToTheEnd(page, seconds, path)
  await expect
    .poll(() =>
      page
        .locator('audio.library-audio[data-role="active"]')
        .evaluate(
          (element: HTMLAudioElement, at) =>
            element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA &&
            !element.seeking &&
            element.currentTime >= at,
          seconds,
        ),
    )
    .toBe(true)
}

/**
 * What song A reported from the reload on: the first time it was emptied after entry `from`. Empty
 * until then. Events from before the drop, such as the seek that set the test up, are left out.
 */
async function reloadSince(page: Page, from: number) {
  const entries = (await mediaSince(page, from)).filter((entry) => entry.src === 'song-a')
  const start = entries.findIndex((entry) => entry.type === 'emptied')
  return start < 0 ? [] : entries.slice(start)
}

/**
 * Waits for the player to load song A again after a drop logged from entry `from`: emptied and
 * started afresh, then moved back to where it stopped once the metadata was in, in that order.
 * With `playing` it also waits for it to play.
 */
async function waitForReload(page: Page, from: number, playing: boolean) {
  const wanted = [
    'emptied',
    'loadstart',
    'loadedmetadata',
    'seeked',
    ...(playing ? ['playing'] : []),
  ]
  await expect
    .poll(async () => {
      let next = 0
      for (const entry of await reloadSince(page, from)) if (entry.type === wanted[next]) next += 1
      return next >= wanted.length
    })
    .toBe(true)
}

test('a dropped connection reloads the song where it stopped instead of skipping it', async ({
  page,
}) => {
  await logMedia(page)
  const scrobbles = await restoreQueue(page, [alpha, bravo])
  // Now Playing is where the status line shows.
  await playFrom(page, 10, '/now-playing')
  const active = page.locator('audio.library-audio[data-role="active"]')
  const status = page.getByText('Lost the connection to the server. Trying again…')
  const from = await mediaCount(page)
  const at = await dropConnection(page)
  await expect(status).toBeVisible()
  await waitForReload(page, from, true)

  // Started from where it stopped, not from the top.
  const seeked = (await reloadSince(page, from)).find((entry) => entry.type === 'seeked')
  expect(seeked?.time).toBeGreaterThanOrEqual(at - 0.5)
  expect(seeked?.time).toBeLessThan(at + 2)
  await expect
    .poll(() => active.evaluate((element: HTMLAudioElement) => !element.paused))
    .toBe(true)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Alpha')
  await expect(status).toHaveCount(0)
  await expect(toasts(page)).not.toContainText('Skipped')
  // The reload is the same listen, so "now playing" went out once.
  expect(scrobbles.filter((entry) => entry.id === 'song-a' && !entry.submission)).toHaveLength(1)
})

test('a reload the server refuses is tried again rather than skipping the song', async ({
  page,
}) => {
  await logMedia(page)
  await restoreQueue(page, [alpha, bravo])
  await playFrom(page, 10)
  // The server is still down when the first reload goes out, and back for the next. The browser
  // reports a refused load as a source it cannot play, not as a dropped connection.
  let refused = 0
  await page.route('**/api/player/stream/song-a', async (route) => {
    if (refused > 0) return route.fallback()
    refused += 1
    return route.abort('connectionrefused')
  })
  const from = await mediaCount(page)
  const at = await dropConnection(page)
  await waitForReload(page, from, true)
  expect(refused).toBe(1)
  const reload = await reloadSince(page, from)
  expect(reload.filter((entry) => entry.type === 'loadstart')).toHaveLength(2)
  const seeked = reload.find((entry) => entry.type === 'seeked')
  expect(seeked?.time).toBeGreaterThanOrEqual(at - 0.5)
  await expect(page.getByRole('contentinfo')).toContainText('Alpha')
  await expect(toasts(page)).not.toContainText('Skipped')
})

test('a song that keeps losing its connection is skipped once the reloads run out', async ({
  page,
}) => {
  await logMedia(page)
  await restoreQueue(page, [alpha, bravo])
  await playFrom(page, 10)
  // Each drop comes as soon as the reload plays, so the song never gets far enough past the
  // last drop for the count to start again.
  for (let reload = 0; reload < 3; reload += 1) {
    const from = await mediaCount(page)
    await dropConnection(page)
    await waitForReload(page, from, true)
  }
  await dropConnection(page)
  await expect(toasts(page)).toHaveText('Skipped Alpha, it could not be played')
  await expect(page.getByRole('contentinfo')).toContainText('Bravo')
})

test('a pause while the reload waits keeps the song paused', async ({ page }) => {
  await logMedia(page)
  await restoreQueue(page, [alpha, bravo])
  await playFrom(page, 10)
  const active = page.locator('audio.library-audio[data-role="active"]')
  const from = await mediaCount(page)
  await dropConnection(page)
  // The player still shows it playing, so the press pauses it.
  await page.getByRole('contentinfo').getByRole('button', { name: 'Pause', exact: true }).click()
  await waitForReload(page, from, false)
  const reload = await reloadSince(page, from)
  expect(reload.filter((entry) => entry.type === 'playing')).toEqual([])
  expect(await active.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true)
  await expect(
    page.getByRole('contentinfo').getByRole('button', { name: 'Play', exact: true }),
  ).toBeVisible()
})

test('a paused song that keeps losing its connection waits for play instead of skipping', async ({
  page,
}) => {
  await logMedia(page)
  await restoreQueue(page, [alpha, bravo])
  await playFrom(page, 10)
  const active = page.locator('audio.library-audio[data-role="active"]')
  await page.keyboard.press('Space')
  await expect.poll(() => active.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true)
  for (let reload = 0; reload < 3; reload += 1) {
    const from = await mediaCount(page)
    await dropConnection(page)
    await waitForReload(page, from, false)
  }
  const at = await dropConnection(page)
  await expect(toasts(page)).toContainText(
    'Lost the connection to the server. Press play to try again.',
  )
  await expect(page.getByRole('contentinfo')).toContainText('Alpha')
  await expect(toasts(page)).not.toContainText('Skipped')

  // Play loads it again and carries on from where it stopped.
  const from = await mediaCount(page)
  await page.keyboard.press('Space')
  await waitForReload(page, from, true)
  const seeked = (await reloadSince(page, from)).find((entry) => entry.type === 'seeked')
  expect(seeked?.time).toBeGreaterThanOrEqual(at - 0.5)
  await expect(page.getByRole('contentinfo')).toContainText('Alpha')
})

test('a song chosen while the reload waits is the one that plays', async ({ page }) => {
  await logMedia(page)
  await restoreQueue(page, [alpha, bravo])
  await playFrom(page, 10)
  const active = page.locator('audio.library-audio[data-role="active"]')
  const from = await mediaCount(page)
  await dropConnection(page)
  await page.getByRole('contentinfo').getByRole('button', { name: 'Next track' }).click()
  await expect(page.getByRole('contentinfo')).toContainText('Bravo')
  await expect
    .poll(() => active.evaluate((element: HTMLAudioElement) => !element.paused))
    .toBe(true)
  // Past the moment the reload would have happened. Nothing can be polled for here: the check is
  // that nothing happens.
  await page.waitForTimeout(RETRY_DELAY_MS * 2)
  const reloads = (await mediaSince(page, from)).filter(
    (entry) => entry.src === 'song-a' && entry.type === 'loadstart',
  )
  expect(reloads).toEqual([])
  await expect(active).toHaveAttribute('src', /song-b/)
  await expect(page.getByRole('contentinfo')).toContainText('Bravo')
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
