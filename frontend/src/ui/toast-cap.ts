/**
 * More than this and the oldest goes, so a burst of failures cannot fill the screen. Only the ones
 * that go by themselves count: a toast with an action, such as Retry, stays until it is used or
 * dismissed, so a burst of "Skipped" toasts cannot push it out and leave the failure unsaid.
 */
export const MAX_TOASTS = 3

/** Drops the oldest toasts without an action until no more than `MAX_TOASTS` of them are left. */
export function withinCap<T extends { action?: unknown }>(toasts: T[]): T[] {
  let timed = toasts.filter((toast) => !toast.action).length
  return toasts.filter((toast) => toast.action || timed-- <= MAX_TOASTS)
}
