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

  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    window.addEventListener('storage', refresh)

    return () => {
      listeners.delete(listener)
      window.removeEventListener('storage', refresh)
    }
  }

  return {
    get: snapshot,
    set(next: T) {
      snapshot()
      value = next
      notify()
    },
    use: () => useSyncExternalStore(subscribe, snapshot, snapshot),
  }
}
