import { useSyncExternalStore } from 'react'

// The same edge as `max-phone:` (`--breakpoint-phone`, 48rem), so the layout and this agree.
const PHONE_QUERY = '(width < 48rem)'

const subscribePhone = (notify: () => void) => {
  const query = window.matchMedia(PHONE_QUERY)
  query.addEventListener('change', notify)
  return () => query.removeEventListener('change', notify)
}

/** Whether the window is under the phone breakpoint, following it as the window is resized. */
export const usePhone = () =>
  useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  )
