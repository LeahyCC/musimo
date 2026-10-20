import { afterEach, expect, it, vi } from 'vitest'

import { resetListenerForTests, setListenerId } from '../listener/identity'
import { QueueWriter } from './queue-writer'

afterEach(() => {
  resetListenerForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function listenerHeader(init: RequestInit | undefined): string {
  return new Headers(init?.headers).get('X-Musimo-Listener') ?? ''
}

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
  writer.reset()
  expect((await writer.save('{}'))?.status).toBe(204)
  expect(acquired).toBe(2)
})

it('keeps the queue on the name that started the save', async () => {
  setListenerId('ln-aaaaaaaaaaaaaaaa')
  let release: () => void = () => undefined
  const headers: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      headers.push(listenerHeader(init))
      if (headers.length === 1) {
        await new Promise<void>((resolve) => {
          release = resolve
        })

        return Response.json({ epoch: 1 })
      }
      return new Response(null, { status: 204 })
    }),
  )
  const writer = new QueueWriter(vi.fn())
  const pending = writer.save(JSON.stringify({ ids: ['old'] }))
  await vi.waitFor(() => expect(headers).toHaveLength(1))
  setListenerId('ln-bbbbbbbbbbbbbbbb')
  release()
  expect((await pending)?.status).toBe(204)
  expect(headers).toEqual(['ln-aaaaaaaaaaaaaaaa', 'ln-aaaaaaaaaaaaaaaa'])
})

it('drops a save that started before the name changed', async () => {
  setListenerId('ln-aaaaaaaaaaaaaaaa')
  const seen: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      seen.push(listenerHeader(init))
      return String(url).endsWith('/writer')
        ? Response.json({ epoch: 1 })
        : new Response(null, { status: 204 })
    }),
  )
  const writer = new QueueWriter(vi.fn())
  const begun = writer.begin()
  writer.reset()
  setListenerId('ln-bbbbbbbbbbbbbbbb')
  expect(await writer.save(JSON.stringify({ ids: ['old'] }), begun)).toBeNull()
  expect(seen).toEqual([])
  expect((await writer.save(JSON.stringify({ ids: ['new'] })))?.ok).toBe(true)
  expect(seen).toEqual(['ln-bbbbbbbbbbbbbbbb', 'ln-bbbbbbbbbbbbbbbb'])
})

it('a reset cancels an in-flight save before it can write the next name', async () => {
  setListenerId('ln-aaaaaaaaaaaaaaaa')
  const calls: { url: string; listener: string }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), listener: listenerHeader(init) })
      if (calls.length === 1) {
        return new Promise<Response>((_resolve, reject) => {
          const fail = () => reject(new Error('aborted'))
          if (init.signal?.aborted) fail()
          else init.signal?.addEventListener('abort', fail, { once: true })
        })
      }
      return String(url).endsWith('/writer')
        ? Response.json({ epoch: 2 })
        : new Response(null, { status: 204 })
    }),
  )
  const failed = vi.fn()
  const writer = new QueueWriter(failed)
  const pending = writer.save(JSON.stringify({ ids: ['old'] }))
  await vi.waitFor(() => expect(calls).toHaveLength(1))
  writer.reset()
  setListenerId('ln-bbbbbbbbbbbbbbbb')
  expect(await pending).toBeNull()
  expect(failed).not.toHaveBeenCalled()
  expect(calls).toHaveLength(1)
  expect((await writer.save(JSON.stringify({ ids: ['new'] })))?.status).toBe(204)
  expect(calls.map((call) => call.listener)).toEqual([
    'ln-aaaaaaaaaaaaaaaa',
    'ln-bbbbbbbbbbbbbbbb',
    'ln-bbbbbbbbbbbbbbbb',
  ])
})
