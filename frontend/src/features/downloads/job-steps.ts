import type { DownloadJob } from '../../api'
import type { PipelineStep, PipelineTone } from '../../ui'
import { siteLabel } from './download-target'
import { activeJob, errorJob, unmatchedJob } from './jobs'

/** Where a job sits on the five step bar. `queued` is a job no step can be claimed for yet. */
export type JobStep = {
  current: PipelineStep | 'done' | 'queued'
  tone: PipelineTone
  /** The words beside the bar, e.g. "Downloading · 62%". */
  label: string
}

type StepJob = Pick<DownloadJob, 'stage' | 'error_code' | 'progress' | 'total' | 'retry_at'>

/*
 * The worker's own stages, matched to the five steps the design draws. Moving and the library scan
 * that follows it are one step, Move: the scan only runs once the file is in place. Podcasts and
 * pasted links never match, so on their bar Match reads as done once they are downloading.
 */
const RUNNING_STEP: Partial<Record<string, PipelineStep>> = {
  matching: 'match',
  downloading: 'download',
  converting: 'convert',
  tagging: 'tag',
  moving: 'move',
  scanning: 'move',
}

/*
 * A failed job does not record the stage it stopped at, so the step comes from its error code.
 * Codes that can come from more than one stage (a full disk, a folder that went read-only, an
 * internal error) claim no step rather than guess.
 */
const FAILED_STEP: Partial<Record<string, PipelineStep>> = {
  NO_MATCH: 'match',
  SOURCE_BLOCKED: 'download',
  RATE_LIMITED: 'download',
  POT_MISSING: 'download',
  JS_RUNTIME_MISSING: 'download',
  COOKIES_EXPIRED: 'download',
  AGE_RESTRICTED: 'download',
  DURATION_MISMATCH: 'download',
  TIMEOUT: 'download',
  LOOKUP_FAILED: 'download',
  CONNECTION_FAILED: 'download',
  LIVE_STREAM: 'download',
  GEO_RESTRICTED: 'download',
  SITE_NOT_ALLOWED: 'download',
  DOWNLOAD_FAILED: 'download',
  TRANSCODE_FAILED: 'convert',
  TAG_FAILED: 'tag',
  MOVE_FAILED: 'move',
}

const STEP_WORDS: Record<PipelineStep, string> = {
  match: 'match',
  download: 'download',
  convert: 'convert',
  tag: 'tagging',
  move: 'move',
}

/** The step a failed job stopped at, when its error code says. */
export const failedStep = (code: string): PipelineStep | undefined => FAILED_STEP[code]

const clock = (seconds: number) =>
  new Date(seconds * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

export function jobStep(job: StepJob): JobStep {
  const running = RUNNING_STEP[job.stage]
  if (running) {
    const label =
      job.stage === 'downloading'
        ? job.total
          ? `Downloading · ${Math.round(job.progress * 100)}%`
          : 'Downloading'
        : job.stage === 'scanning'
          ? 'Adding to library'
          : job.stage.charAt(0).toUpperCase() + job.stage.slice(1)
    return { current: running, tone: 'good', label }
  }
  if (job.stage === 'done') return { current: 'done', tone: 'good', label: 'Done' }
  if (job.stage === 'failed') {
    const step = failedStep(job.error_code)
    if (job.error_code === 'NO_MATCH')
      return { current: 'match', tone: 'warn', label: 'No close match' }
    return step
      ? { current: step, tone: 'danger', label: `Failed at ${STEP_WORDS[step]}` }
      : { current: 'queued', tone: 'danger', label: 'Failed' }
  }
  // Paused, waiting to retry and cancelling all keep no record of the step they left, so the
  // bar claims none and the words carry the state.
  if (job.stage === 'retry_wait')
    return {
      current: 'queued',
      tone: 'warn',
      label: job.retry_at ? `Retrying at ${clock(job.retry_at)}` : 'Waiting to retry',
    }
  if (job.stage === 'paused' || job.stage === 'pausing')
    return { current: 'queued', tone: 'warn', label: job.stage === 'paused' ? 'Paused' : 'Pausing' }
  if (job.stage === 'cancelling') return { current: 'queued', tone: 'warn', label: 'Cancelling' }
  if (job.stage === 'cancelled') return { current: 'queued', tone: 'warn', label: 'Cancelled' }
  return { current: 'queued', tone: 'good', label: 'Queued' }
}

/**
 * How far along the job is as one fraction, for Classic's single bar: each step is a fifth, and
 * the download step fills with its own progress. A failure fills the bar so the red reads.
 */
export function jobFraction(job: StepJob): number {
  if (job.stage === 'done' || job.stage === 'failed') return 1
  const step = RUNNING_STEP[job.stage]
  if (!step) return 0
  const index = ['match', 'download', 'convert', 'tag', 'move'].indexOf(step)
  const within = step === 'download' && job.total ? job.progress : 0
  return (index + within) / 5
}

export type JobGroup = {
  /** The batch id, `album:<id>` for an album queued track by track, or `single`. */
  key: string
  batchId: string
  title: string
  jobs: DownloadJob[]
}

export const batchName = (rows: readonly DownloadJob[]) =>
  rows.find((job) => job.batch_label)?.batch_label ||
  rows.find((job) => job.meta.album)?.meta.album ||
  'Album download'

/**
 * The Listening room's queue sections: one per album or artist download, then one per album that
 * was queued a track at a time, then the loose tracks. Groups keep the order their first job was
 * queued in.
 */
export function groupJobs(jobs: readonly DownloadJob[]): JobGroup[] {
  const groups = new Map<string, DownloadJob[]>()
  for (const job of [...jobs].sort((a, b) => a.created_at - b.created_at)) {
    const key = job.batch_id || (job.album_id ? `album:${job.album_id}` : 'single')
    groups.set(key, [...(groups.get(key) ?? []), job])
  }
  return [...groups].map(([key, rows]) => ({
    key,
    batchId: rows[0]?.batch_id ?? '',
    title: key === 'single' ? 'Single tracks' : batchName(rows),
    jobs: rows,
  }))
}

export type SegmentState = 'done' | 'running' | 'failed' | 'waiting'

/** One segment per track for a batch's bar. A missing recording counts as failed here too. */
export function batchSegments(jobs: readonly DownloadJob[]): SegmentState[] {
  return jobs.map((job) =>
    job.stage === 'done'
      ? 'done'
      : job.stage === 'failed'
        ? 'failed'
        : RUNNING_STEP[job.stage]
          ? 'running'
          : 'waiting',
  )
}

export function batchTally(jobs: readonly DownloadJob[]) {
  return {
    done: jobs.filter((job) => job.stage === 'done').length,
    failed: jobs.filter(errorJob).length,
    unmatched: jobs.filter(unmatchedJob).length,
    active: jobs.filter(activeJob).length,
  }
}

export type CauseGroup = {
  key: string
  code: string
  title: string
  detail: string
  fix: string
  jobs: DownloadJob[]
}

/** Failed jobs gathered by what went wrong, the way the server counts its reasons. */
export function causeGroups(jobs: readonly DownloadJob[]): CauseGroup[] {
  const groups = new Map<string, CauseGroup>()
  for (const job of jobs) {
    const key = [job.error_code, job.error_hint, job.error_fix].join('|')
    const group = groups.get(key) ?? {
      key,
      code: job.error_code,
      title: job.error_hint || job.error || 'The download stopped without an error message.',
      detail: job.error_hint && job.error !== job.error_hint ? job.error : '',
      fix: job.error_fix,
      jobs: [],
    }
    group.jobs.push(job)
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => b.jobs.length - a.jobs.length)
}

/** Short names for the reason chips. A code without one shows the server's message. */
const REASON_NAMES: Partial<Record<string, string>> = {
  SOURCE_BLOCKED: 'Source blocked',
  RATE_LIMITED: 'Rate limited',
  POT_MISSING: 'PO token missing',
  JS_RUNTIME_MISSING: 'Deno missing',
  COOKIES_EXPIRED: 'Sign-in needed',
  AGE_RESTRICTED: 'Age check',
  DURATION_MISMATCH: 'Wrong length',
  TIMEOUT: 'Timed out',
  LOOKUP_FAILED: 'Name lookup',
  CONNECTION_FAILED: 'No connection',
  LIVE_STREAM: 'Live stream',
  GEO_RESTRICTED: 'Region locked',
  SITE_NOT_ALLOWED: 'Site not allowed',
  DOWNLOAD_FAILED: 'Download failed',
  TRANSCODE_FAILED: 'Conversion failed',
  TAG_FAILED: 'Tagging failed',
  MOVE_FAILED: 'Move failed',
  DEST_UNWRITABLE: 'Read-only folder',
  DISK_FULL: 'Disk full',
  CATALOG_FAILED: 'Catalog offline',
  INTERNAL_ERROR: 'Internal error',
}

export const reasonName = (code: string, message: string) =>
  REASON_NAMES[code] ?? (message || 'Unknown')

/** Every reason row the server sent for one code, added up, so each chip names a code once. */
export function reasonChips(reasons: readonly { code: string; message: string; count: number }[]) {
  const chips = new Map<string, { code: string; name: string; count: number }>()
  for (const reason of reasons) {
    const name = reasonName(reason.code, reason.message)
    const chip = chips.get(name) ?? { code: reason.code, name, count: 0 }
    chip.count += reason.count
    chips.set(name, chip)
  }
  return [...chips.values()].filter((chip) => chip.count > 0)
}

/**
 * The sources a no-match job heard back from, from the near candidates it kept. Its hint names
 * every site asked, so a site with no candidate is still in the words above the chips.
 */
export function sourcesTried(job: Pick<DownloadJob, 'candidates'>) {
  const counts = new Map<string, { source: string; label: string; count: number }>()
  for (const candidate of job.candidates) {
    const label = siteLabel(candidate.source, candidate.source_label)
    const row = counts.get(candidate.source) ?? { source: candidate.source, label, count: 0 }
    row.count += 1
    counts.set(candidate.source, row)
  }
  return [...counts.values()]
}

export type MatchConfidence = { tone: 'good' | 'warn'; text: string }

/**
 * What a finished job knows about how good its match was: the check-match flag, else the chosen
 * candidate's score. Podcasts, links and older jobs carry neither, and get no badge.
 */
export function matchConfidence(
  job: Pick<DownloadJob, 'check_match' | 'candidates' | 'selected'>,
): MatchConfidence | null {
  if (job.check_match) return { tone: 'warn', text: 'Check match' }
  const chosen = job.candidates.find((candidate) => candidate.id === job.selected)
  if (!chosen) return null
  const percent = Math.round(chosen.score * 100)
  return { tone: chosen.score >= 0.75 ? 'good' : 'warn', text: `${percent}% match` }
}

/** Midnight before `seconds`, as a key two jobs on the same local day share. */
const dayStart = (seconds: number) => {
  const date = new Date(seconds * 1000)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** "TODAY · SAT 17 OCT", "YESTERDAY", "THU 15 OCT". `now` is milliseconds. */
export function dayLabel(seconds: number, now: number): string {
  const day = dayStart(seconds)
  const today = dayStart(now / 1000)
  const date = new Date(seconds * 1000)
  const named = date
    .toLocaleDateString([], {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }),
    })
    .replaceAll(',', '')
    .toUpperCase()
  if (day === today) return `TODAY · ${named}`
  // A day is not always 24 hours across a clock change, so compare calendar days.
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (day === yesterday.getTime()) return 'YESTERDAY'
  return named
}

/**
 * History rows with the day heading set on the first row of each day. The server sorts and filters
 * history by when a job was queued, so the days follow that too.
 */
export function withDays<T extends { created_at: number }>(rows: readonly T[], now: number) {
  let last = ''
  return rows.map((row) => {
    const day = dayLabel(row.created_at, now)
    const heading = day === last ? '' : day
    last = day
    return { row, heading }
  })
}

/** Finished on or after midnight today, local time. `now` is milliseconds. */
export const finishedToday = (job: Pick<DownloadJob, 'updated_at'>, now: number) =>
  job.updated_at * 1000 >= dayStart(now / 1000)
