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
import { InfiniteScroll } from './infinite-scroll'

export type QueueData = {
  jobs: DownloadJob[]
  controls: { paused: boolean; source_paused: boolean }
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
      controls: old?.controls ?? { paused: false, source_paused: false },
      summary,
      jobs: [job, ...(old?.jobs ?? []).filter((item) => item.id !== job.id)],
    }
  })
}

export function useJobs() {
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
  })
}
const bytes = (value: number) =>
  value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${Math.round(value / 1024)} KB`

export const failureMessage = (job: Pick<DownloadJob, 'error_code' | 'error'>) =>
  job.error_code === 'NO_MATCH'
    ? 'No matching recording was found on YouTube. Nothing was downloaded.'
    : job.error || 'The download stopped without an error message.'

export function DownloadButton({ item }: { item: MusicResult }) {
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
      job.track_id === item.id &&
      job.format === selected &&
      job.target === (target || settings.data?.destination.value) &&
      activeJob(job),
  )
  const failed = existing
    ? undefined
    : queue.data?.jobs.find(
        (job) =>
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
    <div className="download-action">
      <select
        aria-label={`Format for ${item.title}`}
        value={selected}
        onChange={(e) => setFormat(e.target.value)}
      >
        <option value="original">Original</option>
        <option value="m4a">M4A</option>
        <option value="opus">Opus</option>
        <option value="mp3">MP3</option>
      </select>
      <button
        className="icon-button"
        aria-label={
          owned
            ? `${item.title} is in your library`
            : existing
              ? `${item.title} is ${existing.stage}`
              : failed
                ? `Retry ${item.title}. ${failureMessage(failed)}`
                : `Download ${item.title}`
        }
        title={
          owned
            ? 'Already in your library'
            : existing?.stage
              ? existing.stage
              : failed
                ? failureMessage(failed)
                : 'Download track'
        }
        disabled={owned || Boolean(existing) || mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        {owned || existing ? (
          <Check size={17} />
        ) : failed ? (
          <RotateCcw size={17} />
        ) : (
          <ArrowDownToLine size={17} />
        )}
      </button>
      <button
        ref={optionsButton}
        type="button"
        className="icon-button"
        aria-label={`Download options for ${item.title}`}
        aria-expanded={options}
        aria-haspopup="dialog"
        popoverTarget={optionsId}
        onClick={(event) => event.currentTarget.focus({ preventScroll: true })}
      >
        <MoreHorizontal size={16} />
      </button>
      <div
        ref={optionsPanel}
        id={optionsId}
        className="download-options"
        popover="auto"
        role="dialog"
        aria-label={`Download options for ${item.title}`}
        onBeforeToggle={(event) => {
          if (event.newState === 'open')
            optionsAnchor.current = optionsButton.current?.getBoundingClientRect() ?? null
        }}
        onToggle={(event) => setOptions(event.newState === 'open')}
      >
        <label>
          Download to
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Default folder</option>
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
        <small>Original keeps source quality. Conversion does not improve it.</small>
      </div>
      {mutation.data?.stage === 'done' && (
        <span className="download-error" role="status">
          Already downloaded. The existing file was kept.
        </span>
      )}
      {mutation.isError && (
        <span className="download-error" role="alert">
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

function JobCard({ job }: { job: DownloadJob }) {
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
    <article className={`job-card ${job.stage}`}>
      <div className="job-heading">
        {job.meta.art ? <img src={job.meta.art} alt="" /> : <Disc3 size={38} />}
        <div>
          <strong>{job.meta.title}</strong>
          <span>
            {job.meta.artist} · {job.meta.album}
          </span>
        </div>
        <span className="job-state">{job.stage.replaceAll('_', ' ')}</span>
        <div className="job-buttons">
          {running && !['paused', 'pausing', 'cancelling'].includes(job.stage) && (
            <button
              title="Pause"
              aria-label={`Pause ${job.meta.title}`}
              disabled={busy}
              onClick={() => action.mutate('pause')}
            >
              <Pause size={16} />
            </button>
          )}
          {job.stage === 'paused' && (
            <button
              title="Resume"
              aria-label={`Resume ${job.meta.title}`}
              disabled={busy}
              onClick={() => action.mutate('resume')}
            >
              <Play size={16} />
            </button>
          )}
          {running && (
            <button
              title="Cancel"
              aria-label={`Cancel ${job.meta.title}`}
              disabled={busy || job.stage === 'cancelling'}
              onClick={() => action.mutate('cancel')}
            >
              <X size={16} />
            </button>
          )}
          {['failed', 'cancelled'].includes(job.stage) && (
            <button
              title="Retry"
              aria-label={`Retry ${job.meta.title}`}
              disabled={busy}
              onClick={() => action.mutate('retry')}
            >
              <RotateCcw size={16} />
            </button>
          )}
          {!running && (
            <button
              title="Clear"
              aria-label={`Clear ${job.meta.title}`}
              disabled={busy}
              onClick={() => action.mutate('dismiss')}
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </div>
      <div className="job-steps" aria-label={`Current stage: ${job.stage}`}>
        {[
          'queued',
          'matching',
          'downloading',
          'converting',
          'tagging',
          'moving',
          'scanning',
          'done',
        ].map((stage) => (
          <span key={stage} className={job.stage === stage ? 'current' : ''}>
            {stage}
          </span>
        ))}
      </div>
      {job.stage === 'downloading' && (
        <progress
          aria-label={`${job.meta.title} download progress`}
          max={1}
          value={job.total ? job.progress : undefined}
        />
      )}
      <div className="job-stats">
        <span>
          {job.format === 'original'
            ? 'Original source quality'
            : job.format === 'mp3'
              ? 'MP3 · lossy conversion'
              : job.format.toUpperCase() + ' · conversion if needed'}
        </span>
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
          </span>
        )}
        <span>
          {job.attempts} {job.attempts === 1 ? 'attempt' : 'attempts'}
        </span>
      </div>
      {job.stage === 'retry_wait' && (
        <p className="small">
          Retry scheduled for {new Date(job.retry_at * 1000).toLocaleTimeString()}
        </p>
      )}
      {job.error && (
        <p className="error" role="alert">
          {failureMessage(job)} {job.error_code && <small>({job.error_code})</small>}
        </p>
      )}
      {job.check_match && (
        <p className="match-warning">Check match: the selected recording needs a listen.</p>
      )}
      {job.final_path && (
        <div className="job-path">
          <code>{job.final_path}</code>
          <button
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
      {job.warnings.length > 0 && (
        <details>
          <summary>{job.warnings.length} metadata or scanning notes</summary>
          <ul>
            {job.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
      {job.candidates.length > 0 && (
        <details>
          <summary>
            Recording matches ·{' '}
            {job.candidates.find((candidate) => candidate.id === job.selected)?.score.toFixed(2) ??
              'unselected'}
          </summary>
          {!canPick && <p className="small">Pause the job to change its recording.</p>}
          {job.candidates.map((candidate) => (
            <div className="candidate" key={candidate.id}>
              <div>
                <strong>{candidate.title}</strong>
                <small>
                  {candidate.artist} · {Math.round(candidate.score * 100)}% · {candidate.reason}
                </small>
              </div>
              <a
                href={`https://www.youtube.com/watch?v=${candidate.id}`}
                target="_blank"
                rel="noreferrer"
              >
                Listen ↗
              </a>
              <button
                className="button"
                disabled={!canPick || busy || candidate.id === job.selected}
                onClick={() => pick.mutate(candidate.id)}
              >
                {candidate.id === job.selected ? 'Selected' : 'Use this'}
              </button>
            </div>
          ))}
        </details>
      )}
      {job.tool_tail && (
        <details>
          <summary>Tool details · yt-dlp {job.tool_version}</summary>
          <pre>{job.tool_tail}</pre>
        </details>
      )}
      {(action.isError || pick.isError) && (
        <p className="error" role="alert">
          {action.error?.message ?? pick.error?.message}
        </p>
      )}
    </article>
  )
}

function JobList({ jobs }: { jobs: DownloadJob[] }) {
  const parent = useRef<HTMLDivElement>(null)
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
  if (jobs.length <= 6)
    return (
      <div className="jobs-list">
        {jobs.map((job) => (
          <JobCard key={job.id} job={job} />
        ))}
      </div>
    )
  return (
    <div
      ref={parent}
      className="virtual-list"
      role="region"
      aria-label="Download jobs"
      tabIndex={0}
    >
      <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
        {/* One offset for the window, then normal flow inside it. Positioning each card
            separately let a card sit on top of its neighbour whenever a measured height
            had not landed yet, which is what made the queue overlap as jobs moved up.
            The row separation is padding on the measured element, not a gap between them,
            so it counts towards the height the virtualizer works from. */}
        <div
          className="virtual-window"
          style={{ transform: `translateY(${rows[0]?.start ?? 0}px)` }}
        >
          {rows.map((row) => {
            const job = jobs[row.index]
            return job ? (
              <div
                key={job.id}
                className="virtual-row"
                ref={virtual.measureElement}
                data-index={row.index}
              >
                <JobCard job={job} />
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
          <div key={id} className="batch-summary">
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
              <button
                key={command}
                className="button"
                disabled={action.isPending}
                onClick={() => action.mutate({ id, command })}
              >
                {command === 'pause'
                  ? 'Pause group'
                  : command === 'resume'
                    ? 'Resume group'
                    : 'Cancel group'}
              </button>
            ))}
          </div>
        ))}
      {action.isError && <p className="error">{action.error.message}</p>}
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
  return (
    <>
      <div className="queue-actions">
        <label className="queue-concurrency">
          Parallel{' '}
          <select
            aria-label="Parallel downloads"
            value={settings.data?.concurrency.value ?? 2}
            disabled={settings.data?.concurrency.locked || concurrency.isPending}
            onChange={(e) => concurrency.mutate(Number(e.target.value))}
          >
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button"
          disabled={command.isPending}
          onClick={() => command.mutate(queue.data?.controls.paused ? 'resume' : 'pause')}
        >
          {queue.data?.controls.paused ? 'Resume all' : 'Pause all'}
        </button>
        <button
          className="button"
          disabled={command.isPending}
          onClick={() => command.mutate('cancel-queued')}
        >
          Cancel queued
        </button>
        <button
          className="button"
          disabled={command.isPending || failed === 0}
          onClick={() => command.mutate('retry-failed')}
        >
          Retry failed ({failed})
        </button>
        <button
          className="button"
          disabled={command.isPending || failed === 0}
          onClick={() => command.mutate('clear-failed')}
        >
          Clear failed ({failed})
        </button>
        <button
          className="button"
          disabled={command.isPending}
          onClick={() => command.mutate('clear-finished')}
        >
          Clear all done
        </button>
      </div>
      {queue.data?.controls.source_paused && (
        <div className="error" role="alert">
          YouTube paused after repeated blocking errors.{' '}
          <Link to="/diagnostics">Check diagnostics</Link>
          <button onClick={() => command.mutate('resume-source')}>Try source again</button>
        </div>
      )}
      {(command.isError || Boolean(command.data?.errors.length)) && (
        <p className="error" role="alert">
          {command.error?.message ?? command.data?.errors.join(' · ')}
        </p>
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
      <div className="history-filters">
        <input
          aria-label="Search download history"
          placeholder="Search history"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <label>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
        </label>
      </div>
      {query.isPending && <p>Loading history…</p>}
      {query.isError && (
        <p className="error">
          {query.error.message}
          <button onClick={() => void query.refetch()}>Retry</button>
        </p>
      )}
      {query.isSuccess && query.data.pages[0]?.jobs.length === 0 && query.data.pages[0]?.total === 0 && (
        <div className="empty-panel">
          <p>No download history yet.</p>
        </div>
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
  const failureReasons = new Map(
    (queue.data?.summary.failure_reasons ?? []).map((reason) => [
      failureMessage({ error_code: reason.code, error: reason.message }),
      reason.count,
    ]),
  )
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">YOUR COLLECTION, IN MOTION</div>
          <h1>Downloads</h1>
        </div>
        <Link className="button" to="/settings">
          Download settings
        </Link>
      </div>
      <QueueControls />
      <BatchSummary jobs={queue.data?.jobs ?? []} />
      <div className="result-tabs download-tabs">
        {['queue', 'done', 'failed', 'history'].map((value) => (
          <button
            key={value}
            className={tab === value ? 'selected' : ''}
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
        <p className="error">
          {queue.error.message}
          <button onClick={() => void queue.refetch()}>Retry</button>
        </p>
      )}
      {tab === 'failed' && counts.failed > 0 && (
        <section className="failure-summary" aria-label="Failure summary">
          <strong>
            {counts.failed} {counts.failed === 1 ? 'download' : 'downloads'} failed
          </strong>
          {[...failureReasons].map(([message, count]) => (
            <span key={message}>
              {count} · {message}
            </span>
          ))}
          {selectedGroup === null && jobs.length < counts.failed && (
            <small>Showing the latest {jobs.length} below.</small>
          )}
        </section>
      )}
      {tab === 'failed' && grouped && (
        <div className="failure-groups" role="group" aria-label="Failures by download group">
          {failureGroups.map(([id, rows]) => (
            <button
              key={id}
              className={selectedGroup === id ? 'selected' : ''}
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
      ) : (
        <section className="empty-panel">
          <ArrowDownToLine size={36} />
          <h2>
            {queue.isPending
              ? 'Loading queue…'
              : `No ${tab === 'queue' ? 'queued' : tab} downloads`}
          </h2>
          <Link to="/search" className="button primary">
            Find a track
          </Link>
        </section>
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
      <button
        className="queue-dock"
        onClick={() => dialog.current?.showModal()}
        aria-label={`Open queue, ${active.length} active downloads`}
      >
        <ArrowDownToLine size={16} />
        {active.length} · {speed ? `${bytes(speed)}/s` : 'Queue'}
        <ChevronUp size={14} />
      </button>
      <dialog
        className="queue-sheet"
        ref={dialog}
        aria-label="Download queue"
        onClick={(event) => {
          if (event.target === dialog.current) dialog.current?.close()
        }}
      >
        <header>
          <h2>Download queue</h2>
          <Link to="/downloads" onClick={() => dialog.current?.close()}>
            Full page
          </Link>
          <button aria-label="Close queue" onClick={() => dialog.current?.close()}>
            <X size={20} />
          </button>
        </header>
        <QueueControls />
        <JobList jobs={active} />
      </dialog>
    </>
  )
}
