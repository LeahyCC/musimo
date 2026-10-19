import { useState } from 'react'

import { useQuery } from '@tanstack/react-query'
import { Link, useParams, useRouterState } from '@tanstack/react-router'
import { Pause, Play } from 'lucide-react'

import { albumSchema, api, settingsSchema } from '../../api'
import type { MusicResult } from '../../api'
import { Button, ErrorBanner, FieldSelect } from '../../ui'
import { AlbumDownloadButton } from '../downloads/album-download'
import { DownloadTarget } from '../downloads/download-target'
import { useJobs } from '../downloads/jobs'
import { canAccountPlay } from '../player/account-play'
import {
  durationText,
  useCollectionPlayback,
  usePlayer,
  usePreviewPlayback,
} from '../player/player'
import { CatalogHero, HeroDestination } from './catalog-hero'
import { queuedTrackIds, trackCoverage } from './coverage'
import { Art, BackToSearch, CatalogTrackList } from './results'

/** Play from the account when it is signed in, otherwise the first clip. */
function PreviewAlbum({ albumId, tracks }: { albumId: number; tracks: MusicResult[] }) {
  const player = usePlayer()
  const source = `album:${albumId}`
  const collection = useCollectionPlayback(source)
  const account = tracks.some((track) => canAccountPlay(track, player.listen))
  const first = tracks.find((track) => track.preview) ?? tracks[0]
  const playingPreview = usePreviewPlayback(first?.id ?? 0).playing
  if (!first) return null
  if (!account)
    return (
      <Button onClick={() => player.play(first)}>
        {playingPreview ? <Pause size={15} /> : <Play size={15} />}
        {playingPreview ? 'Pause preview' : 'Preview'}
      </Button>
    )
  const fetching = tracks.some((track) => player.fetchingId === track.id)
  return (
    <Button
      onClick={() =>
        collection.active ? player.toggle() : player.playCatalogFrom(tracks, 0, source)
      }
    >
      {collection.playing ? <Pause size={15} /> : <Play size={15} />}
      {collection.playing ? 'Pause' : fetching ? 'Fetching…' : 'Play'}
    </Button>
  )
}

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
  const queued = useJobs((data) => queuedTrackIds(data.jobs)).data
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
    <div className="[container-type:inline-size]">
      <BackToSearch />
      <CatalogHero
        cover={
          <Art
            item={album}
            rounded="rounded-[14px]"
            className="w-full shadow-[0_24px_50px_-24px_color-mix(in_oklab,var(--color-shadow)_80%,transparent)]"
          />
        }
        eyebrow={`${album.record_type} · ${album.year ?? 'Year unknown'}`}
        source="Deezer"
        title={album.title}
        byline={
          <Link to="/artists/$artistId" params={{ artistId: String(album.artist_id) }}>
            {album.artist}
          </Link>
        }
        meta={`${label} · ${album.track_count} tracks · ${durationText(duration)} · ~${Math.round((duration * bitrate) / 8 / 1024)} MB estimated`}
        coverage={trackCoverage(tracks, queued ?? new Set())}
        actions={
          <>
            <AlbumDownloadButton
              key={`${album.id}-${hasOwnedTracks ? 'missing' : 'all'}`}
              variant="primary"
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
            <PreviewAlbum albumId={album.id} tracks={tracks} />
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
            <HeroDestination>
              <DownloadTarget format={chosenQuality} />
            </HeroDestination>
            <small className="w-full text-faint">
              Size assumes {bitrate} kbps; actual source varies.
              {editionCount > 0 &&
                ` ${editionCount} track${editionCount === 1 ? ' has' : 's have'} another edition in your library.`}
            </small>
          </>
        }
      />
      {!complete && (
        <ErrorBanner>
          The catalog returned an incomplete track list. Coverage is partial.
        </ErrorBanner>
      )}
      <CatalogTrackList items={tracks} focusTrack={focusTrack} onAlbum />
      <p className="mt-[18px] border-t border-line pt-[14px] text-small text-faint">
        Track list from Deezer. Coverage is a file match against your library index, not proof of
        rights.
      </p>
    </div>
  )
}
