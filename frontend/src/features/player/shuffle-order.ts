/**
 * Shuffle puts the queue in a random order once and then plays it straight through, so every song
 * plays exactly once and Up next shows the real order. These are the reorders it needs.
 */

/** A copy of `items` in a random order (Fisher-Yates, so every order is equally likely). */
export function shuffled<T>(items: readonly T[], random = Math.random): T[] {
  const out = [...items]
  for (let at = out.length - 1; at > 0; at -= 1) {
    const swap = Math.floor(random() * (at + 1))
    const held = out[at] as T
    out[at] = out[swap] as T
    out[swap] = held
  }
  return out
}

/** `items` with the one at `index` first and the rest in a random order behind it. */
export function shuffleFrom<T>(items: readonly T[], index: number, random = Math.random): T[] {
  const first = items[index]
  if (first === undefined) return shuffled(items, random)
  return [first, ...shuffled([...items.slice(0, index), ...items.slice(index + 1)], random)]
}

/**
 * Puts a shuffled queue back in `original` order, keeping the playing entry playing. Entries
 * matched by identity, so a song queued twice stays two rows. Entries the original never had
 * (queued by hand while shuffled) stay together right after the nearest original entry at or
 * before the playing one, so what was queued next still plays next.
 */
export function unshuffle<T>(
  queue: readonly T[],
  index: number,
  original: readonly T[],
): { items: T[]; index: number } {
  const place = new Map(original.map((entry, at) => [entry, at]))
  const known = queue.filter((entry) => place.has(entry))
  known.sort((a, b) => (place.get(a) ?? 0) - (place.get(b) ?? 0))
  const extras = queue.filter((entry) => !place.has(entry))
  let anchor: T | undefined
  for (let at = Math.min(index, queue.length - 1); at >= 0 && anchor === undefined; at -= 1) {
    const entry = queue[at] as T
    if (place.has(entry)) anchor = entry
  }
  const cut = anchor === undefined ? 0 : known.indexOf(anchor) + 1
  const items = [...known.slice(0, cut), ...extras, ...known.slice(cut)]
  const playing = queue[index]
  return { items, index: playing === undefined ? index : items.indexOf(playing) }
}
