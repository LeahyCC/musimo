import { describe, expect, it } from 'vitest'

import {
  HANDOVER_LEAD_MS,
  HANDOVER_WINDOW_SECONDS,
  handoverDelay,
  LENGTH_TOLERANCE_SECONDS,
  lengthsAgree,
} from './handover'

describe('handoverDelay', () => {
  it('waits until the lead before the end', () => {
    expect(handoverDelay(0.9, 1)).toBeCloseTo(900 - HANDOVER_LEAD_MS)
    expect(handoverDelay(HANDOVER_WINDOW_SECONDS, 1)).toBeCloseTo(1000 - HANDOVER_LEAD_MS)
  })

  it('waits for nothing once the lead is already inside', () => {
    expect(handoverDelay(0.02, 1)).toBe(0)
    expect(handoverDelay(0, 1)).toBe(0)
    expect(handoverDelay(-0.5, 1)).toBe(0)
  })

  it('is not armed outside the last second', () => {
    expect(handoverDelay(1.01, 1)).toBeNull()
    expect(handoverDelay(15, 1)).toBeNull()
    expect(handoverDelay(Infinity, 1)).toBeNull()
    expect(handoverDelay(NaN, 1)).toBeNull()
  })

  it('counts the rest of the track in real time at another playback rate', () => {
    // The last 0.8 track seconds pass in 400 ms at double speed, 1600 ms at half.
    expect(handoverDelay(0.8, 2)).toBeCloseTo(400 - HANDOVER_LEAD_MS)
    expect(handoverDelay(0.8, 0.5)).toBeCloseTo(1600 - HANDOVER_LEAD_MS)
  })

  it('is not armed for a rate that does not move', () => {
    expect(handoverDelay(0.5, 0)).toBeNull()
    expect(handoverDelay(0.5, -1)).toBeNull()
    expect(handoverDelay(0.5, NaN)).toBeNull()
  })
})

describe('lengthsAgree', () => {
  it('accepts a stream as long as the library says, within the tolerance', () => {
    expect(lengthsAgree(200, 200)).toBe(true)
    expect(lengthsAgree(200 + LENGTH_TOLERANCE_SECONDS, 200)).toBe(true)
    expect(lengthsAgree(200 - LENGTH_TOLERANCE_SECONDS, 200)).toBe(true)
  })

  it('refuses one that is further off, in either direction', () => {
    expect(lengthsAgree(203, 200)).toBe(false)
    expect(lengthsAgree(197, 200)).toBe(false)
  })

  it('has nothing to compare when the library gives no length', () => {
    expect(lengthsAgree(200, 0)).toBe(true)
    expect(lengthsAgree(NaN, 200)).toBe(true)
  })
})
