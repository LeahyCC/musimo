import { describe, expect, it } from 'vitest'

import { createLatestQueue } from './latest-queue'

/** Lets every job that can start do so. */
const tick = () => new Promise((resolve) => setTimeout(resolve))

/** A job that finishes only when told to, logging when it starts and ends. */
function gate(log: string[], name: string) {
  let open = () => {}
  const done = new Promise<void>((resolve) => (open = resolve))
  const job = async () => {
    log.push(`start ${name}`)
    await done
    log.push(`end ${name}`)
  }
  return { job, open }
}

describe('createLatestQueue', () => {
  it('runs one job at a time, in order', async () => {
    const log: string[] = []
    const enqueue = createLatestQueue()
    const a = gate(log, 'a')
    const b = gate(log, 'b')
    const first = enqueue(a.job)
    await tick()
    const second = enqueue(b.job)
    // b waits for a, even though a resolves only after b was asked for.
    b.open()
    a.open()
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b'])
  })

  // Two quick preset changes must not leave the stage on the older one.
  it('skips a waiting job that a newer one replaced, so the last request wins', async () => {
    const log: string[] = []
    const enqueue = createLatestQueue()
    const a = gate(log, 'a')
    const b = gate(log, 'b')
    const c = gate(log, 'c')
    const first = enqueue(a.job)
    await tick()
    const second = enqueue(b.job)
    const third = enqueue(c.job)
    a.open()
    b.open()
    c.open()
    expect(await Promise.all([first, second, third])).toEqual([true, false, true])
    expect(log).toEqual(['start a', 'end a', 'start c', 'end c'])
  })

  it('keeps going after a job fails', async () => {
    const log: string[] = []
    const enqueue = createLatestQueue()
    const failed = enqueue(async () => {
      throw new Error('no shaders')
    })
    await expect(failed).resolves.toBe(true)
    const next = enqueue(async () => {
      log.push('ran')
    })
    await expect(next).resolves.toBe(true)
    expect(log).toEqual(['ran'])
  })
})
