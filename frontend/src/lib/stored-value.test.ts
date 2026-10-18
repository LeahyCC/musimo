import { afterEach, describe, expect, it, vi } from 'vitest'

import { storedValue } from './stored-value'

/** A stand-in for `window` that only knows about `storage` listeners. */
function fakeWindow() {
  const handlers = new Set<() => void>()
  vi.stubGlobal('window', {
    addEventListener: (_type: string, handler: () => void) => handlers.add(handler),
    removeEventListener: (_type: string, handler: () => void) => handlers.delete(handler),
  })

  return { handlers, fire: () => handlers.forEach((handler) => handler()) }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('storedValue', () => {
  it('keeps hearing other tabs until the last reader leaves', () => {
    const page = fakeWindow()
    let stored = 'classic'
    const value = storedValue(() => stored)
    const first = vi.fn()
    const second = vi.fn()
    const leaveFirst = value.subscribe(first)
    const leaveSecond = value.subscribe(second)
    value.get()

    leaveFirst()
    stored = 'room'
    page.fire()
    expect(second).toHaveBeenCalledTimes(1)
    expect(value.get()).toBe('room')

    leaveSecond()
    expect(page.handlers.size).toBe(0)
  })
})
