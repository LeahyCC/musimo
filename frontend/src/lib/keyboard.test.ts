import { describe, expect, it } from 'vitest'

import { keyboardGeometry } from './keyboard'

describe('keyboardGeometry', () => {
  it('reads nothing when both viewports agree', () => {
    expect(keyboardGeometry({ layout: 844, tallest: 844, visible: 844, top: 0 })).toEqual({
      open: false,
      inset: 0,
      top: 0,
    })
  })

  it('finds a keyboard that shrinks only the visible viewport', () => {
    expect(keyboardGeometry({ layout: 844, tallest: 844, visible: 508, top: 0 })).toEqual({
      open: true,
      inset: 336,
      top: 0,
    })
  })

  it('takes away the distance the browser scrolled to show the field', () => {
    expect(keyboardGeometry({ layout: 844, tallest: 844, visible: 508, top: 120 })).toEqual({
      open: true,
      inset: 216,
      top: 120,
    })
  })

  it('finds a keyboard that resizes the layout viewport', () => {
    expect(keyboardGeometry({ layout: 508, tallest: 844, visible: 508, top: 0 })).toEqual({
      open: true,
      inset: 0,
      top: 0,
    })
  })

  it('ignores a browser bar sliding away', () => {
    expect(keyboardGeometry({ layout: 844, tallest: 844, visible: 788, top: 0 }).open).toBe(false)
    expect(keyboardGeometry({ layout: 788, tallest: 844, visible: 788, top: 0 }).open).toBe(false)
  })
})
