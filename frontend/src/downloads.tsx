import { useId, useLayoutEffect, useRef, useState } from 'react'

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ArrowDownToLine,
  Check,
  ChevronUp,
  Disc3,
  MoreHorizontal,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react'
import { z } from 'zod'

import {
  api,
  commandSchema,
  diagnosticsSchema,
  historySchema,
  jobSchema,
  jobsSchema,
  settingsSchema,
} from './api'
import type { DownloadJob, MusicResult } from './api'
import { cx } from './cx'
import { formatLabel, FormatOptions, siteLabel } from './download-target'
import { InfiniteScroll } from './infinite-scroll'
import { PageTitle } from './page-title'
import {
  Button,
  buttonClassName,
  EmptyPanel,
  ErrorBanner,
  errorBannerClassName,
  Field,
  FieldSelect,
  IconButton,
  textLinkClassName,
} from './ui'

export type QueueData = {
  jobs: DownloadJob[]
  controls: { paused: boolean; source_paused: boolean; paused_sources: string[] }
  summary: {
    active: number
    failed: number
    failure_reasons: { code: string; message: string; count: number }[]
  }
}
export const activeJob = (job: DownloadJob) => !['done', 'failed', 'cancelled'].includes(job.stage)
export function updateJob(client: QueryClient, job: DownloadJob) {
  client.setQueryData<QueueData>(['jobs'], (old) => {
    const previous = old?.jobs.find((item) => item.id === job.id)
    if (previous && previous.updated_at > job.updated_at) return old
    const summary = {
      active: old?.summary.active ?? 0,
      failed: old?.summary.failed ?? 0,
      failure_reasons: [...(old?.summary.failure_reasons ?? [])],
    }
    // The server supplies totals beyond the 50 visible finished jobs. Adjust those totals as SSE
    // updates arrive so a large queue stays accurate without refetching after every completion.
    // The server counts only visible jobs, so a job being hidden has to leave the totals too.
    for (const [item, delta] of [
      [previous, -1],
      [job, 1],
    ] as const) {
      if (!item || item.hidden) continue
      if (activeJob(item)) summary.active = Math.max(0, summary.active + delta)
      if (item.stage !== 'failed') continue
      summary.failed = Math.max(0, summary.failed + delta)
      const index = summary.failure_reasons.findIndex(
        (reason) => reason.code === item.error_code && reason.message === item.error,
      )
      if (index >= 0) {
        const reason = summary.failure_reasons[index]
        if (reason) summary.failure_reasons[index] = { ...reason, count: reason.count + delta }
        if (summary.failure_reasons[index]?.count === 0) summary.failure_reasons.splice(index, 1)
      } else if (delta > 0) {
        summary.failure_reasons.push({ code: item.error_code, message: item.error, count: 1 })
      }
    }
    return {
      controls: old?.controls ?? { paused: false, source_paused: false, paused_sources: [] },
      summary,
      jobs: [job, ...(old?.jobs ?? []).filter((item) => item.id !== job.id)],
    }
  })
}

type Jobs = z.infer<typeof jobsSchema>
/** The queue; `select` narrows it so a caller re-renders only when its own slice changes. */
export function useJobs<T = Jobs>(select?: (data: Jobs) => T) {
  const client = useQueryClient()
  return useQuery({
    queryKey: ['jobs'],
    queryFn: async ({ signal }) => {
      const data = await api('jobs', jobsSchema, { signal })
      const live = client.getQueryData<QueueData>(['jobs'])
      const rows = new Map(data.jobs.map((job) => [job.id, job]))
      for (const job of live?.jobs ?? [])
        if ((rows.get(job.id)?.updated_at ?? 0) < job.updated_at) rows.set(job.id, job)
      return { ...data, jobs: [...rows.values()] }
    },
    staleTime: Infinity,
    select,
  })
}
export const activeCount = (data: QueueData) => data.jobs.filter(activeJob).length
const bytes = (value: number) =>
  value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${Math.round(value / 1024)} KB`

export const failureMessage = (job: Pick<DownloadJob, 'error_code' | 'error'>) =>
  job.error_code === 'NO_MATCH'
    ? 'No matching recording was found on YouTube. Nothing was downloaded.'
    : job.error || 'The download stopped without an error message.'

function errorLink(fix: string): { href: string; text: string } | null {
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

export function DownloadButton({ item, className }: { item: MusicResult; className?: string }) {
  const client = useQueryClient()
  const owned = item.ownership === 'owned'
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: ({ signal }) => api('settings', settingsSchema, { signal }),
  })
  const [format, setFormat] = useState<string>()
  const [target, setTarget] = useState('')
  const [options, setOptions] = useState(false)
  const optionsId = useId()
  const optionsButton = useRef<HTMLButtonElement>(null)
  const optionsPanel = useRef<HTMLDivElement>(null)
  const optionsAnchor = useRef<DOMRect | null>(null)
  useLayoutEffect(() => {
    const panel = optionsPanel.current
    const button = optionsButton.current
    if (!options || !panel || !button) return
    // Virtual rows create stacking and clipping boundaries. The native popover
    // escapes those boundaries; viewport coordinates keep it beside its trigger.
    const anchor = button.getBoundingClientRect()
    const gap = 8
    const below = window.innerHeight - anchor.bottom - gap
    const top =
      below < panel.offsetHeight && anchor.top > below
        ? anchor.top - panel.offsetHeight - gap
        : anchor.bottom + gap
    panel.style.top = `${Math.max(gap, Math.min(top, window.innerHeight - panel.offsetHeight - gap))}px`
    panel.style.left = `${Math.max(gap, Math.min(anchor.right - panel.offsetWidth, window.innerWidth - panel.offsetWidth - gap))}px`
    panel.querySelector('select')?.focus({ preventScroll: true })
  }, [options])

  useLayoutEffect(() => {
    const panel = optionsPanel.current
    if (!panel) return
    // Native toggle events are deferred; scrolling can happen before React sees
    // the open state, so dismissal must already be listening.
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && panel.contains(event.target)) return
      const anchor = optionsAnchor.current
      const current = optionsButton.current?.getBoundingClientRect()
      // Ignore a queued scroll event from bringing the trigger into view.
      if (
        event.type === 'scroll' &&
        anchor &&
        current &&
        anchor.top === current.top &&
        anchor.left === current.left
      )
        return
      if (panel.matches(':popover-open')) panel.hidePopover()
    }
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [])
  const mounts = useQuery({
    queryKey: ['diagnostics'],
    queryFn: ({ signal }) => api('diagnostics', diagnosticsSchema, { signal }),
    enabled: options,
  })
  const queue = useJobs()
  const selected = format ?? settings.data?.output_format.value ?? 'original'
  const existing = queue.data?.jobs.find(
    (job) =>
      job.catalog === 'deezer' &&
      job.track_id === item.id &&
      job.format === selected &&
      job.target === (target || settings.data?.destination.value) &&
      activeJob(job),
  )
  const failed = existing
    ? undefined
    : queue.data?.jobs.find(
        (job) =>
          job.catalog === 'deezer' &&
          job.track_id === item.id &&
          job.format === selected &&
          job.target === (target || settings.data?.destination.value) &&
          job.stage === 'failed',
      )
  const mutation = useMutation({
    mutationFn: () =>
      failed
        ? api(`jobs/${failed.id}/retry`, jobSchema, { method: 'POST' })
        : api('jobs', jobSchema, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              track_id: item.id,
              format: selected,
              ...(target ? { target } : {}),
            }),
          }),
    onSuccess: (job) => updateJob(client, job),
  })
  return (
    // The native option list takes the select's transparent background otherwise, which some
    // engines paint white under light text.
    <div className={cx('relative flex items-center gap-[6px] [&_option]:bg-raised', className)}>
      <select
        aria-label={`Format for ${item.title}`}
        className="max-w-[82px] rounded-md border border-line-strong bg-transparent px-[3px] py-[6px] text-tiny text-inherit coarse:max-w-[96px] coarse:px-[6px] coarse:py-3"
        value={selected}
        onChange={(e) => setFormat(e.target.value)}
      >
        <FormatOptions />
      </select>
      <IconButton
        aria-label={
          owned
            ? item.ownership === 'edition'
              ? `Another edition is in your library. Download ${item.title} to ${target || settings.data?.destination.value || '(not set)'} · ${formatLabel(selected)}`
              : `${item.title} is in your library`
            : existing
              ? `${item.title} is ${existing.stage}`
              : failed
                ? `Retry ${item.title}. ${failureMessage(failed)}`
                : `Download ${item.title} to ${target || settings.data?.destination.value || '(not set)'} · ${formatLabel(selected)}`
        }
        title={
          owned
            ? item.ownership === 'edition'
              ? 'Another edition is in your library'
              : 'Already in your library'
            : existing?.stage
              ? existing.stage
              : failed
                ? failureMessage(failed)
                : `to ${target || settings.data?.destination.value || '(not set)'} · ${formatLabel(selected)}`
        }
        disabled={
          (owned && item.ownership !== 'edition') || Boolean(existing) || mutation.isPending
        }
        onClick={() => mutation.mutate()}
      >
        {(owned && item.ownership !== 'edition') || existing ? (
          <Check size={17} />
        ) : failed ? (
          <RotateCcw size={17} />
        ) : (
          <ArrowDownToLine size={17} />
        )}
      </IconButton>
      <IconButton
        ref={optionsButton}
        aria-label={`Download options for ${item.title}`}
        aria-expanded={options}
        aria-haspopup="dialog"
        popoverTarget={optionsId}
        onClick={(event) => event.currentTarget.focus({ preventScroll: true })}
      >
        <MoreHorizontal size={16} />
      </IconButton>
      <div
        ref={optionsPanel}
        id={optionsId}
        className={cx(
          'fixed inset-auto m-0 w-[240px] max-w-[calc(100vw-16px)] max-h-[calc(100dvh-16px)] overflow-auto overscroll-contain rounded-[8px] border border-line-strong bg-raised p-[14px] text-inherit shadow-[0_8px_30px_color-mix(in_oklab,var(--color-shadow)_53%,transparent)]',
        )}
        popover="auto"
        role="dialog"
        aria-label={`Download options for ${item.title}`}
        onBeforeToggle={(event) => {
          if (event.newState === 'open')
            optionsAnchor.current = optionsButton.current?.getBoundingClientRect() ?? null
        }}
        onToggle={(event) => setOptions(event.newState === 'open')}
      >
        <label className="grid min-w-0 gap-[6px] text-small">
          Download to
          <select
            className="w-full min-w-0 max-w-full"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">{settings.data?.destination.value || '(not set)'}</option>
            {mounts.data?.disks
              .slice(1)
              .filter((disk) => disk.writable)
              .map((disk) => (
                <option key={disk.path} value={disk.path}>
                  {disk.path}
                </option>
              ))}
          </select>
        </label>
        {/* The same choice as the row's select; a phone hides that one to give the title room
            and shows this instead. It follows the destination so the focus rule above lands on
            the same control everywhere. */}
        <label className="mt-[10px] hidden min-w-0 gap-[6px] text-small max-phone:grid">
          Format
          <select
            className="w-full min-w-0 max-w-full"
            value={selected}
            onChange={(e) => setFormat(e.target.value)}
          >
            <FormatOptions />
          </select>
        </label>
        <small className="mt-[10px] block text-tiny leading-[1.5] text-muted">
          Original keeps source quality. Conversion does not improve it.
        </small>
      </div>
      {mutation.data?.stage === 'done' && (
        <span className={errorBannerClassName('block', 'mt-2')} role="status">
          Already downloaded. The existing file was kept.
        </span>
      )}
      {mutation.isError && (
        <span className={errorBannerClassName('block', 'mt-2')} role="alert">
          {mutation.error.message}
          <button
            disabled={owned || Boolean(existing) || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            Retry
          </button>
        </span>
      )}
    </div>
  )
}

function JobCard({ job, focusable = false }: { job: DownloadJob; focusable?: boolean }) {
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
  return (
    <article
      className={cx(
        // `job-card` is the hook the download specs locate cards by. The stage class is for them too.
        'job-card',
        job.stage,
        'min-w-0 rounded-lg border border-line bg-hover p-[18px]',
      )}
      id={`job-${job.id}`}
      tabIndex={focusable ? 0 : -1}
    >
      <div className="flex items-center gap-3 max-phone:flex-wrap">
        {job.meta.art ? (
          <img className="h-[42px] w-[42px] rounded-md object-cover" src={job.meta.art} alt="" />
        ) : (
          <Disc3 size={38} />
        )}
        <div className="min-w-0 flex-1 max-phone:min-w-[150px]">
          <strong className="block truncate">{job.meta.title}</strong>
          <span className="mt-[5px] block truncate text-small text-muted">
            {job.meta.artist} · {job.meta.album}
          </span>
        </div>
        <span className="text-tiny text-accent-hot uppercase">
          {job.stage.replaceAll('_', ' ')}
        </span>
        <div className="flex gap-[6px]">
          {running && !['paused', 'pausing', 'cancelling'].includes(job.stage) && (
            <IconButton
              variant="outlined"
              title="Pause"
              aria-label={`Pause ${job.meta.title}`}
              disabled={busy}
              onClick={() => action.mutate('pause')}
            >
              <Pause size={16} />
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
              <Play size={16} />
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
              <X size={16} />
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
              <RotateCcw size={16} />
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
              <Trash2 size={16} />
            </IconButton>
          )}
        </div>
      </div>
      <div
        className="mt-[15px] mb-[10px] flex flex-wrap gap-2 text-caption text-faint max-phone:gap-[6px]"
        aria-label={`Current stage: ${job.stage}`}
      >
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
          className="h-[5px] w-full accent-accent-hot"
          aria-label={`${job.meta.title} download progress`}
          max={1}
          value={job.total ? job.progress : undefined}
        />
      )}
      <div className="my-[10px] flex flex-wrap gap-4 text-tiny text-muted">
        {job.catalog === 'link' && <span>from {siteLabel(job.source)}</span>}
        <span>to {job.target}</span>
        <span>{formatLabel(job.format)}</span>
        {job.stage === 'downloading' && (
          <span>
            {bytes(job.downloaded)}
            {job.total ? ` / ${bytes(job.total)}` : ''} · {bytes(job.speed)}/s
            {job.eta !== null ? ` · ${Math.ceil(job.eta)}s left` : ''}
          </span>
        )}
        {job.stage === 'done' && (
          <span>
            {job.codec} · {Math.round(job.actual_bitrate / 1000)} kbps
            {job.warnings.length > 0 &&
              ` · ${job.warnings.length} warning${job.warnings.length === 1 ? '' : 's'}`}
          </span>
        )}
        <span>
          {job.attempts} {job.attempts === 1 ? 'attempt' : 'attempts'}
        </span>
      </div>
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
        <p className="text-small text-warn">Check match: the selected recording needs a listen.</p>
      )}
      {job.final_path && (
        <div className="my-3 flex items-center gap-3 text-tiny">
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
      {job.notes.map((note, index) => (
        <p key={index} className="mt-3 text-small text-muted">
          {note}
        </p>
      ))}
      {job.warnings.length > 0 && (
        <details className="mt-3 text-small text-muted">
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
      {job.candidates.length > 0 && (
        <details className="mt-3 text-small text-muted">
          <summary className="cursor-pointer">
            Recording matches ·{' '}
            {job.candidates.find((candidate) => candidate.id === job.selected)?.score.toFixed(2) ??
              'unselected'}
          </summary>
          {!canPick && <p className="text-small">Pause the job to change its recording.</p>}
          {job.candidates.map((candidate) => (
            <div
              className="flex items-center gap-3 border-b border-line py-3 max-phone:flex-wrap"
              key={candidate.id}
            >
              <div className="flex-1">
                <strong>{candidate.title}</strong>
                <small className="mt-[5px] block">
                  {candidate.artist} · {Math.round(candidate.score * 100)}% · {candidate.reason}
                </small>
              </div>
              <a
                className="coarse:inline-flex coarse:min-h-11 coarse:items-center"
                href={candidate.url || `https://www.youtube.com/watch?v=${candidate.id}`}
                target="_blank"
                rel="noreferrer"
              >
                Listen ↗
              </a>
              <Button
                disabled={!canPick || busy || candidate.id === job.selected}
                onClick={() => pick.mutate(candidate.id)}
              >
                {candidate.id === job.selected ? 'Selected' : 'Use this'}
              </Button>
            </div>
          ))}
        </details>
      )}
      {job.tool_tail && (
        <details className="mt-3 text-small text-muted">
          <summary className="cursor-pointer">Tool details · yt-dlp {job.tool_version}</summary>
          <pre className="whitespace-pre-wrap [overflow-wrap:anywhere]">{job.tool_tail}</pre>
        </details>
      )}
      {(action.isError || pick.isError) && (
        <ErrorBanner role="alert">{action.error?.message ?? pick.error?.message}</ErrorBanner>
      )}
    </article>
  )
}

function JobList({ jobs }: { jobs: DownloadJob[] }) {
  const parent = useRef<HTMLDivElement>(null)
  const [focusedIndex, setFocusedIndex] = useState(0)
  const virtual = useVirtualizer({
    count: jobs.length,
    getScrollElement: () => parent.current,
    // A first guess for cards not yet measured. Roughly the shortest a card gets, so the
    // scrollbar grows into place rather than shrinking back.
    estimateSize: () => 200,
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
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3" onKeyDown={handleKeyDown}>
        {jobs.map((job, index) => (
          <JobCard key={job.id} job={job} focusable={index === focusedIndex} />
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
                className="pb-3"
                ref={virtual.measureElement}
                data-index={row.index}
              >
                <JobCard job={job} focusable={row.index === focusedIndex} />
              </div>
            ) : null
          })}
        </div>
      </div>
    </div>
  )
}

const batchName = (rows: DownloadJob[]) =>
  rows.find((job) => job.batch_label)?.batch_label ||
  rows.find((job) => job.meta.album)?.meta.album ||
  'Album download'

function BatchSummary({ jobs }: { jobs: DownloadJob[] }) {
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
              {rows.some((job) => job.stage === 'failed')
                ? ` · ${rows.filter((job) => job.stage === 'failed').length} failed`
                : ''}
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

function QueueControls() {
  const client = useQueryClient()
  const queue = useJobs()
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: ({ signal }) => api('settings', settingsSchema, { signal }),
  })
  const concurrency = useMutation({
    mutationFn: (value: number) =>
      api('settings', settingsSchema, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ concurrency: value }),
      }),
    onSuccess: (data) => client.setQueryData(['settings'], data),
  })
  const command = useMutation({
    mutationFn: (action: string) => api(`queue/${action}`, commandSchema, { method: 'POST' }),
    onSuccess: (data) => {
      client.setQueryData<QueueData>(['jobs'], (old) => ({
        jobs: old?.jobs ?? [],
        controls: data.controls,
        summary: old?.summary ?? { active: 0, failed: 0, failure_reasons: [] },
      }))
      void client.invalidateQueries({ queryKey: ['jobs'] })
    },
  })
  const failed = queue.data?.summary.failed ?? 0
  // One line per paused site. A server that only sends the YouTube flag still gets its line.
  const controls = queue.data?.controls
  const pausedSources = controls?.paused_sources.length
    ? controls.paused_sources
    : controls?.source_paused
      ? ['youtube']
      : []
  return (
    <>
      <div className="my-4 flex flex-wrap gap-2 max-phone:grid max-phone:grid-cols-2">
        <label className="flex items-center gap-2 text-small max-phone:col-span-2">
          Parallel{' '}
          <FieldSelect
            aria-label="Parallel downloads"
            fullWidth={false}
            value={settings.data?.concurrency.value ?? 2}
            disabled={settings.data?.concurrency.locked || concurrency.isPending}
            onChange={(e) => concurrency.mutate(Number(e.target.value))}
          >
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </FieldSelect>
        </label>
        <Button
          className="max-phone:w-full max-phone:px-2"
          disabled={command.isPending}
          onClick={() => command.mutate(queue.data?.controls.paused ? 'resume' : 'pause')}
        >
          {queue.data?.controls.paused ? 'Resume all' : 'Pause all'}
        </Button>
        <Button
          className="max-phone:w-full max-phone:px-2"
          disabled={command.isPending}
          onClick={() => command.mutate('cancel-queued')}
        >
          Cancel queued
        </Button>
        <Button
          className="max-phone:w-full max-phone:px-2"
          disabled={command.isPending || failed === 0}
          onClick={() => command.mutate('retry-failed')}
        >
          Retry failed ({failed})
        </Button>
        <Button
          className="max-phone:w-full max-phone:px-2"
          disabled={command.isPending || failed === 0}
          onClick={() => command.mutate('clear-failed')}
        >
          Clear failed ({failed})
        </Button>
        <Button
          className="max-phone:w-full max-phone:px-2"
          disabled={command.isPending}
          onClick={() => command.mutate('clear-finished')}
          title="Remove done, failed, and cancelled jobs from the queue"
        >
          Clear all finished
        </Button>
      </div>
      {pausedSources.map((source) => (
        <ErrorBanner role="alert" key={source}>
          {siteLabel(source)} paused after repeated blocking errors.{' '}
          <Link to="/diagnostics">Check diagnostics</Link>
          <button
            onClick={() => command.mutate(`resume-source?source=${encodeURIComponent(source)}`)}
          >
            Try {siteLabel(source)} again
          </button>
        </ErrorBanner>
      ))}
      {(command.isError || Boolean(command.data?.errors.length)) && (
        <ErrorBanner role="alert">
          {command.error?.message ?? command.data?.errors.join(' · ')}
        </ErrorBanner>
      )}
    </>
  )
}

function History() {
  const [q, setQ] = useState(''),
    [from, setFrom] = useState(''),
    [until, setUntil] = useState('')
  const query = useInfiniteQuery({
    queryKey: ['history', q, from, until],
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) =>
      api(
        `history?${new URLSearchParams({ q, since: from ? String(new Date(from).getTime() / 1000) : '0', until: until ? String(new Date(until + 'T23:59:59').getTime() / 1000) : '1000000000000', offset: String(pageParam) })}`,
        historySchema,
        { signal },
      ),
    getNextPageParam: (page, pages) =>
      pages.reduce((count, item) => count + item.jobs.length, 0) < page.total
        ? pages.length * 100
        : undefined,
  })
  return (
    <>
      <div className="my-4 flex flex-wrap gap-3">
        <Field
          aria-label="Search download history"
          fullWidth={false}
          placeholder="Search history"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <label className="flex items-center gap-2 text-small">
          From
          <Field
            type="date"
            fullWidth={false}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-small">
          To
          <Field
            type="date"
            fullWidth={false}
            value={until}
            onChange={(e) => setUntil(e.target.value)}
          />
        </label>
      </div>
      {query.isPending && <p>Loading history…</p>}
      {query.isError && (
        <ErrorBanner>
          {query.error.message}
          <button onClick={() => void query.refetch()}>Retry</button>
        </ErrorBanner>
      )}
      {!query.isPending && !query.isError && query.data?.pages[0]?.jobs.length === 0 && (
        <EmptyPanel>
          <h2>Nothing has finished yet.</h2>
        </EmptyPanel>
      )}
      <JobList jobs={query.data?.pages.flatMap((page) => page.jobs) ?? []} />
      {query.hasNextPage && (
        <InfiniteScroll
          hasMore={query.hasNextPage}
          loading={query.isFetchingNextPage}
          onLoadMore={() => void query.fetchNextPage()}
        />
      )}
    </>
  )
}

export function DownloadsPage() {
  const queue = useJobs()
  const [tab, setTab] = useState('queue')
  // null shows every failure. Single-track failures have an empty batch, so they need
  // their own chip rather than sharing the unfiltered state.
  const [group, setGroup] = useState<string | null>(null)
  const all = (queue.data?.jobs ?? []).filter((job) => !job.hidden)
  const failures = all.filter((job) => job.stage === 'failed')
  // Album and artist downloads fail in clusters, so the batch is the useful unit to inspect.
  const failureGroups = [
    ...failures.reduce(
      (map, job) => map.set(job.batch_id, [...(map.get(job.batch_id) ?? []), job]),
      new Map<string, DownloadJob[]>(),
    ),
  ].sort(([left], [right]) => left.localeCompare(right))
  // Chips only appear above one group, so the filter has to read from the same condition or
  // the list could narrow by a control the user cannot see.
  const grouped = failureGroups.length > 1
  const selectedGroup =
    grouped && group !== null && failureGroups.some(([id]) => id === group) ? group : null
  const jobs = all
    .filter((job) =>
      tab === 'queue'
        ? activeJob(job)
        : tab === 'done'
          ? job.stage === 'done'
          : job.stage === 'failed' && (selectedGroup === null || job.batch_id === selectedGroup),
    )
    .sort((a, b) => (tab === 'queue' ? a.created_at - b.created_at : b.updated_at - a.updated_at))
  const counts = {
    queue: queue.data?.summary.active ?? all.filter(activeJob).length,
    done: all.filter((job) => job.stage === 'done').length,
    failed: queue.data?.summary.failed ?? all.filter((job) => job.stage === 'failed').length,
  }
  return (
    <>
      <PageTitle eyebrow="YOUR COLLECTION, IN MOTION" title="Downloads">
        <Link data-ui="button" className={buttonClassName()} to="/settings">
          Download settings
        </Link>
      </PageTitle>
      <QueueControls />
      <BatchSummary jobs={queue.data?.jobs ?? []} />
      <div className="download-tabs mt-6 mb-4 flex flex-wrap gap-1.5 max-phone:grid max-phone:grid-cols-4 max-phone:gap-1">
        {['queue', 'done', 'failed', 'history'].map((value) => (
          <button
            key={value}
            data-ui="tab"
            className={cx(
              'rounded-pill border-0 px-[17px] py-[10px] whitespace-nowrap coarse:min-h-11',
              'max-phone:min-w-0 max-phone:px-[2px] max-phone:text-body max-phone:overflow-hidden max-phone:text-ellipsis',
              tab === value ? 'bg-accent text-accent-ink' : 'bg-transparent text-muted',
            )}
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
          >
            {value[0]?.toUpperCase()}
            {value.slice(1)}
            {value in counts ? ` (${counts[value as keyof typeof counts]})` : ''}
          </button>
        ))}
      </div>
      {queue.isError && (
        <ErrorBanner>
          {queue.error.message}
          <button onClick={() => void queue.refetch()}>Retry</button>
        </ErrorBanner>
      )}
      {tab === 'failed' && counts.failed > 0 && (
        <section className={errorBannerClassName('list')} aria-label="Failure summary">
          <strong>
            {counts.failed} {counts.failed === 1 ? 'download' : 'downloads'} failed
          </strong>
          {queue.data?.summary.failure_reasons.map((reason) => {
            const link = errorLink(reason.fix || '')
            return (
              <span key={reason.code + reason.message}>
                {reason.count} · {reason.hint || reason.message}{' '}
                {reason.code && <small>({reason.code})</small>}
                {link &&
                  (() => {
                    const [to, hash] = link.href.split('#')
                    return (
                      <>
                        {' '}
                        <Link to={to} hash={hash}>
                          {link.text}
                        </Link>
                      </>
                    )
                  })()}
              </span>
            )
          })}
          {selectedGroup === null && jobs.length < counts.failed && (
            <small>Showing the latest {jobs.length} below.</small>
          )}
        </section>
      )}
      {tab === 'failed' && grouped && (
        <div
          className="my-[14px] flex flex-wrap gap-2"
          role="group"
          aria-label="Failures by download group"
        >
          {failureGroups.map(([id, rows]) => (
            <button
              key={id}
              className={cx(
                'max-w-full truncate rounded-pill border px-3 py-[7px] text-small coarse:min-h-11',
                selectedGroup === id
                  ? 'border-accent bg-accent text-accent-ink'
                  : 'border-line bg-sunken text-muted',
              )}
              aria-pressed={selectedGroup === id}
              onClick={() => setGroup(selectedGroup === id ? null : id)}
            >
              {id === '' ? 'Single tracks' : batchName(rows)} ({rows.length})
            </button>
          ))}
        </div>
      )}
      {tab === 'history' ? (
        <History />
      ) : jobs.length ? (
        <JobList jobs={jobs} />
      ) : queue.isError ? null : (
        <EmptyPanel>
          <ArrowDownToLine size={36} />
          <h2>
            {queue.isPending
              ? 'Loading queue…'
              : `No ${tab === 'queue' ? 'queued' : tab} downloads`}
          </h2>
          <Link to="/search" data-ui="button" className={buttonClassName('primary')}>
            Find a track
          </Link>
        </EmptyPanel>
      )}
    </>
  )
}

export function QueueDock() {
  const dialog = useRef<HTMLDialogElement>(null)
  const queue = useJobs()
  const active = (queue.data?.jobs ?? []).filter(activeJob)
  const speed = active.reduce((total, job) => total + job.speed, 0)
  // A floating dock advertising an empty queue has nothing to offer over the Downloads nav
  // link, and on short pages (e.g. the search-empty home) it has nowhere to float without
  // sitting on top of other content, since there's no space reserved for it.
  if (!active.length) return null
  return (
    <>
      {/* The dock floats above the footer player, and on a phone it would land on the Save
          button or the last row's controls, so there the count moves into the bottom bar. */}
      <button
        className="fixed right-[calc(24px+var(--safe-right))] bottom-[calc(var(--player-height)+var(--nav-height)+var(--safe-bottom)+12px)] z-dock flex items-center gap-[8px] rounded-pill border-0 bg-accent-hot px-[15px] py-[11px] text-small font-bold text-accent-ink shadow-[0_4px_24px_color-mix(in_oklab,var(--color-shadow)_33%,transparent)] max-phone:hidden"
        onClick={() => dialog.current?.showModal()}
        aria-label={`Open queue, ${active.length} active downloads`}
      >
        <ArrowDownToLine size={16} />
        {active.length} · {speed ? `${bytes(speed)}/s` : 'Queue'}
        <ChevronUp size={14} />
      </button>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {active.length} active download{active.length === 1 ? '' : 's'}
      </span>
      <dialog
        className={cx(
          'queue-sheet',
          'fixed inset-x-0 top-auto bottom-0 mx-auto w-[min(1100px,100%)] max-h-[78dvh] overflow-auto overscroll-contain rounded-t-[20px] border border-line-strong bg-raised px-6 pt-6 text-text',
          'pb-[calc(24px+var(--safe-bottom))] max-phone:px-4 max-phone:pt-4 max-phone:pb-[calc(16px+var(--safe-bottom))]',
        )}
        ref={dialog}
        aria-label="Download queue"
        onClick={(event) => {
          if (event.target === dialog.current) dialog.current?.close()
        }}
      >
        <header className="mb-[18px] flex items-center gap-6">
          <h2 className="flex-1">Download queue</h2>
          <Link
            className="coarse:inline-flex coarse:min-h-11 coarse:items-center"
            to="/downloads"
            onClick={() => dialog.current?.close()}
          >
            Full page
          </Link>
          <IconButton
            variant="outlined"
            aria-label="Close queue"
            onClick={() => dialog.current?.close()}
          >
            <X size={20} />
          </IconButton>
        </header>
        <QueueControls />
        {active.length ? (
          <JobList jobs={active} />
        ) : (
          <p className="py-[30px]">Nothing queued. Add a track from search.</p>
        )}
      </dialog>
    </>
  )
}
