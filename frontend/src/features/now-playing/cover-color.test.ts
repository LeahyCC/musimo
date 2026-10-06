import { describe, expect, it } from 'vitest'

import { dominantColor } from './cover-color'

/** RGBA data for `count` identical pixels. */
const pixels = (count: number, r: number, g: number, b: number, a = 255): number[] =>
  Array.from({ length: count }, () => [r, g, b, a]).flat()

describe('dominantColor', () => {
  it('gives the color that most of the cover is', () => {
    const data = [...pixels(30, 200, 40, 40), ...pixels(10, 40, 40, 200)]
    expect(dominantColor(data)).toEqual({ r: 200, g: 40, b: 40, a: 1 })
  })

  it('averages the pixels that share a bucket', () => {
    const data = [...pixels(4, 200, 40, 40), ...pixels(4, 210, 50, 50)]
    expect(dominantColor(data)).toEqual({ r: 205, g: 45, b: 45, a: 1 })
  })

  it('lets a saturated band win over a larger grey field', () => {
    const data = [...pixels(20, 120, 120, 120), ...pixels(12, 220, 30, 30)]
    expect(dominantColor(data)).toEqual({ r: 220, g: 30, b: 30, a: 1 })
  })

  it('skips near-black, near-white and see-through pixels', () => {
    const data = [
      ...pixels(50, 5, 5, 5),
      ...pixels(50, 250, 250, 250),
      ...pixels(50, 200, 40, 40, 0),
      ...pixels(2, 30, 120, 60),
    ]
    expect(dominantColor(data)).toEqual({ r: 30, g: 120, b: 60, a: 1 })
  })

  it('has nothing to say about a cover with no color in it', () => {
    expect(dominantColor([...pixels(10, 0, 0, 0), ...pixels(10, 255, 255, 255)])).toBeNull()
    expect(dominantColor([])).toBeNull()
  })
})
