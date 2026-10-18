import { forwardRef, Fragment, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowRight, Disc3, Pause, Play, RotateCcw, Trash2, X } from 'lucide-react'

import {
  api,
  diagnosticsSchema,
  jobSchema,
  libraryTrackSearchSchema,
  settingsSchema,
} from '../../api'
import type { DownloadJob } from '../../api'
import { cx } from '../../lib/cx'
import type { ClassName } from '../../lib/cx'
import { formatBytes } from '../../lib/format'
import { Button, ErrorBanner, IconButton, StatusChip, textLinkClassName, useToast } from '../../ui'
import { usePlayer } from '../player/player'
import { catalogCardSource, pausedSources, siteLabel } from './download-target'
import type { CatalogSourceChoice } from './download-target'
import { jobFraction, jobStep, matchConfidence, sourcesTried } from './job-steps'
import type { JobStep } from './job-steps'
import { activeJob, failureMessage, listenHref, updateJob } from './jobs'
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

/** The link a failure's fix points at. `solid` is the filled button on an error group's header. */
export function FixLink({ fix, solid = false }: { fix: string; solid?: boolean }) {
  const link = errorLink(fix)
  if (!link) return fix === 'report' ? <> Report this with the tool output below.</> : null
  const [to, hash] = link.href.split('#')
  return (
    <Link
      to={to}
      hash={hash}
      className={
        solid
          ? 'inline-flex h-[30px] shrink-0 items-center gap-[5px] rounded-[7px] bg-danger px-[11px] text-small font-semibold text-danger-bg coarse:min-h-11'
          : undefined
      }
    >
      {link.text}
      {solid && <ArrowRight size={13} aria-hidden="true" />}
    </Link>
  )
}

const toneText: Record<JobStep['tone'], string> = {
  good: 'text-accent',
  warn: 'text-warn',
  danger: 'text-danger',
}
const toneFill: Record<JobStep['tone'], string> = {
  good: 'bg-accent',
  warn: 'bg-warn',
  danger: 'bg-danger',
}

/** The words for a job's stage, colored by how it is going. A queued job's words stay quiet. */
export function stageTextClassName(step: JobStep) {
  return step.current === 'queued' && step.tone === 'good' ? 'text-faint' : toneText[step.tone]
}

export function JobArt({
  job,
  size = 44,
  className,
}: {
  job: DownloadJob
  size?: 36 | 40 | 44 | 52
  className?: string
}) {
  const box = { 36: 'h-9 w-9', 40: 'h-10 w-10', 44: 'h-11 w-11', 52: 'h-13 w-13' }[size]
  return job.meta.art ? (
    <img
      className={cx(box, 'shrink-0 rounded-[6px] object-cover', className)}
      src={job.meta.art}
      alt=""
    />
  ) : (
    <span
      className={cx(
        box,
        'grid shrink-0 place-items-center rounded-[6px] bg-hover text-muted',
        className,
      )}
    >
      <Disc3 size={16} aria-hidden="true" />
    </span>
  )
}

type QueuedLabel = {
  settings?: CatalogSourceChoice
  paused: readonly string[]
  labels: Record<string, string>
}

export function useQueuedCatalogLabel(): QueuedLabel {
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

/** The small facts after the stage: where from, which try, size and speed, what was saved. */
export function jobFacts(job: DownloadJob, queuedLabel: QueuedLabel) {
  const shown = catalogCardSource(job, queuedLabel.settings, queuedLabel.paused, queuedLabel.labels)
  const warningCount =
    job.warnings.length > 0
      ? ` · ${job.warnings.length} warning${job.warnings.length === 1 ? '' : 's'}`
      : ''
  return [
    (job.catalog === 'link' || job.catalog === 'deezer') && shown.source
      ? `from ${siteLabel(shown.source, shown.label)}`
      : '',
    job.catalog === 'deezer' && job.laps > 1 && job.lap > 0
      ? `pass ${job.lap} of ${job.laps}`
      : `${job.attempts} ${job.attempts === 1 ? 'attempt' : 'attempts'}`,
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
}

function Facts({ facts, className }: { facts: string[]; className?: string }) {
  return (
    <span className={cx('min-w-0 truncate text-tiny text-faint', className)}>
      {facts.map((fact, index) => (
        <Fragment key={index}>
          {index > 0 && ' · '}
          <span>{fact}</span>
        </Fragment>
      ))}
    </span>
  )
}

export function useJobActions(job: DownloadJob) {
  const client = useQueryClient()
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
  return {
    action,
    pick,
    busy: action.isPending || pick.isPending,
    error: action.error?.message ?? pick.error?.message ?? '',
  }
}
type JobActions = ReturnType<typeof useJobActions>

const sameText = (left: string, right: string) =>
  left.localeCompare(right, undefined, { sensitivity: 'base' }) === 0

/**
 * Plays a finished download from the library. A job does not carry the library's song id, so this
 * looks the title up and plays the song whose title and artist both match. Until the library has
 * scanned the file there is nothing to play, and a toast says so.
 */
export function usePlayDownloaded() {
  const player = usePlayer()
  const toast = useToast()
  return useMutation({
    mutationFn: async (job: DownloadJob) => {
      const found = await api(
        `library/tracks/search?q=${encodeURIComponent(job.meta.title)}&size=20`,
        libraryTrackSearchSchema,
      )
      return (
        found.items.find(
          (track) =>
            sameText(track.title, job.meta.title) && sameText(track.artist, job.meta.artist),
        ) ?? null
      )
    },
    onSuccess: (track, job) => {
      if (track) player.playLibrary([track], 0)
      else
        toast.show({
          tone: 'info',
          text: `${job.meta.title} is not in the library yet. It shows up after the next scan.`,
        })
    },
    onError: (error) => toast.show({ tone: 'danger', text: error.message }),
  })
}

/** Pause or resume, retry, then cancel or clear: the buttons every job row ends with. */
export function JobButtons({
  job,
  actions,
  clearLabel = 'Clear',
}: {
  job: DownloadJob
  actions: JobActions
  clearLabel?: string
}) {
  const { action, busy } = actions
  const running = activeJob(job)
  const button = (name: string, label: string, icon: ReactNode, tone?: ClassName) => (
    <IconButton
      title={label}
      aria-label={`${label} ${job.meta.title}`}
      className={cx('h-[34px] w-[34px] rounded-[8px] hover:bg-hover', tone)}
      disabled={busy || (name === 'cancel' && job.stage === 'cancelling')}
      onClick={() => action.mutate(name)}
    >
      {icon}
    </IconButton>
  )
  return (
    <>
      {running &&
        !['paused', 'pausing', 'cancelling'].includes(job.stage) &&
        button('pause', 'Pause', <Pause size={15} />)}
      {job.stage === 'paused' && button('resume', 'Resume', <Play size={15} />)}
      {['failed', 'cancelled'].includes(job.stage) &&
        button('retry', 'Retry', <RotateCcw size={15} />, job.stage === 'failed' && 'text-danger')}
      {running && button('cancel', 'Cancel', <X size={15} />, 'hover:text-danger')}
      {!running &&
        button(
          'dismiss',
          clearLabel,
          clearLabel === 'Dismiss' ? <X size={15} /> : <Trash2 size={15} />,
        )}
    </>
  )
}

/**
 * What a card keeps out of sight until asked: where the file went, the recordings it could use
 * and the tool's last words. The candidate list is the existing way to pick a match by hand.
 */
export const JobDetails = forwardRef<
  HTMLDetailsElement,
  { job: DownloadJob; actions: JobActions; className?: string }
>(function JobDetails({ job, actions, className }, ref) {
  const [copied, setCopied] = useState(false)
  const canPick = ['queued', 'paused', 'failed', 'cancelled', 'done'].includes(job.stage)
  if (!job.final_path && job.candidates.length === 0 && !job.tool_tail) return null
  return (
    <details ref={ref} className={cx('text-tiny text-muted', className)}>
      <summary className="cursor-pointer py-[2px] coarse:min-h-11 coarse:py-[12px]">
        {job.candidates.length > 0
          ? `Recording matches · ${
              job.candidates.find((candidate) => candidate.id === job.selected)?.score.toFixed(2) ??
              'unselected'
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
              disabled={!canPick || actions.busy || candidate.id === job.selected}
              onClick={() => actions.pick.mutate(candidate.id)}
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
  )
})

/** Notes, the check-match flag and warnings: lines under a job that are not its error. */
export function JobNotes({ job }: { job: DownloadJob }) {
  return (
    <>
      {job.check_match && job.stage !== 'done' && (
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
    </>
  )
}

/** Opens the card's candidate list, the existing way to choose a recording by hand. */
function PickButton({
  details,
  className,
}: {
  details: React.RefObject<HTMLDetailsElement | null>
  className?: string
}) {
  return (
    <Button
      className={cx('min-h-[32px] px-[12px] py-[6px] text-small', className)}
      onClick={() => {
        if (!details.current) return
        details.current.open = true
        details.current.scrollIntoView({ block: 'nearest' })
      }}
    >
      Pick a match
    </Button>
  )
}

export type JobCardVariant = 'queue' | 'done' | 'nomatch' | 'error'

/**
 * Classic's job card, and the row shape every finished tab shares. `queue` has the stage, one bar
 * and the source; `done` has the path, the match badge and Play; `nomatch` says why and which
 * sources answered; `error` sits inside a group that already says what went wrong.
 */
function JobCard({
  job,
  variant,
  focusable = false,
  queuedLabel,
}: {
  job: DownloadJob
  variant: JobCardVariant
  focusable?: boolean
  queuedLabel: QueuedLabel
}) {
  const actions = useJobActions(job)
  const play = usePlayDownloaded()
  const details = useRef<HTMLDetailsElement>(null)
  const step = jobStep(job)
  const facts = jobFacts(job, queuedLabel)
  const confidence = variant === 'done' ? matchConfidence(job) : null
  const tried = variant === 'nomatch' ? sourcesTried(job) : []
  const byline = [job.meta.artist, job.meta.album].filter(Boolean).join(' · ')
  return (
    <article
      className={cx(
        // `job-card` is the hook the download specs locate cards by. The stage class is for them too.
        'job-card',
        job.stage,
        'grid min-w-0 grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-x-[14px] gap-y-[4px] focus-visible:outline-2 focus-visible:outline-accent',
        variant === 'error'
          ? 'border-t border-line px-[14px] py-[8px]'
          : 'rounded-[12px] border bg-raised py-[10px] pr-[10px] pl-[12px]',
        variant !== 'error' &&
          (job.stage === 'failed' && variant === 'queue' ? 'border-danger-line' : 'border-line'),
        // A phone drops the cover: the title and its reason need the width more.
        'max-phone:grid-cols-[minmax(0,1fr)_auto] max-phone:gap-x-[10px]',
      )}
      id={`job-${job.id}`}
      tabIndex={focusable ? 0 : -1}
    >
      <JobArt job={job} size={variant === 'error' ? 36 : 44} className="max-phone:hidden" />
      <div className="min-w-0">
        <div className="flex min-w-0 items-baseline gap-[8px] max-phone:flex-col max-phone:items-stretch max-phone:gap-0">
          <strong className="min-w-0 truncate font-semibold">{job.meta.title}</strong>
          {byline && <span className="min-w-0 truncate text-small text-muted">{byline}</span>}
        </div>
        {variant === 'queue' && (
          <div className="mt-[7px] flex min-w-0 flex-wrap items-center gap-x-[10px] gap-y-[4px]">
            <span className={cx('text-small whitespace-nowrap', stageTextClassName(step))}>
              {step.label}
            </span>
            <span
              role="progressbar"
              aria-label={`${job.meta.title} progress`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(jobFraction(job) * 100)}
              className="h-[4px] min-w-[80px] max-w-[320px] flex-1 overflow-hidden rounded-[4px] bg-line"
            >
              <span
                className={cx('block h-full rounded-[4px]', toneFill[step.tone])}
                style={{ width: `${jobFraction(job) * 100}%` }}
              />
            </span>
            <Facts facts={facts} className="max-phone:basis-full max-phone:whitespace-normal" />
          </div>
        )}
        {variant === 'done' && (
          <>
            {job.final_path && (
              <span
                className="block truncate font-mono text-tiny text-faint"
                title={job.final_path}
              >
                {job.final_path}
              </span>
            )}
            <div className="mt-[3px] flex min-w-0 flex-wrap items-center gap-[8px]">
              {confidence && (
                <StatusChip
                  variant={confidence.tone === 'good' ? 'good' : 'default'}
                  className={cx(
                    'px-[7px] py-[2px] text-tiny',
                    confidence.tone === 'warn' && 'border-warn-line bg-warn-bg text-warn',
                  )}
                >
                  {confidence.text}
                </StatusChip>
              )}
              <Facts facts={facts} className="max-phone:whitespace-normal" />
            </div>
          </>
        )}
        {variant === 'nomatch' && (
          <span className="mt-[2px] block text-small text-muted">{failureMessage(job)}</span>
        )}
        {variant === 'error' && (
          <span className="flex min-w-0 flex-wrap gap-x-[8px] text-small text-muted">
            <span>{step.label}</span>
            <Facts facts={facts} className="font-mono" />
          </span>
        )}
      </div>
      <div className="flex items-center gap-[2px] text-muted">
        {variant === 'done' && (
          <IconButton
            title="Play"
            aria-label={`Play ${job.meta.title}`}
            className="h-[34px] w-[34px] rounded-[8px] text-accent hover:bg-hover"
            disabled={play.isPending}
            onClick={() => play.mutate(job)}
          >
            <Play size={14} fill="currentColor" />
          </IconButton>
        )}
        {variant === 'nomatch' && job.candidates.length > 0 && (
          <PickButton details={details} className="max-phone:hidden" />
        )}
        <JobButtons
          job={job}
          actions={actions}
          clearLabel={variant === 'nomatch' ? 'Dismiss' : 'Clear'}
        />
      </div>
      <div className="col-start-2 col-end-4 min-w-0 empty:hidden max-phone:col-start-1 max-phone:col-end-3">
        {/* A phone has no room beside the reason, so the button drops under it. */}
        {variant === 'nomatch' && job.candidates.length > 0 && (
          // The wrapper owns the display: `hidden` on the button itself loses to Button's own
          // `inline-flex`, which drew this second copy on desktop too.
          <span className="mt-[6px] hidden max-phone:block">
            <PickButton details={details} />
          </span>
        )}
        {tried.length > 0 && (
          <ul className="my-[4px] flex flex-wrap gap-[6px]" aria-label="Sources that answered">
            {tried.map((row) => (
              <li
                key={row.source}
                className="inline-flex h-[24px] items-center rounded-pill border border-line bg-canvas px-[9px] text-tiny text-muted"
              >
                {row.label} · {row.count} near
              </li>
            ))}
          </ul>
        )}
        {job.error && variant !== 'nomatch' && variant !== 'error' && (
          <p className="text-small text-muted" role={job.stage === 'failed' ? 'alert' : undefined}>
            {job.error_hint || failureMessage(job)}{' '}
            {job.error_code && <small>({job.error_code})</small>} <FixLink fix={job.error_fix} />
          </p>
        )}
        {/* The worker's own stages in words, for a screen reader. The bar above is the design's five
            steps; this is what this job will actually pass through. */}
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
            <span key={stage} className={job.stage === stage ? 'font-bold' : undefined}>
              {stage}
            </span>
          ))}
        </div>
        <JobNotes job={job} />
        <JobDetails ref={details} job={job} actions={actions} />
        {actions.error && <ErrorBanner role="alert">{actions.error}</ErrorBanner>}
      </div>
    </article>
  )
}

export function JobList({
  jobs,
  variant = 'queue',
}: {
  jobs: DownloadJob[]
  variant?: JobCardVariant
}) {
  const queuedLabel = useQueuedCatalogLabel()
  const parent = useRef<HTMLDivElement>(null)
  const [focusedIndex, setFocusedIndex] = useState(0)
  const virtual = useVirtualizer({
    count: jobs.length,
    getScrollElement: () => parent.current,
    // A first guess for cards not yet measured. Roughly the shortest a card gets, so the
    // scrollbar grows into place rather than shrinking back.
    estimateSize: () => 66,
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
      <div className="grid grid-cols-[minmax(0,1fr)] gap-[8px]" onKeyDown={handleKeyDown}>
        {jobs.map((job, index) => (
          <JobCard
            key={job.id}
            job={job}
            variant={variant}
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
                className="pb-[8px]"
                ref={virtual.measureElement}
                data-index={row.index}
              >
                <JobCard
                  job={job}
                  variant={variant}
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

/** Error rows inside a cause group: not virtual, since a group holds at most the 50 shown jobs. */
export function ErrorRows({ jobs }: { jobs: DownloadJob[] }) {
  const queuedLabel = useQueuedCatalogLabel()
  return (
    <>
      {jobs.map((job) => (
        <JobCard key={job.id} job={job} variant="error" queuedLabel={queuedLabel} />
      ))}
    </>
  )
}
