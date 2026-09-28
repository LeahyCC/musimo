/** What one saved play queue holds. The player imports this so the two cannot drift. */
export const QUEUE_LIMIT = 500
/** Start loading the next batch while this many songs are still ahead. */
export const SHUFFLE_AHEAD = 40
/** How many songs to ask for at a time. Staying under the saved-queue cap leaves room to drop played ones. */
export const SHUFFLE_FETCH = 200

export type Deck = {
  /** Every song in this shuffle, so a finished pass can start again. */
  order: string[]
  /** Songs not yet copied into the play queue. */
  upcoming: string[]
}

/** The play queue is a window. This is how many deck songs are still waiting outside it. */
export function stillWaiting(deck: Deck): number {
  return deck.upcoming.length
}

/** True when the playing song is close enough to the end of the window to fetch more. */
export function needsMore(queueLength: number, index: number, waiting: number): boolean {
  if (index < 0) return false
  const ahead = queueLength - index - 1
  return ahead < SHUFFLE_AHEAD && (waiting > 0 || queueLength > 0)
}

/** Played songs to drop so `incoming` new ones fit, without dropping the song that is playing. */
export function dropForRoom(
  queueLength: number,
  index: number,
  incoming: number,
  limit = QUEUE_LIMIT,
): number {
  const overflow = queueLength + incoming - limit
  if (overflow <= 0) return 0
  return Math.max(0, Math.min(index, overflow))
}

/** A new order of `order`, leaving out songs already in the queue so the boundary does not repeat. */
export function reshuffle(order: readonly string[], skip: ReadonlySet<string>): string[] {
  const ids = order.filter((id) => !skip.has(id))
  for (let i = ids.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const swap = ids[i] as string
    ids[i] = ids[j] as string
    ids[j] = swap
  }
  return ids
}
