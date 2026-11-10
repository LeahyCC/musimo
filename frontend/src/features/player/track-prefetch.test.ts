import { describe, expect, it, vi } from 'vitest'

import {
  fetchIntoCache,
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

  it('is settled at once when nothing with that prefix runs', async () => {
    const prefetcher = new TrackPrefetcher()
    prefetcher.want([pending('/api/player/stream/tr-1').task])
    await expect(prefetcher.settled('account:')).resolves.toBeUndefined()
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

  it('fails on an error response', async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Response('gone', { status: 404 })))
    await expect(
      fetchIntoCache('/api/player/stream/tr-1', new AbortController().signal, fetcher),
    ).rejects.toThrow('404')
  })
})
