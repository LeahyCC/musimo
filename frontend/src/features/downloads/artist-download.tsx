import { useRef, useState } from 'react'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowDownToLine, Disc3, ListMusic } from 'lucide-react'
import { z } from 'zod'

import { api, diagnosticsSchema, jobSchema, settingsSchema } from '../../api'
import {
  FormatSelect,
  plural,
  ReviewDialog,
  ReviewOptions,
  ReviewRow,
  SelectAllNone,
  TargetSelect,
} from '../../components/review-sheet'
import { cx } from '../../lib/cx'
import { Button, ErrorBanner, Switch } from '../../ui'
import { DESTINATION_PROBLEM, destinationBroken, formatLabel } from './download-target'
import { activeJob, updateJob, useJobs } from './jobs'

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
  const brokenTarget = destinationBroken(mounts.data?.disks, chosenTarget)
  const active = new Set(
    (queue.data?.jobs ?? [])
      .filter((job) => activeJob(job) && job.format === chosenFormat && job.target === chosenTarget)
      .map((job) => job.track_id),
  )
  const albums = plan.data?.albums ?? []
  const selected = albums.filter((album) => !album.error && !excluded.has(album.id))
  const seen = new Set<string>()
  const counts = new Map<number, number>()
  const albumSeconds = new Map<number, number>()
  let songs = 0,
    owned = 0,
    queued = 0,
    seconds = 0
  for (const album of selected) {
    let count = 0
    let length = 0
    for (const track of album.tracks) {
      if (seen.has(track.identity)) continue
      seen.add(track.identity)
      if (missingOnly && track.owned) owned++
      else if (active.has(track.id)) queued++
      else {
        count++
        songs++
        length += track.duration
      }
    }
    counts.set(album.id, count)
    albumSeconds.set(album.id, length)
    seconds += length
  }
  const albumCount = [...counts.values()].filter((count) => count > 0).length
  const kbps = chosenFormat === 'mp3' ? 320 : 160
  const toMegabytes = (length: number) => Math.ceil((length * kbps) / 8 / 1024)
  const megabytes = toMegabytes(seconds)
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
      <ReviewDialog
        dialogRef={dialog}
        titleId="artist-download-title"
        eyebrow={name}
        title={allMusic ? 'Choose music to download' : 'Choose albums to download'}
        closeLabel="Close download selection"
        closeDisabled={download.isPending}
        onClose={() => setOpened(false)}
        footer={
          <>
            {brokenTarget && !download.isSuccess && (
              <ErrorBanner role="alert">{DESTINATION_PROBLEM}</ErrorBanner>
            )}
            {download.isError && <ErrorBanner role="alert">{download.error.message}</ErrorBanner>}
            {download.isSuccess ? (
              <p role="status" className="mr-auto">
                {download.data.jobs.length} songs queued from {download.data.albums}{' '}
                {allMusic ? 'releases' : 'albums'}.{' '}
                <Link to="/downloads" onClick={() => dialog.current?.close()}>
                  Open downloads
                </Link>
              </p>
            ) : (
              <>
                {plan.data && (
                  <div className="mr-auto min-w-[180px] flex-1" aria-live="polite">
                    <div className="font-semibold">
                      {plural(albumCount, allMusic ? 'release' : 'album')} · {plural(songs, 'song')}{' '}
                      · ~{megabytes.toLocaleString()} MB
                    </div>
                    <div className="mt-[2px] font-mono text-tiny text-faint uppercase [overflow-wrap:anywhere]">
                      → {chosenTarget || '(not set)'} · {formatLabel(chosenFormat)} · estimated
                    </div>
                  </div>
                )}
                <Button
                  variant="primary"
                  disabled={
                    !songs ||
                    plan.isFetching ||
                    plan.isError ||
                    download.isPending ||
                    !chosenTarget ||
                    brokenTarget
                  }
                  onClick={() => download.mutate()}
                >
                  <ArrowDownToLine size={15} aria-hidden="true" />
                  {download.isPending
                    ? `Adding ${allMusic ? 'music' : 'albums'}…`
                    : 'Queue downloads'}
                </Button>
              </>
            )}
          </>
        }
      >
        {plan.isFetching && <p role="status">Checking all albums and songs in your library…</p>}
        {plan.isError && (
          <ErrorBanner role="alert">
            {plan.error.message}
            <button onClick={() => void plan.refetch()}>Retry</button>
          </ErrorBanner>
        )}
        {plan.data && (
          <>
            <label className="flex cursor-pointer items-center gap-[12px] border-b border-line pb-[12px]">
              <span className="grid min-w-0 flex-1 gap-[2px]">
                <span className="font-medium">Skip songs already in my library</span>
                <span className="text-small text-muted">
                  Queued songs are always left out.{' '}
                  {allMusic
                    ? 'Every release type is included.'
                    : 'Singles and EPs are not included.'}
                </span>
              </span>
              <Switch
                checked={missingOnly}
                disabled={download.isPending}
                onChange={(e) => setMissingOnly(e.target.checked)}
              />
            </label>
            <div className="my-[12px]">
              <ReviewOptions>
                <FormatSelect
                  value={chosenFormat}
                  disabled={download.isPending}
                  onChange={setFormat}
                />
                <TargetSelect
                  value={chosenTarget}
                  disabled={download.isPending}
                  onChange={setTarget}
                  disks={mounts.data?.disks.slice(1) ?? []}
                />
              </ReviewOptions>
            </div>
            <p className="text-small text-muted">
              {plural(owned, 'song')} already in library · {queued} already queued.{' '}
              {allMusic
                ? 'Uncheck releases you don’t want.'
                : 'Alternative editions are included. Uncheck editions you don’t want.'}
            </p>
            {albums.some((album) => album.error) && (
              <ErrorBanner>
                Some albums could not be checked and are excluded.{' '}
                <button disabled={plan.isFetching} onClick={() => void plan.refetch()}>
                  Retry album checks
                </button>
              </ErrorBanner>
            )}
            <SelectAllNone
              disabled={download.isPending}
              onAll={() => setExcluded(new Set())}
              onNone={() => setExcluded(new Set(albums.map((album) => album.id)))}
            />
            <fieldset className="my-[14px] min-w-0 border-0 p-0" disabled={download.isPending}>
              <legend className="sr-only">Albums</legend>
              {albums.map((album) => (
                <ReviewRow
                  key={album.id}
                  checked={!album.error && !excluded.has(album.id)}
                  disabled={Boolean(album.error)}
                  onChange={(checked) =>
                    setExcluded((current) => {
                      const next = new Set(current)
                      if (checked) next.delete(album.id)
                      else next.add(album.id)
                      return next
                    })
                  }
                  art={album.art}
                  title={album.title}
                  detail={`${album.year}${
                    album.error
                      ? ` · ${album.error}`
                      : ` · ${counts.get(album.id) ?? 0} of ${album.tracks.length} songs to download`
                  }`}
                  badge={
                    <span className="shrink-0 font-mono text-tiny text-muted">
                      {albumSeconds.get(album.id)
                        ? `~${toMegabytes(albumSeconds.get(album.id) ?? 0).toLocaleString()} MB`
                        : '—'}
                    </span>
                  }
                />
              ))}
            </fieldset>
            {!albums.length && (
              <p>No {allMusic ? 'releases' : 'albums'} found in this artist’s catalog.</p>
            )}
          </>
        )}
      </ReviewDialog>
    </>
  )
}
