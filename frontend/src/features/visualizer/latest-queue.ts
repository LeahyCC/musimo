/**
 * Runs jobs one at a time, in the order they were asked for, and skips any job that a newer one
 * replaced while it waited. The job running when a newer one arrives still finishes, since it
 * cannot be stopped part way, and the newest then runs after it, so the last request is what
 * stays. Each call's promise says whether its job ran; it never rejects.
 */
export function createLatestQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  let latest = 0
  return (job: () => Promise<void>): Promise<boolean> => {
    const ticket = ++latest
    const run = tail.then(async () => {
      if (ticket !== latest) return false
      await job()
      return true
    })
    // A failed job is the caller's to report. The queue only needs to know it is over.
    const settled = run.catch(() => true)
    tail = settled
    return settled
  }
}
