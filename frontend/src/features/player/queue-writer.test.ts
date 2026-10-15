import { afterEach, expect, it, vi } from 'vitest'

import { QueueWriter } from './queue-writer'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('bounds a hung save, coalesces pending edits to Undo, and rejects a late server write', async () => {
  vi.useFakeTimers()
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), ms)
    return controller.signal
  })
  const failed = vi.fn()
  const sent: string[] = []
  let sequence = 0
  let stored = ''
  let late: (() => void) | undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/writer')) return Response.json({ epoch: 1 })
      const data = JSON.parse(String(init.body)) as { ids: string[]; sequence: number }
      const value = data.ids[0] ?? ''
      sent.push(value)
      const commit = () => {
        if (data.sequence > sequence) {
          stored = value
          sequence = data.sequence
        }
      }

      if (sent.length === 1) {
        late = commit
        return new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('timeout')))
        })
      }
      commit()
      return new Response(null, { status: 204 })
    }),
  )
  const writer = new QueueWriter(failed)
  const first = writer.save(JSON.stringify({ ids: ['bot-edit'] }))
  await vi.waitFor(() => expect(sent).toEqual(['bot-edit']))
  const edits = Array.from({ length: 100 }, (_, i) =>
    writer.save(JSON.stringify({ ids: [`edit-${i}`] })),
  )
  const undo = writer.save(JSON.stringify({ ids: ['original'] }))
  await vi.advanceTimersByTimeAsync(8000)
  expect(await first).toBeNull()
  expect((await Promise.all(edits)).every((value) => value === null)).toBe(true)
  expect((await undo)?.ok).toBe(true)
  expect(failed).toHaveBeenCalledTimes(1)
  expect(sent).toEqual(['bot-edit', 'original'])
  late?.()
  expect(stored).toBe('original')
})

it('reports a replaced writer and refuses further stale writes until the player reloads', async () => {
  const failed = vi.fn()
  let acquired = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/writer')) return Response.json({ epoch: ++acquired })
      return new Response(null, { status: acquired === 1 ? 409 : 204 })
    }),
  )
  const writer = new QueueWriter(failed)
  expect((await writer.save('{}'))?.status).toBe(409)
  expect(failed).toHaveBeenCalledOnce()
  expect(await writer.save('{}')).toBeNull()
  expect(acquired).toBe(1)
  expect(failed).toHaveBeenLastCalledWith(true)
})
