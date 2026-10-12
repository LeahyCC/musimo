import { describe, expect, it } from 'vitest'

import { formatBytes, formatDuration } from './format'

describe('formatDuration', () => {
  it('reads minutes and seconds under an hour', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(187.9)).toBe('3:07')
    expect(formatDuration(3599)).toBe('59:59')
  })

  it('adds hours from an hour up', () => {
    expect(formatDuration(3600)).toBe('1:00:00')
    expect(formatDuration(3725)).toBe('1:02:05')
    expect(formatDuration(7200)).toBe('2:00:00')
  })
})

describe('formatBytes', () => {
  it('picks the unit that keeps the number short', () => {
    expect(formatBytes(0)).toBe('0 KB')
    expect(formatBytes(300)).toBe('1 KB')
    expect(formatBytes(512 * 1024)).toBe('512 KB')
    expect(formatBytes(35_840_000)).toBe('34.2 MB')
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.0 GB')
  })
})
