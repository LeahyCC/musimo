/** What one saved play queue holds. The player imports this so the two cannot drift. */
export const QUEUE_LIMIT = 500
/** Start loading the next batch while this many songs are still ahead. */
export const SHUFFLE_AHEAD = 40
/** How many songs to ask for at a time. Staying under the saved-queue cap leaves room to drop played ones. */
export const SHUFFLE_FETCH = 200

export type Deck = {
  /** Empty when every song in this pass already fits in the queue. */
  seed: string
  /** Next index in the server's order. */
  cursor: number
  total: number
}

/** How many songs of this pass are still outside the queue. */
export function stillWaiting(deck: Deck): number {
  return Math.max(0, deck.total - deck.cursor)
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
