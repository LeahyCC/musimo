import { LoaderCircle, Pause, Play } from 'lucide-react'

type PlayState = { playing: boolean; reconnecting: boolean }

/**
 * What a play button says. While the playing song waits to load again after a dropped connection
 * the button still pauses it, so the name keeps Pause and adds why nothing is heard.
 */
export function playLabel(state: PlayState, preview = false) {
  if (state.reconnecting) return RECONNECTING_LABEL
  if (preview) return state.playing ? 'Pause preview' : 'Play preview'
  return state.playing ? 'Pause' : 'Play'
}

export const RECONNECTING_LABEL = 'Pause, reconnecting'

/** Play, Pause, or a spinner while the playing song reconnects. Every layout's play button uses it. */
export function PlayIcon({
  playing,
  reconnecting,
  size,
  filled = false,
}: PlayState & { size: number; filled?: boolean }) {
  if (reconnecting)
    return (
      <LoaderCircle
        size={size}
        data-reconnecting=""
        className="animate-spin motion-reduce:animate-none"
      />
    )
  const Icon = playing ? Pause : Play
  return <Icon size={size} fill={filled ? 'currentColor' : 'none'} />
}
