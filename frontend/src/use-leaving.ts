import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

/** How long a track change takes to cross-fade the artwork and the wash. */
export const FADE_MS = 300

/** For the layer that is leaving: the `.leaving` rule in style.css fades it out over this long. */
export const leavingStyle: CSSProperties = { animationDuration: `${FADE_MS}ms` }

const reducedMotion = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * The value that was on screen before `value` changed, for the `FADE_MS` it takes to fade out, else
 * null. The caller draws it over the new value with `.leaving` and the fade does the rest. It is
 * wrapped so a value that is itself null or empty (no wash, no cover) can still leave.
 *
 * Under `prefers-reduced-motion` nothing is kept, so the change is a cut. The layout effect is what
 * puts the old layer back in the same frame the new value arrives, so there is no flash of the new
 * one alone.
 */
export function useLeaving<T>(value: T): { value: T } | null {
  const last = useRef(value)
  const [leaving, setLeaving] = useState<{ value: T } | null>(null)

  useLayoutEffect(() => {
    if (Object.is(last.current, value)) return undefined
    const before = last.current
    last.current = value
    if (reducedMotion()) {
      setLeaving(null)

      return undefined
    }
    setLeaving({ value: before })
    const timer = window.setTimeout(() => setLeaving(null), FADE_MS)

    return () => window.clearTimeout(timer)
  }, [value])

  return leaving
}
