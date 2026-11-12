import { describe, expect, it } from 'vitest'

import { withinCap } from './toast-cap'

type Item = { id: number; action?: { label: string } }

const plain = (id: number): Item => ({ id })
const withRetry = (id: number): Item => ({ id, action: { label: 'Retry' } })
const ids = (items: Item[]) => items.map((item) => item.id)

describe('withinCap', () => {
  it('keeps the newest three toasts that go by themselves', () => {
    expect(ids(withinCap([1, 2, 3, 4, 5].map(plain)))).toEqual([3, 4, 5])
  })

  it('never pushes out a toast with an action, however many come after it', () => {
    const list = [withRetry(1), ...[2, 3, 4, 5, 6].map(plain)]
    expect(ids(withinCap(list))).toEqual([1, 4, 5, 6])
  })

  it('leaves a short list alone', () => {
    const list = [plain(1), withRetry(2)]
    expect(withinCap(list)).toEqual(list)
  })
})
