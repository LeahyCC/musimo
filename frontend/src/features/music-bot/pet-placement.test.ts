import { describe, expect, it } from 'vitest'

import {
  perchStyle,
  placePopover,
  POPOVER_GAP,
  POPOVER_MAX_HEIGHT,
  POPOVER_WIDTH,
} from './pet-placement'

const desktop = { width: 1280, height: 800 }
const TOP_BAR = 87
// The footer is 75px tall and the pet's 56px box stands on its top edge.
const footerPet = (left: number) => ({ left, top: 800 - 75 - 56, width: 56, height: 56 })

describe('placePopover', () => {
  it('opens above a pet on the footer, full size, never under the top bar', () => {
    const place = placePopover(footerPet(244), desktop, TOP_BAR)
    expect(place.side).toBe('above')
    expect(place.width).toBe(POPOVER_WIDTH)
    expect(place.height).toBeLessThanOrEqual(POPOVER_MAX_HEIGHT)
    expect(place.top).toBeGreaterThanOrEqual(TOP_BAR + POPOVER_GAP)
    expect(place.top + place.height).toBeLessThanOrEqual(800 - 75 - 56)
  })

  it('points its arrow at the pet', () => {
    const pet = footerPet(244)
    const place = placePopover(pet, desktop, TOP_BAR)
    expect(place.left + place.arrowLeft).toBeCloseTo(pet.left + pet.width / 2)
  })

  it('stays inside the window for a pet on the right', () => {
    const place = placePopover(footerPet(1180), desktop, TOP_BAR)
    expect(place.left + place.width).toBeLessThanOrEqual(desktop.width - POPOVER_GAP)
    expect(place.arrowLeft).toBeLessThanOrEqual(place.width - 24)
  })

  it('shrinks to the room on a short window', () => {
    const short = { width: 1280, height: 600 }
    const place = placePopover(
      { left: 300, top: 600 - 75 - 56, width: 56, height: 56 },
      short,
      TOP_BAR,
    )
    expect(place.side).toBe('above')
    expect(place.height).toBeLessThan(POPOVER_MAX_HEIGHT)
    expect(place.top).toBeGreaterThanOrEqual(TOP_BAR + POPOVER_GAP)
  })

  it('opens below a pet near the top of the window', () => {
    const place = placePopover({ left: 600, top: 120, width: 44, height: 44 }, desktop, TOP_BAR)
    expect(place.side).toBe('below')
    expect(place.top).toBe(120 + 44 + POPOVER_GAP)
  })

  it('narrows to fit a small window', () => {
    const place = placePopover(footerPet(10), { width: 390, height: 844 }, 60)
    expect(place.width).toBe(390 - POPOVER_GAP * 2)
    expect(place.left).toBe(POPOVER_GAP)
  })
})

describe('perchStyle', () => {
  it('sits the pet left, centre or right on a desktop footer', () => {
    expect(perchStyle('left', false)).toEqual({ left: '29px' })
    expect(perchStyle('centre', false)).toEqual({ left: '50%', transform: 'translateX(-50%)' })
    expect(perchStyle('right', false)).toEqual({ right: '29px' })
  })

  it('keeps a phone pet on the left, over the mini player cover', () => {
    for (const position of ['left', 'centre', 'right'] as const)
      expect(perchStyle(position, true)).toEqual({ left: '8px' })
  })
})
