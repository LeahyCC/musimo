import { useRef, useState } from 'react'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Disc3, ListMusic, X } from 'lucide-react'
import { z } from 'zod'

import { api, diagnosticsSchema, jobSchema, settingsSchema } from './api'
import { cx } from './cx'
import { activeJob, updateJob, useJobs } from './downloads'
import { Button, ErrorBanner, IconButton, textLinkClassName } from './ui'

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

const planSchema = z.object({
  albums: z.array(
    z.object({
      id: z.number(),
      title: z.string(),
      art: z.string(),
      year: z.string(),
      error: z.string(),
      tracks: z.array(
        z.object({
          id: z.number(),
          duration: z.number(),
          owned: z.boolean(),
          identity: z.string(),
        }),
      ),
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
  const [allMusic, setAllMusic] = useState(false)
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
    queryKey: ['artist-download-plan', artistId, allMusic],
    queryFn: ({ signal }) =>
      api(`artists/${artistId}/download-plan?all_music=${allMusic}`, planSchema, { signal }),
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
  const seen = new Set<string>()
  const counts = new Map<number, number>()
  let songs = 0,
    owned = 0,
    queued = 0,
    seconds = 0
  for (const album of selected) {
    let count = 0
    for (const track of album.tracks) {
      if (seen.has(track.identity)) continue
      seen.add(track.identity)
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
          all_music: allMusic,
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
      <div
        className="mt-[14px] flex flex-wrap gap-[8px]"
        role="group"
        aria-label={`Download ${name}`}
      >
        {(
          [
            [false, Disc3, 'Albums only'],
            [true, ListMusic, 'All music'],
          ] as const
        ).map(([includeAll, Icon, label]) => (
          <button
            type="button"
            className={cx(
              'inline-grid min-h-11 grid-cols-[30px_auto] items-center gap-[9px] rounded-[8px] border border-line-strong bg-sunken pt-[7px] pr-[13px] pb-[7px] pl-[7px] text-text',
              'hover:bg-hover hover:border-[color:var(--line-hover)]',
              '[&>svg]:box-border [&>svg]:h-[30px] [&>svg]:w-[30px] [&>svg]:rounded-md [&>svg]:bg-active [&>svg]:p-[7px] [&>svg]:text-accent',
              '[&>span]:grid [&>span]:gap-[3px] [&>span]:text-left [&>span]:text-small [&>span]:leading-none [&>span]:font-semibold',
              '[&_small]:font-medium [&_small]:tracking-[0.12em] [&_small]:text-caption [&_small]:text-muted [&_small]:uppercase',
            )}
            aria-label={includeAll ? 'Download all music' : 'Download all albums'}
            key={label}
            onClick={() => {
              download.reset()
              setExcluded(new Set())
              setAllMusic(includeAll)
              setOpened(true)
              dialog.current?.showModal()
            }}
          >
            <Icon aria-hidden="true" />
            <span>
              <small>Download</small>
              {label}
            </span>
          </button>
        ))}
      </div>
      <dialog
        ref={dialog}
        className={cx(
          'm-auto w-[min(700px,calc(100%-32px))] max-h-[85dvh] overscroll-contain rounded-[16px] border border-line bg-raised p-[24px] text-text',
          'backdrop:bg-scrim/60',
          'max-phone:inset-x-0 max-phone:top-auto max-phone:bottom-0 max-phone:m-0 max-phone:w-full max-phone:max-w-none max-phone:max-h-[calc(100dvh-24px)] max-phone:rounded-t-[18px] max-phone:rounded-b-none max-phone:border-b-0 max-phone:p-[16px] max-phone:pb-[calc(16px+var(--safe-bottom))]',
        )}
        aria-labelledby="artist-download-title"
        onClose={() => setOpened(false)}
      >
        <header className="mb-[18px] flex items-start justify-between gap-[20px] max-phone:mb-[12px] max-phone:gap-[12px]">
          <div>
            <p className="mb-[12px] text-micro font-semibold tracking-[2px] text-faint max-phone:text-caption">
              {name}
            </p>
            <h2 id="artist-download-title" className="max-phone:text-section">
              {allMusic ? 'Choose music to download' : 'Choose albums to download'}
            </h2>
          </div>
          <IconButton
            aria-label="Close download selection"
            disabled={download.isPending}
            onClick={() => dialog.current?.close()}
          >
            <X size={22} />
          </IconButton>
        </header>
        {plan.isFetching && <p role="status">Checking all albums and songs in your library…</p>}
        {plan.isError && (
          <ErrorBanner role="alert">
            {plan.error.message}
            <button onClick={() => void plan.refetch()}>Retry</button>
          </ErrorBanner>
        )}
        {plan.data && (
          <>
            <div
              className="my-[16px] grid gap-[8px] rounded-[10px] bg-good-bg p-[18px] max-phone:p-[14px]"
              aria-live="polite"
            >
              <strong className="text-[24px] max-phone:text-[20px]">
                {plural(albumCount, allMusic ? 'release' : 'album')} · {plural(songs, 'song')}
              </strong>
              <span className="text-small text-muted">
                About {megabytes.toLocaleString()} MB · estimated at{' '}
                {chosenFormat === 'mp3' ? 320 : 160} kbps
              </span>
              <small className="text-small text-muted">
                {plural(owned, 'song')} already in library · {queued} already queued
              </small>
            </div>
            <div className="flex flex-wrap items-center gap-[16px] text-body max-phone:gap-[10px_16px]">
              <label className="flex max-w-full min-w-0 items-center gap-[8px] coarse:min-h-11">
                <input
                  type="checkbox"
                  className="accent-accent coarse:h-[20px] coarse:w-[20px]"
                  checked={missingOnly}
                  disabled={download.isPending}
                  onChange={(e) => setMissingOnly(e.target.checked)}
                />
                Skip songs already in my library
              </label>
              <label className="flex max-w-full min-w-0 items-center gap-[8px] coarse:min-h-11">
                Format
                <select
                  className="min-w-0 max-w-full rounded-md border border-line bg-canvas p-[8px] text-inherit coarse:min-h-11 coarse:text-[16px]"
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
              <label className="flex max-w-full min-w-0 items-center gap-[8px] coarse:min-h-11">
                Download to
                <select
                  className="min-w-0 max-w-full rounded-md border border-line bg-canvas p-[8px] text-inherit coarse:min-h-11 coarse:text-[16px]"
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
            <p className="text-small text-muted">
              {allMusic
                ? 'Includes every release type and alternative edition. Uncheck releases you don’t want.'
                : 'Includes albums and alternative editions. Singles and EPs are excluded. Uncheck editions you don’t want.'}
            </p>
            {albums.some((album) => album.error) && (
              <ErrorBanner>
                Some albums could not be checked and are excluded.{' '}
                <button disabled={plan.isFetching} onClick={() => void plan.refetch()}>
                  Retry album checks
                </button>
              </ErrorBanner>
            )}
            <div className="flex flex-wrap items-center gap-[16px]">
              <button
                type="button"
                data-ui="text-link"
                className={textLinkClassName()}
                disabled={download.isPending}
                onClick={() => setExcluded(new Set())}
              >
                Select all
              </button>
              <button
                type="button"
                data-ui="text-link"
                className={textLinkClassName()}
                disabled={download.isPending}
                onClick={() => setExcluded(new Set(albums.map((album) => album.id)))}
              >
                Select none
              </button>
            </div>
            <fieldset className="my-[14px] min-w-0 border-0 p-0" disabled={download.isPending}>
              <legend className="sr-only">Albums</legend>
              {albums.map((album) => (
                <label
                  key={album.id}
                  className="flex cursor-pointer items-center gap-[12px] border-b border-line py-[12px]"
                >
                  <input
                    type="checkbox"
                    className="accent-accent coarse:h-[20px] coarse:w-[20px]"
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
                  {album.art && (
                    <img
                      src={album.art}
                      alt=""
                      loading="lazy"
                      className="h-[44px] w-[44px] rounded-md"
                    />
                  )}
                  <span className="grid min-w-0 gap-[6px]">
                    <strong className="text-body">{album.title}</strong>
                    <small className="text-tiny text-muted">
                      {album.year}
                      {album.error
                        ? ` · ${album.error}`
                        : ` · ${counts.get(album.id) ?? 0} of ${album.tracks.length} songs to download`}
                    </small>
                  </span>
                </label>
              ))}
            </fieldset>
            {!albums.length && (
              <p>No {allMusic ? 'releases' : 'albums'} found in this artist’s catalog.</p>
            )}
          </>
        )}
        <footer className="sticky bottom-[-24px] border-t border-line bg-raised py-[16px] before:pointer-events-none before:absolute before:-top-[29px] before:inset-x-0 before:h-[28px] before:bg-[linear-gradient(transparent,var(--color-raised))] before:content-[''] max-phone:bottom-[calc(-16px-var(--safe-bottom))] max-phone:pb-[calc(16px+var(--safe-bottom))]">
          {download.isSuccess ? (
            <p role="status">
              {download.data.jobs.length} songs queued from {download.data.albums}{' '}
              {allMusic ? 'releases' : 'albums'}.{' '}
              <Link to="/downloads" onClick={() => dialog.current?.close()}>
                Open downloads
              </Link>
            </p>
          ) : (
            <Button
              variant="primary"
              disabled={
                !songs || plan.isFetching || plan.isError || download.isPending || !chosenTarget
              }
              onClick={() => download.mutate()}
            >
              {download.isPending
                ? `Adding ${allMusic ? 'music' : 'albums'}…`
                : `Download ${plural(albumCount, allMusic ? 'release' : 'album')} (${plural(songs, 'song')})`}
            </Button>
          )}
          {download.isError && <ErrorBanner role="alert">{download.error.message}</ErrorBanner>}
        </footer>
      </dialog>
    </>
  )
}
