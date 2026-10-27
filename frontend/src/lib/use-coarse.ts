import { useSyncExternalStore } from 'react'

// A finger, not a mouse: no hover, or the primary pointer is coarse. The stage uses this to
// swap the preset menu for a sheet, because a floating list has nothing to tap to dismiss it.
const COARSE_QUERY = '(hover: none), (pointer: coarse)'

const subscribe = (notify: () => void) => {
  const query = window.matchMedia(COARSE_QUERY)
  query.addEventListener('change', notify)
  return () => query.removeEventListener('change', notify)
}

/** Whether this window is a touch screen, following it if a pointer is attached or removed. */
export const useCoarsePointer = () =>
  useSyncExternalStore(
    subscribe,
    () => window.matchMedia(COARSE_QUERY).matches,
    () => false,
  )
