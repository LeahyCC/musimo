import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowDownToLine, Check, LoaderCircle } from 'lucide-react'
import { z } from 'zod'

import { api, jobSchema } from './api'
import type { MusicResult } from './api'
import { updateJob } from './downloads'

const batchSchema = z.object({ id: z.string(), jobs: z.array(jobSchema), skipped: z.number() })

export function AlbumDownloadButton({
  item,
  missingOnly = true,
  format,
  label,
}: {
  item: MusicResult
  missingOnly?: boolean
  format?: string
  label?: string
}) {
  const client = useQueryClient()
  const complete = item.coverage_verified && item.ownership === 'owned'
  const download = useMutation({
    mutationFn: () =>
      api('batches', batchSchema, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ album_id: item.id, missing_only: missingOnly, format }),
      }),
    onSuccess: (batch) => {
      for (const job of batch.jobs) updateJob(client, job)
    },
  })
  return (
    <div className="album-card-download">
      <button
        type="button"
        className={label ? 'button' : 'icon-button'}
        disabled={complete || download.isPending}
        aria-label={
          complete
            ? `${item.title} is in your library`
            : missingOnly
              ? `Download missing tracks from ${item.title}`
              : `Download ${item.title}`
        }
        title={
          complete
            ? 'Already in your library'
            : missingOnly
              ? 'Download album, skipping tracks in your library'
              : 'Download every track on this album'
        }
        onClick={() => download.mutate()}
      >
        {download.isPending ? (
          <LoaderCircle size={18} className="spin" />
        ) : complete ? (
          <Check size={18} />
        ) : (
          <ArrowDownToLine size={18} />
        )}
        {label}
      </button>

      {download.isSuccess && (
        <span role="status">
          <Link to="/downloads" className="album-download-status">
            {download.data.jobs.length ? `${download.data.jobs.length} queued` : 'Nothing missing'}
            {download.data.skipped > 0 ? ` · ${download.data.skipped} skipped` : ''}
          </Link>
        </span>
      )}

      {download.isError && (
        <span className="download-error" role="alert">
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
