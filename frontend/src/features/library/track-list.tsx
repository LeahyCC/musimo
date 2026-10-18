import { Disc3, Pause, Play, X } from 'lucide-react'

import type { LibraryTrack } from '../../api'
import { RowMenu } from '../../components/row-menu'
import { cx } from '../../lib/cx'
import { useLayout } from '../../lib/layout'
import { IconButton } from '../../ui'
import { durationText, usePlayer } from '../player/player'
import { queueActions } from '../player/queue-actions'
import { cover } from './collection-items'

/** Brings the row Now Playing's About tab pointed at into view once it is on screen. */
const showRow = (row: HTMLElement | null) => row?.scrollIntoView({ block: 'center' })

/** What the first column of a track row counts:
 *  - `track`: each song's number on its own album, which reads right in album order.
 *  - `position`: its place in this list, for a list a person ordered themselves.
 *  - `none`: nothing, for a list sorted by something a number says nothing about. */
type TrackNumbering = 'track' | 'position' | 'none'

// The columns of the Tracks view's table. It adds a cover to the title and a plays column, so it
// has its own template; the album and artist pages keep the plainer rows.
const tableColumns = {
  numbered:
    'grid-cols-[34px_minmax(170px,2fr)_minmax(100px,1.3fr)_56px_52px_24px] max-phone:grid-cols-[24px_minmax(0,1fr)_24px]',
  plain:
    'grid-cols-[minmax(170px,2fr)_minmax(100px,1.3fr)_56px_52px_24px] max-phone:grid-cols-[minmax(0,1fr)_24px]',
}

export function TrackList({
  tracks,
  source,
  numbering = 'track',
  highlightId = '',
  removing = false,
  onRemove,
  table: tableView = false,
  detail = false,
  thirdColumn = 'album',
  thumbs = true,
}: {
  tracks: LibraryTrack[]
  source: string
  numbering?: TrackNumbering
  /** A song to mark as the playing one even where the queue did not start from this list. */
  highlightId?: string
  removing?: boolean
  onRemove?: (index: number) => void
  /** The Tracks view's table: a header row, a cover on each song and a plays column. */
  table?: boolean
  /** A collection page's list: the table's columns without its frame, under a ruled header. */
  detail?: boolean
  /** What the third column says: the song's album, or its genre on an album's own page. */
  thirdColumn?: 'album' | 'genre'
  /** Whether each song shows its own cover; an album's rows would all repeat the one cover. */
  thumbs?: boolean
}) {
  const table = tableView || detail
  const player = usePlayer()
  const room = useLayout() === 'room'
  const highlighted = highlightId ? tracks.findIndex((track) => track.id === highlightId) : -1
  const columns = numbering === 'none' ? tableColumns.plain : tableColumns.numbered
  return (
    <div
      className={cx(
        'library-tracks grid',
        tableView && !room && 'overflow-hidden rounded-[12px] border border-line',
        (tableView && room) || detail ? 'gap-[2px]' : '',
      )}
    >
      {table && (
        <div
          aria-hidden="true"
          className={cx(
            'flex items-center pr-[46px] text-faint max-phone:hidden',
            detail
              ? 'mb-[4px] border-b border-line pb-[8px] font-mono text-caption tracking-[0.6px]'
              : room
                ? 'pb-[8px] font-mono text-caption tracking-[0.6px]'
                : 'bg-sunken py-[10px] text-tiny font-semibold tracking-[0.5px]',
          )}
        >
          <span className={cx('grid w-full items-center gap-[12px] px-[12px]', columns)}>
            {numbering !== 'none' && <span className="text-right">#</span>}
            <span>TITLE</span>
            <span>{thirdColumn === 'genre' ? 'GENRE' : 'ALBUM'}</span>
            <span className="text-right">PLAYS</span>
            <span className="text-right">TIME</span>
            <span />
          </span>
        </div>
      )}
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
            className={cx(
              'library-track-row flex items-center',
              (table && room) || detail ? 'rounded-[10px]' : 'border-b border-line',
              tableView && !room && 'last:border-b-0',
              table && marked && 'bg-accent/10',
            )}
            key={`${track.id}-${index}`}
          >
            <button
              ref={index === highlighted ? showRow : undefined}
              aria-current={marked ? 'true' : undefined}
              className={cx(
                'library-track-play grid w-full items-center gap-[12px] rounded-md border-0 px-[12px] text-left text-inherit hover:bg-hover coarse:min-h-11',
                table ? `py-[8px] ${columns}` : 'py-[10px]',
                !table &&
                  (numbering === 'none'
                    ? 'grid-cols-[minmax(170px,2fr)_minmax(100px,1fr)_52px_24px] max-phone:grid-cols-[minmax(0,1fr)_24px]'
                    : 'grid-cols-[34px_minmax(170px,2fr)_minmax(100px,1fr)_52px_24px] max-phone:grid-cols-[24px_minmax(0,1fr)_24px]'),
                table && marked ? 'bg-transparent' : marked ? 'bg-hover' : 'bg-transparent',
              )}
              aria-label={`${playing ? 'Pause' : 'Play'} ${track.title}`}
              onClick={() =>
                current ? player.toggle() : player.playLibrary(tracks, index, source)
              }
            >
              {numbering !== 'none' && (
                <span
                  className={cx(
                    'text-small text-muted',
                    table && 'text-right',
                    table && (room || detail) && 'font-mono text-tiny',
                    table && marked && 'text-accent',
                  )}
                >
                  {numbering === 'position' ? index + 1 : (track.track ?? index + 1)}
                </span>
              )}
              <span className={cx('min-w-0', table ? 'flex items-center gap-[10px]' : 'grid')}>
                {table && thumbs && (
                  <span
                    className={cx(
                      'grid h-[36px] w-[36px] flex-none place-items-center overflow-hidden bg-raised text-faint',
                      room ? 'rounded-md' : 'rounded-[5px]',
                    )}
                  >
                    {track.coverArt ? (
                      <img
                        src={cover(track.coverArt)}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <Disc3 size={16} />
                    )}
                  </span>
                )}
                <span className="grid min-w-0 gap-[3px]">
                  <strong
                    className={cx(
                      table && 'text-body font-medium',
                      table && marked && 'text-accent',
                    )}
                  >
                    {track.title}
                  </strong>
                  <small className="text-small text-muted">{track.artist}</small>
                  {track.playbackWarning && (
                    <small className="text-small text-muted">{track.playbackWarning}</small>
                  )}
                </span>
              </span>
              {/* A long album name wraps to two lines and then stops, so it cannot stretch the row. */}
              <small
                className="line-clamp-2 min-w-0 text-small text-muted [overflow-wrap:anywhere] max-phone:hidden"
                title={track.album}
              >
                {thirdColumn === 'genre' ? track.genre : track.album}
              </small>
              {table && (
                <span
                  className={cx(
                    'text-right text-small text-faint max-phone:hidden',
                    (room || detail) && 'font-mono text-tiny',
                  )}
                >
                  {track.playCount.toLocaleString()}
                </span>
              )}
              <time
                className={cx(
                  'text-small text-muted max-phone:hidden',
                  table && 'text-right',
                  table && (room || detail) && 'font-mono text-tiny',
                )}
              >
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
