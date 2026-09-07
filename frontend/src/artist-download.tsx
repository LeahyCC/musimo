import { useRef, useState } from 'react'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowDownToLine, X } from 'lucide-react'
import { z } from 'zod'

import { api, diagnosticsSchema, jobSchema, settingsSchema } from './api'
import { activeJob, updateJob, useJobs } from './downloads'

const planSchema = z.object({
  albums: z.array(
    z.object({
      id: z.number(),
      title: z.string(),
      art: z.string(),
      year: z.string(),
      error: z.string(),
      tracks: z.array(z.object({ id: z.number(), duration: z.number(), owned: z.boolean() })),
    }),
  ),
})
const batchSchema = z.object({
  id: z.string(),
  jobs: z.array(jobSchema),
  albums: z.number(),
  skipped_owned: z.number(),
  skipped_queued: z.number(),
})

export function ArtistDownloadButton({ artistId, name }: { artistId: number; name: string }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const client = useQueryClient()
  const [opened, setOpened] = useState(false)
  const [excluded, setExcluded] = useState<Set<number>>(new Set())
  const [missingOnly, setMissingOnly] = useState(true)
  const [format, setFormat] = useState('')
  const [target, setTarget] = useState('')
  const queue = useJobs()
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: ({ signal }) => api('settings', settingsSchema, { signal }),
  })
  const mounts = useQuery({
    queryKey: ['diagnostics'],
    queryFn: ({ signal }) => api('diagnostics', diagnosticsSchema, { signal }),
    enabled: opened,
  })
  const plan = useQuery({
    queryKey: ['artist-download-plan', artistId],
    queryFn: ({ signal }) => api(`artists/${artistId}/download-plan`, planSchema, { signal }),
    enabled: opened,
    staleTime: 0,
    retry: false,
  })
  const chosenFormat = format || settings.data?.output_format.value || 'original'
  const chosenTarget = target || settings.data?.destination.value || ''
  const active = new Set(
    (queue.data?.jobs ?? [])
      .filter((job) => activeJob(job) && job.format === chosenFormat && job.target === chosenTarget)
      .map((job) => job.track_id),
  )
  const albums = plan.data?.albums ?? []
  const selected = albums.filter((album) => !album.error && !excluded.has(album.id))
  const seen = new Set<number>()
  const counts = new Map<number, number>()
  let songs = 0,
    owned = 0,
    queued = 0,
    seconds = 0
  for (const album of selected) {
    let count = 0
    for (const track of album.tracks) {
      if (seen.has(track.id)) continue
      seen.add(track.id)
      if (missingOnly && track.owned) owned++
      else if (active.has(track.id)) queued++
      else {
        count++
        songs++
        seconds += track.duration
      }
    }
    counts.set(album.id, count)
  }
  const albumCount = [...counts.values()].filter((count) => count > 0).length
  const megabytes = Math.ceil((seconds * (chosenFormat === 'mp3' ? 320 : 160)) / 8 / 1024)
  const download = useMutation({
    mutationFn: () =>
      api('artist-batches', batchSchema, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artist_id: artistId,
          album_ids: selected.map((album) => album.id),
          missing_only: missingOnly,
          format: chosenFormat,
          target: chosenTarget,
        }),
      }),
    onSuccess: (batch) => {
      for (const job of batch.jobs) updateJob(client, job)
    },
  })
  return (
    <>
      <button
        className="button primary"
        onClick={() => {
          download.reset()
          setOpened(true)
          dialog.current?.showModal()
        }}
      >
        <ArrowDownToLine size={17} />
        Download all albums
      </button>
      <dialog
        ref={dialog}
        className="artist-download-sheet"
        aria-labelledby="artist-download-title"
        onClose={() => setOpened(false)}
      >
        <header>
          <div>
            <p className="eyebrow">{name}</p>
            <h2 id="artist-download-title">Choose albums to download</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Close album selection"
            disabled={download.isPending}
            onClick={() => dialog.current?.close()}
          >
            <X size={22} />
          </button>
        </header>
        {plan.isFetching && <p role="status">Checking all albums and songs in your library…</p>}
        {plan.isError && (
          <p className="error" role="alert">
            {plan.error.message}
            <button onClick={() => void plan.refetch()}>Retry</button>
          </p>
        )}
        {plan.data && (
          <>
            <div className="artist-download-stats" aria-live="polite">
              <strong>
                {albumCount} albums · {songs} songs
              </strong>
              <span>
                About {megabytes.toLocaleString()} MB · estimated at{' '}
                {chosenFormat === 'mp3' ? 320 : 160} kbps
              </span>
              <small>
                {owned} songs already in library · {queued} already queued
              </small>
            </div>
            <div className="artist-download-options">
              <label>
                <input
                  type="checkbox"
                  checked={missingOnly}
                  disabled={download.isPending}
                  onChange={(e) => setMissingOnly(e.target.checked)}
                />
                Skip songs already in my library
              </label>
              <label>
                Format
                <select
                  value={chosenFormat}
                  disabled={download.isPending}
                  onChange={(e) => setFormat(e.target.value)}
                >
                  <option value="original">Original source quality</option>
                  <option value="m4a">M4A / AAC</option>
                  <option value="opus">Opus</option>
                  <option value="mp3">MP3 · converted</option>
                </select>
              </label>
              <label>
                Download to
                <select
                  value={chosenTarget}
                  disabled={download.isPending}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  {mounts.data?.disks.slice(1).map((disk) => (
                    <option key={disk.path} value={disk.path} disabled={!disk.writable}>
                      {disk.path}
                      {disk.writable ? '' : ' (read-only)'}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="small muted">
              Includes albums and alternative editions. Singles and EPs are excluded. Uncheck
              editions you don’t want.
            </p>
            {albums.some((album) => album.error) && (
              <p className="error">
                Some albums could not be checked and are excluded.{' '}
                <button disabled={plan.isFetching} onClick={() => void plan.refetch()}>
                  Retry album checks
                </button>
              </p>
            )}
            <div className="button-row">
              <button
                className="text-link"
                disabled={download.isPending}
                onClick={() => setExcluded(new Set())}
              >
                Select all
              </button>
              <button
                className="text-link"
                disabled={download.isPending}
                onClick={() => setExcluded(new Set(albums.map((album) => album.id)))}
              >
                Select none
              </button>
            </div>
            <fieldset className="artist-album-selection" disabled={download.isPending}>
              <legend className="sr-only">Albums</legend>
              {albums.map((album) => (
                <label key={album.id}>
                  <input
                    type="checkbox"
                    checked={!album.error && !excluded.has(album.id)}
                    disabled={Boolean(album.error)}
                    onChange={(e) =>
                      setExcluded((current) => {
                        const next = new Set(current)
                        if (e.target.checked) next.delete(album.id)
                        else next.add(album.id)
                        return next
                      })
                    }
                  />
                  {album.art && <img src={album.art} alt="" loading="lazy" />}
                  <span>
                    <strong>{album.title}</strong>
                    <small>
                      {album.year}
                      {album.error
                        ? ` · ${album.error}`
                        : ` · ${counts.get(album.id) ?? 0} of ${album.tracks.length} songs to download`}
                    </small>
                  </span>
                </label>
              ))}
            </fieldset>
            {!albums.length && <p>No albums found in this artist’s catalog.</p>}
          </>
        )}
        <footer>
          {download.isSuccess ? (
            <p role="status">
              {download.data.jobs.length} songs queued from {download.data.albums} albums.{' '}
              <Link to="/downloads" onClick={() => dialog.current?.close()}>
                Open downloads
              </Link>
            </p>
          ) : (
            <button
              className="button primary"
              disabled={
                !songs || plan.isFetching || plan.isError || download.isPending || !chosenTarget
              }
              onClick={() => download.mutate()}
            >
              {download.isPending
                ? 'Adding albums…'
                : `Download ${albumCount} albums (${songs} songs)`}
            </button>
          )}
          {download.isError && (
            <p className="error" role="alert">
              {download.error.message}
            </p>
          )}
        </footer>
      </dialog>
    </>
  )
}
