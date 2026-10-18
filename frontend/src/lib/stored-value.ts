import { useSyncExternalStore } from 'react'

/**
 * A value kept in browser storage that more than one component reads, such as a player setting
 * the settings page changes while a track plays. Another tab changing it fires `storage`, which
 * reloads it here. The snapshot is replaced only when the value changes, which is what
 * useSyncExternalStore needs to avoid re-rendering on every read.
 */
export function storedValue<T>(load: () => T, equal: (a: T, b: T) => boolean = Object.is) {
  let loaded = false
  let value: T | undefined
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) listener()
  }

  const snapshot = (): T => {
    if (!loaded) {
      loaded = true
      value = load()
    }

    return value as T
  }

  const refresh = () => {
    const next = load()
    if (equal(next, snapshot())) return
    value = next
    notify()
  }

  // One `storage` listener per value, shared by every subscriber. It is removed only when the
  // last one leaves: removing it on any unsubscribe would stop a tab hearing other tabs while
  // components that read the value are still on screen.
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    if (listeners.size === 1) window.addEventListener('storage', refresh)

    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) window.removeEventListener('storage', refresh)
    }
  }

  return {
    get: snapshot,
    subscribe,
    set(next: T) {
      snapshot()
      value = next
      notify()
    },
    use: () => useSyncExternalStore(subscribe, snapshot, snapshot),
  }
}
