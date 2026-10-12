import { useState } from 'react'

import { useQuery } from '@tanstack/react-query'
import { Link, useParams, useRouterState } from '@tanstack/react-router'

import { albumSchema, api, settingsSchema } from '../../api'
import { ErrorBanner, FieldSelect } from '../../ui'
import { AlbumDownloadButton } from '../downloads/album-download'
import { DownloadTarget } from '../downloads/download-target'
import { durationText } from '../player/player'
import { Art, BackToSearch, Badge, CatalogTrackList } from './results'

export function AlbumPage() {
  const { albumId } = useParams({ from: '/albums/$albumId' })
  const focusTrack = useRouterState({
    select: (state) =>
      Number(new URLSearchParams(state.location.searchStr).get('track')) || undefined,
  })
  const query = useQuery({
    queryKey: ['album', Number(albumId)],
    queryFn: ({ signal }) => api(`albums/${albumId}`, albumSchema, { signal }),
    staleTime: 60_000,
  })
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: ({ signal }) => api('settings', settingsSchema, { signal }),
  })
  const [quality, setQuality] = useState<string | undefined>(undefined)
  const chosenQuality = quality ?? settings.data?.output_format.value ?? 'original'
  if (query.isError)
    return (
      <ErrorBanner role="alert">
        {query.error.message}
        <button onClick={() => void query.refetch()}>Retry</button>
      </ErrorBanner>
    )
  if (!query.data) return <p role="status">Loading album…</p>
  const { album, tracks, label, duration, complete } = query.data
  const editionCount = tracks.filter((track) => track.ownership === 'edition').length
  const missingCount = tracks.filter(
    (track) => track.ownership !== 'owned' && track.ownership !== 'edition',
  ).length
  const hasOwnedTracks = tracks.some(
    (track) => track.ownership === 'owned' || track.ownership === 'edition',
  )
  const bitrate = chosenQuality === 'mp3' ? 320 : 160
  return (
    <>
      <BackToSearch />
      <div className="mt-[24px] mb-[32px] flex items-center gap-[28px] max-phone:items-start max-phone:gap-[16px]">
        <Art item={album} className="w-[210px] max-phone:w-[95px]" />
        <div>
          <span className="text-micro font-semibold tracking-[2px] text-faint max-phone:text-caption">
            {album.record_type.toUpperCase()} · {album.year ?? 'Year unknown'}
          </span>
          <h1 className="my-[12px] max-phone:text-[24px]">{album.title}</h1>
          <Link to="/artists/$artistId" params={{ artistId: String(album.artist_id) }}>
            {album.artist}
          </Link>
          <p className="my-[15px] text-body">
            {label} · {album.track_count} tracks · {durationText(duration)} · ~
            {Math.round((duration * bitrate) / 8 / 1024)} MB estimated
          </p>
          <Badge item={album} />
        </div>
      </div>
      <div className="album-actions mb-[25px] flex flex-wrap items-center gap-[15px]">
        <label className="text-small text-muted">
          Quality{' '}
          <FieldSelect
            tone="sunken"
            fullWidth={false}
            value={chosenQuality}
            onChange={(e) => setQuality(e.target.value)}
          >
            <option value="original">Original</option>
            <option value="m4a">M4A</option>
            <option value="opus">Opus</option>
            <option value="mp3">MP3</option>
          </FieldSelect>
        </label>
        <AlbumDownloadButton
          key={`${album.id}-${hasOwnedTracks ? 'missing' : 'all'}`}
          item={album}
          missingOnly={hasOwnedTracks}
          format={chosenQuality}
          target={settings.data?.destination.value}
          label={
            hasOwnedTracks && missingCount > 0
              ? `Download missing (${missingCount})`
              : 'Download album'
          }
        />
        <small className="w-full text-muted">
          Size assumes {bitrate} kbps; actual source varies.
        </small>
        {editionCount > 0 && (
          <small className="w-full text-muted">
            {editionCount} track{editionCount === 1 ? ' has' : 's have'} another edition in your
            library
          </small>
        )}
        <DownloadTarget format={chosenQuality} />
      </div>
      {!complete && (
        <ErrorBanner>
          The catalog returned an incomplete track list. Coverage is partial.
        </ErrorBanner>
      )}
      <CatalogTrackList items={tracks} focusTrack={focusTrack} />
    </>
  )
}
