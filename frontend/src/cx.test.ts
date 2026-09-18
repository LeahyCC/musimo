import { describe, expect, it } from 'vitest'

import { cx } from './cx'

describe('cx', () => {
  it('joins names with a space', () => {
    expect(cx('track-row', 'playing')).toBe('track-row playing')
  })

  it('drops false, null, undefined and empty names', () => {
    expect(cx('button', false, null, undefined, '', 'primary')).toBe('button primary')
  })

  it('is empty when nothing applies', () => {
    expect(cx(false, undefined)).toBe('')
  })
})
