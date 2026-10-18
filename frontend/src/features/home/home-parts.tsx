import { useState } from 'react'

import { useNavigate } from '@tanstack/react-router'
import { Disc3 } from 'lucide-react'

import { cx } from '../../lib/cx'
import { useBotChat } from '../music-bot/bot-chat'
import { historyTrack } from '../player/play-history'
import { usePlayer } from '../player/player'

/* Pieces both Home layouts draw the same way, and the few places where the dashboard reads state
   from the player and the music bot. */

export const OCTIVE_PROMPTS = [
  'An hour of focus music',
  "Songs I haven't played in a year",
  'Something upbeat for a run',
  'Quiet songs for tonight',
]

/** A cover from the player's art route, or a plain disc where the song or album has none. */
export function Cover({
  coverArt,
  className,
  iconSize = 24,
}: {
  coverArt?: string
  className?: string
  iconSize?: number
}) {
  return coverArt ? (
    <img
      className={cx('shrink-0 bg-hover object-cover', className)}
      src={`/api/player/art/${encodeURIComponent(coverArt)}`}
      alt=""
      loading="lazy"
    />
  ) : (
    <span className={cx('grid shrink-0 place-items-center bg-hover text-muted', className)}>
      <Disc3 size={iconSize} />
    </span>
  )
}

/** The time of render, kept for the life of the page so a dashboard does not shift under the pointer. */
export const useNow = () => useState(Date.now)[0]

/**
 * Sends a prompt to Octive and opens the chat page to show the answer. The chat is the same one
 * the pet and the Octive page use, so it carries on from whatever was asked there before.
 */
export function useAskOctive() {
  const chat = useBotChat()
  const navigate = useNavigate()
  return (prompt?: string) => {
    if (prompt) void chat.send(prompt)
    void navigate({ to: '/music-bot' })
  }
}

/**
 * What "Continue listening" offers: the loaded song with its place in the queue, or, when nothing
 * is loaded, the last song this browser played. The second can only be started again, not resumed.
 */
export function useContinue() {
  const player = usePlayer()
  const live = player.libraryTrack
  const last = player.history[0]
  const track = live ?? (last ? historyTrack(last) : null)
  if (!track) return null
  return {
    track,
    live: live !== null,
    playing: live !== null && player.playing,
    position: live ? player.position : 0,
    length: live ? player.length || track.duration : track.duration,
    queueNumber: live && player.currentIndex >= 0 ? player.currentIndex + 1 : null,
    queueSize: player.queue.length,
    // Resume a loaded song; start the last one again.
    press: () => (live ? player.toggle() : player.playLibrary([track])),
    next: player.next,
  }
}
