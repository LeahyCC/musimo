import { Fragment, useRef, useState } from 'react'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Disc3, Pause, Play, RotateCcw, Trash2, X } from 'lucide-react'

import { api, commandSchema, diagnosticsSchema, jobSchema, settingsSchema } from '../../api'
import type { DownloadJob } from '../../api'
import { cx } from '../../lib/cx'
import { formatBytes } from '../../lib/format'
import { Button, ErrorBanner, IconButton, textLinkClassName } from '../../ui'
import { catalogCardSource, formatLabel, pausedSources, siteLabel } from './download-target'
import type { CatalogSourceChoice } from './download-target'
import { listenHref } from './jobs'
import { activeJob, errorJob, failureMessage, unmatchedJob, updateJob } from './jobs'
import type { QueueData } from './jobs'

export function errorLink(fix: string): { href: string; text: string } | null {
  if (!fix) return null
  if (fix === 'retry') return null
  if (fix === 'card:pick') return null
  if (fix === 'report') return null
  if (fix.startsWith('settings:')) {
    const field = fix.slice(9)

    return { href: `/settings#${field}`, text: 'Open Settings' }
  }

  if (fix === 'diagnostics:disk') {
    return { href: '/diagnostics#disk', text: 'Check disk space' }
  }

  if (fix === 'diagnostics:sources') {
    return { href: '/diagnostics#sources', text: 'Check sources' }
  }

  return null
}

function useQueuedCatalogLabel(): {
  settings?: CatalogSourceChoice
  paused: string[]
  labels: Record<string, string>
} {
  const client = useQueryClient()
  // Read the cache the queue already filled. A card must not fetch settings, or a slow
  // reply would paint YouTube and then replace it.
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: ({ signal }) => api('settings', settingsSchema, { signal }),
    enabled: false,
  })
  const diagnostics = useQuery({
    queryKey: ['diagnostics'],
    queryFn: ({ signal }) => api('diagnostics', diagnosticsSchema, { signal }),
    enabled: false,
  })
  const queue = client.getQueryData<QueueData>(['jobs'])
  const data = settings.data
  const labels: Record<string, string> = { ...(queue?.controls.source_labels ?? {}) }
  for (const row of diagnostics.data?.download_sources ?? []) labels[row.id] = row.label
  return {
    settings: data
      ? {
          source_order: data.source_order.value,
          disabled_sources: data.disabled_sources.value,
          deezer_audio: data.deezer_audio.value,
          deezer_cookie: data.deezer_cookie.value,
        }
      : undefined,
    paused: pausedSources(queue?.controls).map((row) => row.source),
    labels,
  }
}

function JobCard({
  job,
  focusable = false,
  queuedLabel,
}: {
  job: DownloadJob
  focusable?: boolean
  queuedLabel: {
    settings?: CatalogSourceChoice
    paused: readonly string[]
    labels: Record<string, string>
  }
}) {
  const client = useQueryClient()
  const [copied, setCopied] = useState(false)
  const action = useMutation({
    mutationFn: (name: string) => api(`jobs/${job.id}/${name}`, jobSchema, { method: 'POST' }),
    onSuccess: (row) => updateJob(client, row),
  })
  const pick = useMutation({
    mutationFn: (id: string) =>
      api(`jobs/${job.id}/pick`, jobSchema, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidate_id: id }),
      }),
    onSuccess: (row) => updateJob(client, row),
  })
  const busy = action.isPending || pick.isPending
  const running = activeJob(job)
  const canPick = ['queued', 'paused', 'failed', 'cancelled', 'done'].includes(job.stage)
  const shown = catalogCardSource(job, queuedLabel.settings, queuedLabel.paused, queuedLabel.labels)
  const warningCount =
    job.warnings.length > 0
      ? ` · ${job.warnings.length} warning${job.warnings.length === 1 ? '' : 's'}`
      : ''
  const facts = [
    job.meta.artist,
    job.meta.album,
    (job.catalog === 'link' || job.catalog === 'deezer') && shown.source
      ? `from ${siteLabel(shown.source, shown.label)}`
      : '',
    job.catalog === 'deezer' && job.laps > 1 && job.lap > 0
      ? `pass ${job.lap} of ${job.laps}`
      : `${job.attempts} ${job.attempts === 1 ? 'attempt' : 'attempts'}`,
    formatLabel(job.format),
    job.target,
    job.stage === 'downloading'
      ? `${formatBytes(job.downloaded)}${job.total ? ` / ${formatBytes(job.total)}` : ''} · ${formatBytes(job.speed)}/s${
          job.eta !== null ? ` · ${Math.ceil(job.eta)}s left` : ''
        }`
      : '',
    // The done line counts warnings only. A note is not a problem and is shown as text below.
    job.stage === 'done' && job.codec
      ? `${job.codec} · ${Math.round(job.actual_bitrate / 1000)} kbps${warningCount}`
      : '',
  ].filter(Boolean)
  return (
    <article
      className={cx(
        // `job-card` is the hook the download specs locate cards by. The stage class is for them too.
        'job-card',
        job.stage,
        'min-w-0 rounded-md border border-line bg-hover px-[8px] py-[4px]',
      )}
      id={`job-${job.id}`}
      tabIndex={focusable ? 0 : -1}
    >
      <div className="flex items-center gap-[8px]">
        {job.meta.art ? (
          <img className="h-[22px] w-[22px] rounded-sm object-cover" src={job.meta.art} alt="" />
        ) : (
          <Disc3 size={16} />
        )}
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-small">{job.meta.title}</strong>
          {/* One line on a wide screen. A phone wraps it: cut to one line, the codec and the
              warning count at the end would be out of sight. */}
          <span className="block truncate text-tiny text-muted max-phone:whitespace-normal">
            {facts.map((fact, index) => (
              <Fragment key={index}>
                {index > 0 && ' · '}
                <span>{fact}</span>
              </Fragment>
            ))}
          </span>
        </div>
        <span className="text-tiny text-accent-hot uppercase">
          {job.stage.replaceAll('_', ' ')}
        </span>
        <div className="flex gap-[2px]">
          {running && !['paused', 'pausing', 'cancelling'].includes(job.stage) && (
            <IconButton
              variant="outlined"
              title="Pause"
              aria-label={`Pause ${job.meta.title}`}
              disabled={busy}
              onClick={() => action.mutate('pause')}
            >
              <Pause size={14} />
            </IconButton>
          )}
          {job.stage === 'paused' && (
            <IconButton
              variant="outlined"
              title="Resume"
              aria-label={`Resume ${job.meta.title}`}
              disabled={busy}
              onClick={() => action.mutate('resume')}
            >
              <Play size={14} />
            </IconButton>
          )}
          {running && (
            <IconButton
              variant="outlined"
              title="Cancel"
              aria-label={`Cancel ${job.meta.title}`}
              disabled={busy || job.stage === 'cancelling'}
              onClick={() => action.mutate('cancel')}
            >
              <X size={14} />
            </IconButton>
          )}
          {['failed', 'cancelled'].includes(job.stage) && (
            <IconButton
              variant="outlined"
              title="Retry"
              aria-label={`Retry ${job.meta.title}`}
              disabled={busy}
              onClick={() => action.mutate('retry')}
            >
              <RotateCcw size={14} />
            </IconButton>
          )}
          {!running && (
            <IconButton
              variant="outlined"
              title="Clear"
              aria-label={`Clear ${job.meta.title}`}
              disabled={busy}
              onClick={() => action.mutate('dismiss')}
            >
              <Trash2 size={14} />
            </IconButton>
          )}
        </div>
      </div>
      <div className="sr-only" aria-label={`Current stage: ${job.stage}`}>
        {[
          'queued',
          // Podcast episodes and pasted links download their own address, so they never match.
          ...(job.catalog === 'deezer' ? ['matching'] : []),
          'downloading',
          'converting',
          'tagging',
          'moving',
          'scanning',
          'done',
        ].map((stage) => (
          <span
            key={stage}
            className={job.stage === stage ? 'font-bold text-accent-hot' : undefined}
          >
            {stage}
          </span>
        ))}
      </div>
      {job.stage === 'downloading' && (
        <progress
          className="mt-[2px] h-[3px] w-full accent-accent-hot"
          aria-label={`${job.meta.title} download progress`}
          max={1}
          value={job.total ? job.progress : undefined}
        />
      )}
      {job.stage === 'retry_wait' && (
        <p className="text-small">
          Retry scheduled for {new Date(job.retry_at * 1000).toLocaleTimeString()}
        </p>
      )}
      {job.error && (
        <ErrorBanner role="alert">
          {job.error_hint || failureMessage(job)}{' '}
          {job.error_code && <small>({job.error_code})</small>}
          {job.error_fix &&
            (() => {
              const link = errorLink(job.error_fix)
              if (link) {
                const [to, hash] = link.href.split('#')
                return (
                  <>
                    {' '}
                    <Link to={to} hash={hash}>
                      {link.text}
                    </Link>
                  </>
                )
              }

              if (job.error_fix === 'report') {
                return <> Report this with the tool output below.</>
              }

              return null
            })()}
        </ErrorBanner>
      )}
      {job.check_match && (
        <p className="text-tiny text-warn">Check match: the selected recording needs a listen.</p>
      )}
      {job.notes.map((note, index) => (
        <p key={index} className="text-tiny text-muted">
          {note}
        </p>
      ))}
      {job.warnings.length > 0 && (
        <details className="text-tiny text-muted">
          <summary className="cursor-pointer">
            {job.warnings.length} metadata or scanning notes
          </summary>
          <ul>
            {job.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
      {(job.final_path || job.candidates.length > 0 || job.tool_tail) && (
        <details className="text-tiny text-muted">
          <summary className="cursor-pointer">
            {job.candidates.length > 0
              ? `Recording matches · ${
                  job.candidates
                    .find((candidate) => candidate.id === job.selected)
                    ?.score.toFixed(2) ?? 'unselected'
                }`
              : 'More'}
          </summary>
          {job.final_path && (
            <div className="my-[6px] flex items-center gap-[8px]">
              <code className="flex-1 [overflow-wrap:anywhere]">{job.final_path}</code>
              <button
                data-ui="text-link"
                className={textLinkClassName('shrink-0')}
                onClick={() => {
                  void navigator.clipboard
                    .writeText(job.final_path)
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false))
                }}
              >
                {copied ? 'Copied' : 'Copy path'}
              </button>
            </div>
          )}
          {job.candidates.length > 0 && !canPick && <p>Pause the job to change its recording.</p>}
          {job.candidates.map((candidate) => {
            const href = listenHref(candidate)
            return (
              <div
                className="flex items-center gap-[8px] border-b border-line py-[6px]"
                key={`${candidate.source}:${candidate.id}`}
              >
                <div className="min-w-0 flex-1">
                  <strong className="block truncate">{candidate.title}</strong>
                  <small className="block truncate">
                    {siteLabel(candidate.source, candidate.source_label)} · {candidate.artist} ·{' '}
                    {Math.round(candidate.score * 100)}% · {candidate.reason}
                  </small>
                </div>
                {href && (
                  <a
                    className="shrink-0 coarse:inline-flex coarse:min-h-11 coarse:items-center"
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Listen ↗
                  </a>
                )}
                <Button
                  disabled={!canPick || busy || candidate.id === job.selected}
                  onClick={() => pick.mutate(candidate.id)}
                >
                  {candidate.id === job.selected ? 'Selected' : 'Use this'}
                </Button>
              </div>
            )
          })}
          {job.tool_tail && (
            <pre className="whitespace-pre-wrap [overflow-wrap:anywhere]">
              yt-dlp {job.tool_version}
              {'\n'}
              {job.tool_tail}
            </pre>
          )}
        </details>
      )}
      {(action.isError || pick.isError) && (
        <ErrorBanner role="alert">{action.error?.message ?? pick.error?.message}</ErrorBanner>
      )}
    </article>
  )
}

export function JobList({ jobs }: { jobs: DownloadJob[] }) {
  const queuedLabel = useQueuedCatalogLabel()
  const parent = useRef<HTMLDivElement>(null)
  const [focusedIndex, setFocusedIndex] = useState(0)
  const virtual = useVirtualizer({
    count: jobs.length,
    getScrollElement: () => parent.current,
    // A first guess for cards not yet measured. Roughly the shortest a card gets, so the
    // scrollbar grows into place rather than shrinking back.
    estimateSize: () => 44,
    overscan: 3,
    // Cards differ in height and the queue reorders as jobs finish. Keying the measurement
    // cache by job keeps each height with its own card instead of with a list position.
    getItemKey: (index) => jobs[index]?.id ?? index,
  })
  const rows = virtual.getVirtualItems()

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (!jobs.length) return
    let newIndex = focusedIndex
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      newIndex = Math.min(focusedIndex + 1, jobs.length - 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      newIndex = Math.max(focusedIndex - 1, 0)
    } else if (event.key === 'Home') {
      event.preventDefault()
      newIndex = 0
    } else if (event.key === 'End') {
      event.preventDefault()
      newIndex = jobs.length - 1
    } else {
      return
    }
    setFocusedIndex(newIndex)
    if (jobs.length > 6) {
      virtual.scrollToIndex(newIndex, { align: 'center' })
    }
    requestAnimationFrame(() => {
      document.getElementById(`job-${jobs[newIndex]?.id}`)?.focus({ preventScroll: true })
    })
  }

  if (jobs.length <= 6)
    return (
      // A bare 1fr track has a min-content floor, so one long title widened the page.
      <div className="grid grid-cols-[minmax(0,1fr)] gap-[4px]" onKeyDown={handleKeyDown}>
        {jobs.map((job, index) => (
          <JobCard
            key={job.id}
            job={job}
            focusable={index === focusedIndex}
            queuedLabel={queuedLabel}
          />
        ))}
      </div>
    )
  return (
    <div
      ref={parent}
      className="virtual-list min-h-0 overflow-auto overscroll-contain contain-strict"
      role="region"
      aria-label="Download jobs"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
        {/* One offset for the window, then normal flow inside it. Positioning each card
            separately let a card sit on top of its neighbour whenever a measured height
            had not landed yet, which is what made the queue overlap as jobs moved up.
            The row separation is padding on the measured element, not a gap between them,
            so it counts towards the height the virtualizer works from. */}
        <div
          className="absolute top-0 left-0 w-full"
          style={{ transform: `translateY(${rows[0]?.start ?? 0}px)` }}
        >
          {rows.map((row) => {
            const job = jobs[row.index]
            return job ? (
              <div
                key={job.id}
                className="pb-[4px]"
                ref={virtual.measureElement}
                data-index={row.index}
              >
                <JobCard
                  job={job}
                  focusable={row.index === focusedIndex}
                  queuedLabel={queuedLabel}
                />
              </div>
            ) : null
          })}
        </div>
      </div>
    </div>
  )
}

export const batchName = (rows: DownloadJob[]) =>
  rows.find((job) => job.batch_label)?.batch_label ||
  rows.find((job) => job.meta.album)?.meta.album ||
  'Album download'

export function BatchSummary({ jobs }: { jobs: DownloadJob[] }) {
  const client = useQueryClient()
  const groups = jobs
    .filter((job) => job.batch_id)
    .reduce(
      (map, job) => map.set(job.batch_id, [...(map.get(job.batch_id) ?? []), job]),
      new Map<string, DownloadJob[]>(),
    )
  const action = useMutation({
    mutationFn: ({ id, command }: { id: string; command: string }) =>
      api(`batches/${id}/${command}`, commandSchema, { method: 'POST' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['jobs'] }),
  })
  return (
    <>
      {[...groups]
        .filter(([, rows]) => rows.some(activeJob))
        .map(([id, rows]) => (
          <div
            key={id}
            className="my-3 flex flex-wrap items-center gap-3 rounded-[8px] bg-active p-3 text-small"
          >
            <strong>{batchName(rows)}</strong>
            <span>
              {rows.filter((job) => job.stage === 'done').length}/{rows.length} complete
              {rows.some(unmatchedJob) ? ` · ${rows.filter(unmatchedJob).length} no match` : ''}
              {rows.some(errorJob) ? ` · ${rows.filter(errorJob).length} failed` : ''}
              {rows.some((job) => job.stage === 'cancelled')
                ? ` · ${rows.filter((job) => job.stage === 'cancelled').length} cancelled`
                : ''}
            </span>
            <progress
              max={rows.length}
              value={rows.reduce(
                (total, job) => total + (job.stage === 'done' ? 1 : job.progress),
                0,
              )}
              aria-label="Batch progress"
            />
            {['pause', 'resume', 'cancel'].map((command) => (
              <Button
                key={command}
                disabled={action.isPending}
                onClick={() => action.mutate({ id, command })}
              >
                {command === 'pause'
                  ? 'Pause group'
                  : command === 'resume'
                    ? 'Resume group'
                    : 'Cancel group'}
              </Button>
            ))}
          </div>
        ))}
      {action.isError && <ErrorBanner>{action.error.message}</ErrorBanner>}
    </>
  )
}
