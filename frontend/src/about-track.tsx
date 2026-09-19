import { Fragment, type ReactNode, useState } from 'react'

import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'

import { api, libraryAlbumDetailSchema, libraryArtistDetailSchema, songDetailSchema } from './api'
import type { LibraryTrack } from './api'
import { cx } from './cx'
import { durationText } from './player'
import { relativeTime } from './relative-time'
import {
  fileRows,
  fileSummary,
  isLowQualityLossy,
  otherAlbums,
  playedAt,
  releaseRows,
} from './track-info'
import { sectionCaptionClassName, textLinkClassName } from './ui'

/** The albums and songs listed under "More you own" stop here, so the tab stays a glance. */
const MORE_ALBUMS = 8
const MORE_SONGS = 10

/**
 * What Navidrome knows about one song. The About tab and the line under the artist share this key,
 * so opening the tab costs no second request. The details are a bonus: a failed read shows less,
 * never an error.
 */
function useSongDetail(id: string) {
  return useQuery({
    queryKey: ['player-song', id],
    queryFn: ({ signal }) =>
      api(`player/song/${encodeURIComponent(id)}`, songDetailSchema, { signal }),
    staleTime: 60_000,
    retry: false,
  })
}

/** "FLAC, 44.1 kHz, 1,012 kbps" under the artist line, or nothing while it is unknown. */
export function TrackFormatLine({ trackId }: { trackId: string }) {
  const song = useSongDetail(trackId).data
  const summary = song ? fileSummary(song) : ''
  return summary ? <p className="mt-[2px] text-small text-muted">{summary}</p> : null
}

type Fact = { label: string; value: ReactNode }

/** A titled list of label and value rows. With no rows it draws nothing, not even the title. */
function Facts({ title, rows }: { title: string; rows: Fact[] }) {
  if (!rows.length) return null
  return (
    <section className="mb-[22px] text-small">
      <h3 className={cx(sectionCaptionClassName, 'mb-[8px] uppercase')}>{title}</h3>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-[16px] gap-y-[6px]">
        {rows.map(({ label, value }) => (
          <Fragment key={label}>
            <dt className="text-muted">{label}</dt>
            <dd className="min-w-0 [overflow-wrap:anywhere]">{value}</dd>
          </Fragment>
        ))}
      </dl>
    </section>
  )
}

const quietLinkClassName = 'text-small text-muted underline hover:text-text'

/**
 * The file behind the track, where it sits in the world, how it has been listened to and what else
 * of this artist and album is in the library. Whatever Navidrome does not have is left out.
 */
export function AboutPanel({ track, visible }: { track: LibraryTrack; visible: boolean }) {
  // The tab's panel stays mounted while hidden, so nothing beyond the song reads until it shows.
  const song = useSongDetail(track.id)
  const album = useQuery({
    queryKey: ['library-album', track.albumId ?? ''],
    queryFn: ({ signal }) =>
      api(`library/albums/${encodeURIComponent(track.albumId ?? '')}`, libraryAlbumDetailSchema, {
        signal,
      }),
    enabled: visible && Boolean(track.albumId),
    retry: false,
  })
  const artist = useQuery({
    queryKey: ['library-artist', track.artistId ?? ''],
    queryFn: ({ signal }) =>
      api(
        `library/artists/${encodeURIComponent(track.artistId ?? '')}`,
        libraryArtistDetailSchema,
        { signal },
      ),
    enabled: visible && Boolean(track.artistId),
    retry: false,
  })
  // Fixed for as long as this track is showing, the panel being keyed by the track.
  const [now] = useState(() => Date.now())

  const detail = song.data
  const labels = (album.data?.recordLabels ?? []).map((label) => label.name.trim()).filter(Boolean)
  const lastPlayed = detail ? playedAt(detail) : undefined
  const plays = detail?.playCount ?? 0
  const listening: Fact[] = [
    ...(plays > 0 ? [{ label: 'Plays', value: String(plays) }] : []),
    ...(lastPlayed === undefined
      ? []
      : [
          {
            label: 'Last played',
            value: (
              <time
                dateTime={new Date(lastPlayed).toISOString()}
                title={new Date(lastPlayed).toLocaleString()}
              >
                {relativeTime(lastPlayed, now)}
              </time>
            ),
          },
        ]),
  ]
  const file = detail ? fileRows(detail) : []
  const release = releaseRows(detail, track, labels)
  const moreAlbums = otherAlbums(artist.data?.album ?? [], track.albumId, MORE_ALBUMS)
  const restOfAlbum = (album.data?.song ?? []).filter((item) => item.id !== track.id)

  return (
    <>
      <Facts
        title="File"
        rows={file.map(({ label, value }) => ({
          label,
          value: label === 'Path' ? <code className="text-tiny">{value}</code> : value,
        }))}
      />
      {detail && isLowQualityLossy(detail) && (
        <p className="-mt-[10px] mb-[22px]">
          {/* Not a warning: a small file may be all that exists, or all that is wanted. */}
          <Link
            className={quietLinkClassName}
            to="/search"
            search={{ q: `${track.artist} ${track.title}` }}
          >
            Look for a better version
          </Link>
        </p>
      )}
      <Facts title="Release" rows={release} />
      <Facts title="Listening" rows={listening} />
      {(moreAlbums.length > 0 || restOfAlbum.length > 0) && (
        <section className="mb-[22px]">
          <h3 className={cx(sectionCaptionClassName, 'mb-[8px] uppercase')}>More you own</h3>
          {moreAlbums.length > 0 && (
            <div className="mb-[14px]">
              <h4 className="mb-[4px] text-small text-muted">More by {track.artist}</h4>
              <ul className="grid gap-[2px]">
                {moreAlbums.map((item) => (
                  <li key={item.id}>
                    <Link
                      className="flex items-baseline justify-between gap-[12px] rounded-md py-[4px] text-small hover:underline coarse:min-h-11 coarse:items-center"
                      to="/library/albums/$albumId"
                      params={{ albumId: item.id }}
                    >
                      <span className="min-w-0 truncate">{item.name}</span>
                      {item.year ? (
                        <span className="text-muted tabular-nums">{item.year}</span>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {restOfAlbum.length > 0 && track.albumId && (
            <div>
              <div className="mb-[4px] flex items-baseline justify-between gap-[12px]">
                <h4 className="min-w-0 truncate text-small text-muted">Rest of {track.album}</h4>
                {/* The track in the link is what the album page marks as playing. */}
                <Link
                  className={textLinkClassName()}
                  to="/library/albums/$albumId"
                  params={{ albumId: track.albumId }}
                  search={{ track: track.id }}
                >
                  Open album
                </Link>
              </div>
              <ul className="grid gap-[2px] text-small">
                {restOfAlbum.slice(0, MORE_SONGS).map((item, index) => (
                  <li key={`${item.id}-${index}`} className="flex items-baseline gap-[10px]">
                    <span className="w-[3ch] shrink-0 text-right text-muted tabular-nums">
                      {item.track ?? ''}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    <span className="text-muted tabular-nums">{durationText(item.duration)}</span>
                  </li>
                ))}
              </ul>
              {restOfAlbum.length > MORE_SONGS && (
                <p className="mt-[4px] text-small text-muted">
                  and {restOfAlbum.length - MORE_SONGS} more
                </p>
              )}
            </div>
          )}
        </section>
      )}
    </>
  )
}
