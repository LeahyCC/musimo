import { describe, expect, it } from 'vitest'

import { matchOption, stepOption } from './select'
import type { PickerOption } from './select'

const row = (label: string, disabled = false): PickerOption => ({
  value: label.toLowerCase(),
  label,
  disabled,
})

const rows = [row('All', true), row('Albums'), row('Artists'), row('Bands', true), row('Tracks')]

describe('stepOption', () => {
  it('skips disabled rows', () => {
    expect(stepOption(rows, 2, 1)).toBe(4)
    expect(stepOption(rows, 4, -1)).toBe(2)
  })

  it('stays put at either end', () => {
    expect(stepOption(rows, 1, -1)).toBe(1)
    expect(stepOption(rows, 4, 1)).toBe(4)
  })

  it('finds the first and last enabled rows from outside the list', () => {
    expect(stepOption(rows, -1, 1)).toBe(1)
    expect(stepOption(rows, rows.length, -1)).toBe(4)
  })
})

describe('matchOption', () => {
  it('finds the next row after the current one that starts with what was typed', () => {
    expect(matchOption(rows, 'a', 1)).toBe(2)
    expect(matchOption(rows, 'a', 2)).toBe(1)
  })

  it('ignores case and disabled rows', () => {
    expect(matchOption(rows, 'B', 0)).toBe(-1)
    expect(matchOption(rows, 'TR', 0)).toBe(4)
  })
})
