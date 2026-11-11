/**
 * Fetches upcoming songs ahead of time, one at a time, so they are ready before their turn.
 *
 * The start of a library song is read and thrown away: the point is the browser's HTTP cache,
 * which the stream route allows, so the audio element's own first range request is answered from
 * disk and a slow or busy server does not hold up the next song. A Deezer song is prepared on the
 * server instead, since that download is the slow part of starting one.
 */

/** Start prefetching once the playing song has run this long, so its own start is not slowed. */
export const PREFETCH_AFTER_SECONDS = 5
/** How many songs after the playing one to fetch ahead. */
export const PREFETCH_AHEAD = 2
/**
 * How near the end of the playing song the next Deezer song is prepared. A prepare cannot be
 * stopped and holds the Deezer account until its download ends. If it started 5 seconds into a
 * long song, a listener who skipped or jumped to another Deezer song in all that time would wait
 * behind it, then be told the account is busy. Started only in the last minute, the window for
 * that is a minute at most. A song shorter than this prepares at once.
 */
export const ACCOUNT_PREFETCH_LEAD_SECONDS = 60
/**
 * The longest a Deezer prepare is waited on, by the request itself and by a song that is loading
 * and needs it. Past this a hung server is given up on and the song is asked for in the ordinary
 * way, rather than "Fetching…" showing forever.
 */
export const ACCOUNT_PREPARE_TIMEOUT_MS = 120_000

/** True once the next Deezer song should be prepared: the last minute of a song, all of a short one. */
export const accountPrepareDue = (length: number, time: number) =>
  Number.isFinite(length) && length > 0 && length - time <= ACCOUNT_PREFETCH_LEAD_SECONDS
/**
 * How much of a library song to fetch ahead. Chrome's disk cache drops an entry past a size limit,
 * so a whole large FLAC could be downloaded and then thrown away. A range request instead lands as
 * a partial 206 entry, which Chrome keeps sparsely, and the element's first range request at the
 * start of the song is served from it while the rest streams as usual. A few MB is tens of seconds
 * of lossless audio, plenty to start on.
 */
export const PREFETCH_BYTES = 4 * 1024 * 1024
/**
 * How long a fetched key counts as fetched. Matches the hour of the backend's `STREAM_CACHE`
 * max-age: after that the cached copy is stale, so the song is worth fetching again.
 */
export const PREFETCH_FRESH_MS = 60 * 60 * 1000
// Keys remembered as fetched, so a song is not fetched twice within the hour. Oldest go first.
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
type Hold = { prefix: string }

export class TrackPrefetcher {
  private wanted: PrefetchTask[] = []
  // When each key was last started, oldest first.
  private attempted = new Map<string, number>()
  private running: Running | null = null
  private holds = new Set<Hold>()

  /** Replaces what should be fetched, in order. A running task no longer wanted is stopped. */
  want(tasks: PrefetchTask[]) {
    this.wanted = tasks
    const running = this.running
    if (running?.task.abortable && !tasks.some((task) => task.key === running.task.key)) {
      running.controller.abort()
    }
    this.pump()
  }

  /**
   * Keeps any task whose key starts with `prefix` from starting until the returned function is
   * called. One already running is left alone; see `settled`. Holds stack, and releasing one twice
   * does nothing.
   */
  hold(prefix: string): () => void {
    const hold: Hold = { prefix }
    this.holds.add(hold)
    return () => {
      if (this.holds.delete(hold)) this.pump()
    }
  }

  /** Whether the task with exactly this key is running. */
  isRunning(key: string): boolean {
    return this.running?.task.key === key
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
    const task = this.wanted.find((item) => !this.fresh(item.key) && !this.held(item.key))
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

  private fresh(key: string) {
    const at = this.attempted.get(key)
    return at !== undefined && Date.now() - at < PREFETCH_FRESH_MS
  }

  private held(key: string) {
    for (const hold of this.holds) if (key.startsWith(hold.prefix)) return true
    return false
  }

  private remember(key: string) {
    // Deleted first so a key fetched again moves to the newest end.
    this.attempted.delete(key)
    this.attempted.set(key, Date.now())
    if (this.attempted.size <= REMEMBERED_KEYS) return
    const oldest = this.attempted.keys().next().value
    if (oldest !== undefined) this.attempted.delete(oldest)
  }
}

/**
 * Reads the first `PREFETCH_BYTES` of a file without keeping them, so they cost no memory here and
 * land in the HTTP cache. Low priority, so it gives way to the playing stream.
 */
export async function fetchIntoCache(
  url: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(url, {
    signal,
    priority: 'low',
    headers: { Range: `bytes=0-${PREFETCH_BYTES - 1}` },
  })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error(`Prefetch failed with ${response.status}`)
  }
  // A server or proxy that ignores Range answers 200 with the whole file. Stop after the part this
  // wanted rather than download all of it.
  const partial = response.status === 206
  const reader = response.body.getReader()
  let read = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    read += value.byteLength
    if (!partial && read >= PREFETCH_BYTES) {
      await reader.cancel()
      return
    }
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
