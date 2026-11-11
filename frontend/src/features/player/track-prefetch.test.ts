import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ACCOUNT_PREFETCH_LEAD_SECONDS,
  accountPrepareDue,
  fetchIntoCache,
  PREFETCH_BYTES,
  PREFETCH_FRESH_MS,
  type PrefetchTask,
  TrackPrefetcher,
  upcomingIndexes,
} from './track-prefetch'

/** A task whose run waits until the test settles it. */
function pending(key: string, abortable = true) {
  let finish: () => void = () => undefined
  let fail: (error: Error) => void = () => undefined
  const signals: AbortSignal[] = []
  const run = vi.fn(
    (signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        signals.push(signal)
        finish = resolve
        fail = reject
        signal.addEventListener('abort', () => reject(new Error('aborted')))
      }),
  )
  const task: PrefetchTask = { key, abortable, run }
  return { task, run, signals, finish: () => finish(), fail: (error: Error) => fail(error) }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('accountPrepareDue', () => {
  it('is not due early in a long song', () => {
    expect(accountPrepareDue(240, 5)).toBe(false)
    expect(accountPrepareDue(240, 240 - ACCOUNT_PREFETCH_LEAD_SECONDS - 1)).toBe(false)
  })

  it('is due from the lead time before the end', () => {
    expect(accountPrepareDue(240, 240 - ACCOUNT_PREFETCH_LEAD_SECONDS)).toBe(true)
    expect(accountPrepareDue(240, 239)).toBe(true)
  })

  it('is due at once in a song shorter than the lead time', () => {
    expect(accountPrepareDue(ACCOUNT_PREFETCH_LEAD_SECONDS - 10, 0)).toBe(true)
  })

  it('is not due while the length is unknown', () => {
    expect(accountPrepareDue(NaN, 100)).toBe(false)
    expect(accountPrepareDue(Infinity, 100)).toBe(false)
    expect(accountPrepareDue(0, 0)).toBe(false)
  })
})

describe('upcomingIndexes', () => {
  it('lists the songs after the playing one, in order', () => {
    expect(upcomingIndexes(5, 1, 2, false)).toEqual([2, 3])
  })

  it('stops at the end of the queue unless repeat all wraps', () => {
    expect(upcomingIndexes(5, 4, 2, false)).toEqual([])
    expect(upcomingIndexes(5, 3, 2, false)).toEqual([4])
    expect(upcomingIndexes(5, 4, 2, true)).toEqual([0, 1])
  })

  it('never includes the playing song, even in a short wrapped queue', () => {
    expect(upcomingIndexes(1, 0, 2, true)).toEqual([])
    expect(upcomingIndexes(2, 1, 3, true)).toEqual([0])
  })
})

describe('TrackPrefetcher', () => {
  it('runs one task at a time, in order', async () => {
    const prefetcher = new TrackPrefetcher()
    const a = pending('a')
    const b = pending('b')
    prefetcher.want([a.task, b.task])
    expect(a.run).toHaveBeenCalledTimes(1)
    expect(b.run).not.toHaveBeenCalled()
    a.finish()
    await flush()
    expect(b.run).toHaveBeenCalledTimes(1)
  })

  it('does not fetch a key twice, nor retry one that failed', async () => {
    const prefetcher = new TrackPrefetcher()
    const a = pending('a')
    prefetcher.want([a.task])
    a.fail(new Error('404'))
    await flush()
    prefetcher.want([a.task])
    expect(a.run).toHaveBeenCalledTimes(1)
  })

  it('stops a task no longer wanted, and may fetch it again later', async () => {
    const prefetcher = new TrackPrefetcher()
    const a = pending('a')
    const b = pending('b')
    prefetcher.want([a.task])
    prefetcher.want([b.task])
    expect(a.signals[0]?.aborted).toBe(true)
    await flush()
    expect(b.run).toHaveBeenCalledTimes(1)
    b.finish()
    await flush()
    prefetcher.want([a.task])
    expect(a.run).toHaveBeenCalledTimes(2)
  })

  it('lets a task that may not be stopped finish, and says when it has', async () => {
    const prefetcher = new TrackPrefetcher()
    const account = pending('account:dz-1', false)
    prefetcher.want([account.task])
    prefetcher.clear()
    expect(account.signals[0]?.aborted).toBe(false)
    let settled = false
    void prefetcher.settled('account:').then(() => (settled = true))
    await flush()
    expect(settled).toBe(false)
    account.finish()
    await flush()
    expect(settled).toBe(true)
  })

  it('says whether the task with exactly that key runs', () => {
    const prefetcher = new TrackPrefetcher()
    prefetcher.want([pending('account:dz-12', false).task])
    expect(prefetcher.isRunning('account:dz-12')).toBe(true)
    expect(prefetcher.isRunning('account:dz-1')).toBe(false)
  })

  it('is settled at once when nothing with that prefix runs', async () => {
    const prefetcher = new TrackPrefetcher()
    prefetcher.want([pending('/api/player/stream/tr-1').task])
    await expect(prefetcher.settled('account:')).resolves.toBeUndefined()
  })

  it('starts no held task, even one queued behind another, until the hold is released', async () => {
    const prefetcher = new TrackPrefetcher()
    const library = pending('/api/player/stream/tr-1')
    const account = pending('account:dz-1', false)
    prefetcher.want([library.task, account.task])
    const release = prefetcher.hold('account:')
    library.finish()
    await flush()
    expect(account.run).not.toHaveBeenCalled()
    release()
    expect(account.run).toHaveBeenCalledTimes(1)
  })

  it('keeps a task held while any one hold on it is left, and ignores a second release', () => {
    const prefetcher = new TrackPrefetcher()
    const account = pending('account:dz-1', false)
    const first = prefetcher.hold('account:')
    const second = prefetcher.hold('account:')
    prefetcher.want([account.task])
    first()
    first()
    expect(account.run).not.toHaveBeenCalled()
    second()
    expect(account.run).toHaveBeenCalledTimes(1)
  })

  it('starts nothing from a list that was replaced, while the old task finishes', async () => {
    const prefetcher = new TrackPrefetcher()
    const account = pending('account:dz-1', false)
    const stale = pending('/api/player/stream/tr-2')
    prefetcher.want([account.task, stale.task])
    prefetcher.want([])
    account.finish()
    await flush()
    expect(stale.run).not.toHaveBeenCalled()
  })

  it('forgets the oldest key past 100, so only that one may be fetched again', async () => {
    const prefetcher = new TrackPrefetcher()
    const done = (key: string) => ({ key, abortable: true, run: vi.fn(() => Promise.resolve()) })
    const tasks = Array.from({ length: 101 }, (_, index) => done(`key-${index}`))
    for (const task of tasks) {
      prefetcher.want([task])
      await flush()
    }
    const oldest = done('key-0')
    const second = done('key-1')
    prefetcher.want([second])
    expect(second.run).not.toHaveBeenCalled()
    prefetcher.want([oldest])
    expect(oldest.run).toHaveBeenCalledTimes(1)
  })

  describe('after the cached copy has gone stale', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('fetches a key again', async () => {
      vi.useFakeTimers()
      const prefetcher = new TrackPrefetcher()
      const a = pending('a')
      prefetcher.want([a.task])
      a.finish()
      await vi.runAllTimersAsync()
      vi.advanceTimersByTime(PREFETCH_FRESH_MS - 1)
      prefetcher.want([a.task])
      expect(a.run).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(1)
      prefetcher.want([a.task])
      expect(a.run).toHaveBeenCalledTimes(2)
    })
  })
})

describe('fetchIntoCache', () => {
  it('reads the body to its end at low priority', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]))
        controller.enqueue(new Uint8Array([3]))
        controller.close()
      },
    })
    const fetcher = vi.fn(() => Promise.resolve(new Response(body)))
    await fetchIntoCache('/api/player/stream/tr-1', new AbortController().signal, fetcher)
    expect(fetcher).toHaveBeenCalledWith(
      '/api/player/stream/tr-1',
      expect.objectContaining({ priority: 'low' }),
    )
  })

  it('asks for the start of the file only', async () => {
    const fetcher = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response(new Uint8Array([1]), { status: 206 })),
    )
    await fetchIntoCache('/api/player/stream/tr-1', new AbortController().signal, fetcher)
    expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({
      Range: `bytes=0-${PREFETCH_BYTES - 1}`,
    })
  })

  it('stops reading when aborted', async () => {
    const controller = new AbortController()
    // A body that has sent a little and waits for more, errored on abort the way fetch errors it.
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new Uint8Array([1]))
          init?.signal?.addEventListener('abort', () =>
            stream.error(new DOMException('Aborted', 'AbortError')),
          )
        },
      })
      return Promise.resolve(new Response(body, { status: 206 }))
    })
    const reading = fetchIntoCache('/api/player/stream/tr-1', controller.signal, fetcher)
    let finished = false
    void reading.then(
      () => (finished = true),
      () => (finished = true),
    )
    await flush()
    expect(finished).toBe(false)
    controller.abort()
    await expect(reading).rejects.toThrow('Aborted')
  })

  it('fails on an error response', async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Response('gone', { status: 404 })))
    await expect(
      fetchIntoCache('/api/player/stream/tr-1', new AbortController().signal, fetcher),
    ).rejects.toThrow('404')
  })
})
