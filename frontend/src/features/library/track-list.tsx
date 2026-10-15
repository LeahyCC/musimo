import { Pause, Play, X } from 'lucide-react'

import type { LibraryTrack } from '../../api'
import { RowMenu } from '../../components/row-menu'
import { cx } from '../../lib/cx'
import { IconButton } from '../../ui'
import { durationText, usePlayer } from '../player/player'
import { queueActions } from '../player/queue-actions'

/** Brings the row Now Playing's About tab pointed at into view once it is on screen. */
const showRow = (row: HTMLElement | null) => row?.scrollIntoView({ block: 'center' })

/** What the first column of a track row counts:
 *  - `track`: each song's number on its own album, which reads right in album order.
 *  - `position`: its place in this list, for a list a person ordered themselves.
 *  - `none`: nothing, for a list sorted by something a number says nothing about. */
type TrackNumbering = 'track' | 'position' | 'none'

export function TrackList({
  tracks,
  source,
  numbering = 'track',
  highlightId = '',
  removing = false,
  onRemove,
}: {
  tracks: LibraryTrack[]
  source: string
  numbering?: TrackNumbering
  /** A song to mark as the playing one even where the queue did not start from this list. */
  highlightId?: string
  removing?: boolean
  onRemove?: (index: number) => void
}) {
  const player = usePlayer()
  const highlighted = highlightId ? tracks.findIndex((track) => track.id === highlightId) : -1
  return (
    <div className="library-tracks grid">
      {tracks.map((track, index) => {
        // A playlist may hold the same song twice, and the same song appears in several
        // collections, so the queue and the position are both part of "the playing row".
        // An edited queue no longer lines up with the list, so its places say nothing about a row.
        const current =
          player.source === source &&
          !player.edited &&
          player.currentIndex === index &&
          player.libraryTrack?.id === track.id
        const playing = current && player.playing
        const marked = current || index === highlighted
        return (
          <div
            className="library-track-row flex items-center border-b border-line"
            key={`${track.id}-${index}`}
          >
            <button
              ref={index === highlighted ? showRow : undefined}
              aria-current={marked ? 'true' : undefined}
              className={cx(
                'library-track-play grid w-full items-center gap-[12px] rounded-md border-0 px-[12px] py-[10px] text-left text-inherit hover:bg-hover coarse:min-h-11',
                numbering === 'none'
                  ? 'grid-cols-[minmax(170px,2fr)_minmax(100px,1fr)_52px_24px] max-phone:grid-cols-[minmax(0,1fr)_24px]'
                  : 'grid-cols-[34px_minmax(170px,2fr)_minmax(100px,1fr)_52px_24px] max-phone:grid-cols-[24px_minmax(0,1fr)_24px]',
                marked ? 'bg-hover' : 'bg-transparent',
              )}
              aria-label={`${playing ? 'Pause' : 'Play'} ${track.title}`}
              onClick={() =>
                current ? player.toggle() : player.playLibrary(tracks, index, source)
              }
            >
              {numbering !== 'none' && (
                <span className="text-small text-muted">
                  {numbering === 'position' ? index + 1 : (track.track ?? index + 1)}
                </span>
              )}
              <span className="grid min-w-0 gap-[3px]">
                <strong>{track.title}</strong>
                <small className="text-small text-muted">{track.artist}</small>
                {track.playbackWarning && (
                  <small className="text-small text-muted">{track.playbackWarning}</small>
                )}
              </span>
              {/* A long album name wraps to two lines and then stops, so it cannot stretch the row. */}
              <small
                className="line-clamp-2 min-w-0 text-small text-muted [overflow-wrap:anywhere] max-phone:hidden"
                title={track.album}
              >
                {track.album}
              </small>
              <time className="text-small text-muted max-phone:hidden">
                {durationText(track.duration)}
              </time>
              {playing ? <Pause size={15} /> : <Play size={15} fill="currentColor" />}
            </button>
            <RowMenu
              className="mr-[5px]"
              label={`More actions for ${track.title}`}
              actions={queueActions(
                () => player.playNext([track]),
                () => player.addToQueue([track]),
              )}
            />
            {onRemove && (
              <IconButton
                className="mr-[5px] w-[38px] flex-none"
                aria-label={`Remove ${track.title} from playlist`}
                // Removal is positional, so a second click during the first would send an
                // index measured against the old list and delete a different song.
                disabled={removing}
                onClick={() => onRemove(index)}
              >
                <X size={16} />
              </IconButton>
            )}
          </div>
        )
      })}
    </div>
  )
}
