import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowDownToLine, Check, LoaderCircle } from 'lucide-react'
import { z } from 'zod'

import { api, jobSchema } from './api'
import type { MusicResult } from './api'
import { cx } from './cx'
import { activeJob, updateJob, useJobs } from './downloads'
import { Button, errorBannerClassName, IconButton } from './ui'

const batchSchema = z.object({
  id: z.string(),
  jobs: z.array(jobSchema),
  skipped_owned: z.number(),
  skipped_queued: z.number(),
})

export function AlbumDownloadButton({
  item,
  missingOnly = true,
  format,
  target,
  label,
  overlay = false,
}: {
  item: MusicResult
  missingOnly?: boolean
  format?: string
  target?: string
  label?: string
  /** The card variant: absolutely positioned over the art, hidden until the card is hovered. */
  overlay?: boolean
}) {
  const client = useQueryClient()
  const queue = useJobs()
  const queued = (queue.data?.jobs ?? []).filter(
    (job) => job.album_id === item.id && activeJob(job),
  ).length
  const complete = item.coverage_verified && item.ownership === 'owned'
  const checkingCoverage = !item.coverage_verified && item.ownership === 'owned'
  const download = useMutation({
    mutationFn: () =>
      api('batches', batchSchema, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          album_id: item.id,
          missing_only: missingOnly,
          format,
          ...(target ? { target } : {}),
        }),
      }),
    onSuccess: (batch) => {
      for (const job of batch.jobs) updateJob(client, job)
    },
  })
  const result = download.data
  const disabled = complete || checkingCoverage || download.isPending
  const ariaLabel = complete
    ? `Nothing to download for ${item.title}`
    : checkingCoverage
      ? `Checking coverage for ${item.title}`
      : missingOnly
        ? `Download missing tracks from ${item.title}`
        : `Download ${item.title}`
  const title = complete
    ? 'Already in your library'
    : missingOnly
      ? 'Download album, skipping tracks in your library'
      : 'Download every track on this album'
  const icon = download.isPending ? (
    <LoaderCircle size={18} className="spin" />
  ) : complete ? (
    <Check size={18} />
  ) : (
    <ArrowDownToLine size={18} />
  )
  return (
    <div
      className={cx(
        'album-card-download flex min-h-[36px] gap-[8px]',
        overlay
          ? 'absolute top-[18px] right-[18px] z-float max-w-[calc(100%-36px)] flex-col items-end'
          : 'relative items-center',
      )}
    >
      {label ? (
        <Button
          disabled={disabled}
          aria-label={ariaLabel}
          title={title}
          onClick={() => download.mutate()}
        >
          {icon}
          {label}
        </Button>
      ) : (
        <IconButton
          variant={overlay ? 'accent-washed' : 'accent'}
          className={cx(
            'min-h-[36px] min-w-[36px]',
            overlay &&
              'opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto no-hover:opacity-100 no-hover:pointer-events-auto',
          )}
          disabled={disabled}
          aria-label={ariaLabel}
          title={title}
          onClick={() => download.mutate()}
        >
          {icon}
        </IconButton>
      )}

      {(queued > 0 || result) && (
        <span role="status">
          <Link
            to="/downloads"
            className={cx(
              'album-download-status text-tiny coarse:inline-flex coarse:min-h-11 coarse:items-center',
              overlay && 'rounded-md bg-raised/96 p-[8px]',
            )}
          >
            {queued > 0
              ? `${queued} queued`
              : result?.jobs.length
                ? `${result.jobs.length} queued`
                : 'Nothing missing'}
            {result?.skipped_owned ? ` · ${result.skipped_owned} owned` : ''}
            {result?.skipped_queued ? ` · ${result.skipped_queued} queued` : ''}
          </Link>
        </span>
      )}

      {download.isError && (
        <span
          className={
            overlay
              ? 'download-error min-w-0 flex-1 rounded-md bg-raised/96 p-[8px] text-tiny [overflow-wrap:anywhere]'
              : errorBannerClassName('block', 'download-error')
          }
          role="alert"
        >
          {download.error.message}
          <button
            type="button"
            disabled={complete || download.isPending}
            onClick={() => download.mutate()}
          >
            Retry
          </button>
        </span>
      )}
    </div>
  )
}
