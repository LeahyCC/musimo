/**
 * Fetches upcoming songs ahead of time, one at a time, so they are ready before their turn.
 *
 * A library song is read to the end and thrown away: the point is the browser's HTTP cache, which
 * the stream route allows, so the audio element's own range requests are answered from disk and a
 * slow or busy server does not hold up the next song. A Deezer song is prepared on the server
 * instead, since that download is the slow part of starting one.
 */

/** Start prefetching once the playing song has run this long, so its own start is not slowed. */
export const PREFETCH_AFTER_SECONDS = 5
/** How many songs after the playing one to fetch ahead. */
export const PREFETCH_AHEAD = 2
// Keys remembered as fetched, so a song is not fetched twice in one session. Oldest go first.
const REMEMBERED_KEYS = 100

export type PrefetchTask = {
  /** Same key, same work: a task already fetched or running is not started again. */
  key: string
  run: (signal: AbortSignal) => Promise<void>
  /**
   * Whether a task no longer wanted may be stopped. A Deezer prepare may not: the server keeps
   * downloading after the request is gone, and the account stays busy until it is done.
   */
  abortable: boolean
}

type Running = { task: PrefetchTask; controller: AbortController; finished: Promise<void> }

export class TrackPrefetcher {
  private wanted: PrefetchTask[] = []
  private attempted = new Set<string>()
  private running: Running | null = null

  /** Replaces what should be fetched, in order. A running task no longer wanted is stopped. */
  want(tasks: PrefetchTask[]) {
    this.wanted = tasks
    const running = this.running
    if (running?.task.abortable && !tasks.some((task) => task.key === running.task.key)) {
      running.controller.abort()
    }
    this.pump()
  }

  /** Settles when no running task's key starts with `prefix`. Never rejects. */
  settled(prefix: string): Promise<void> {
    const running = this.running
    return running?.task.key.startsWith(prefix) ? running.finished : Promise.resolve()
  }

  /** Stops what can be stopped and forgets what was wanted. Fetched keys are kept. */
  clear() {
    this.wanted = []
    if (this.running?.task.abortable) this.running.controller.abort()
  }

  private pump() {
    if (this.running) return
    const task = this.wanted.find((item) => !this.attempted.has(item.key))
    if (!task) return
    // Marked before it runs: a failed fetch is not retried in a loop on every timeupdate. The
    // song is still loaded the ordinary way when its turn comes.
    this.remember(task.key)
    const controller = new AbortController()
    const finished = task
      .run(controller.signal)
      .catch(() => {
        // A stopped fetch may be wanted again later.
        if (controller.signal.aborted) this.attempted.delete(task.key)
      })
      .finally(() => {
        if (this.running?.task === task) this.running = null
        this.pump()
      })
    this.running = { task, controller, finished }
  }

  private remember(key: string) {
    this.attempted.add(key)
    if (this.attempted.size <= REMEMBERED_KEYS) return
    const oldest = this.attempted.values().next().value
    if (oldest !== undefined) this.attempted.delete(oldest)
  }
}

/**
 * Reads a response to its end without keeping it, so a large file costs no memory here and lands
 * whole in the HTTP cache. Low priority, so it gives way to the playing stream.
 */
export async function fetchIntoCache(
  url: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(url, { signal, priority: 'low' })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error(`Prefetch failed with ${response.status}`)
  }
  const reader = response.body.getReader()
  for (;;) {
    const { done } = await reader.read()
    if (done) return
  }
}

/**
 * Queue indexes to fetch ahead after `index`, in play order. Repeat all wraps to the start. The
 * playing song is never one of them.
 */
export function upcomingIndexes(
  length: number,
  index: number,
  count: number,
  wrap: boolean,
): number[] {
  const found: number[] = []
  for (let step = 1; step <= count; step += 1) {
    let at = index + step
    if (at >= length) {
      if (!wrap) break
      at %= length
    }
    if (at === index || found.includes(at)) break
    found.push(at)
  }
  return found
}
