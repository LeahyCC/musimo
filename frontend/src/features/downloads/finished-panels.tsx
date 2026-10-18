import { useState } from 'react'

import { HardDrive, KeyRound, RotateCcw, SearchX, TriangleAlert } from 'lucide-react'

import type { DownloadJob } from '../../api'
import { cx } from '../../lib/cx'
import { Button } from '../../ui'
import { ErrorRows, FixLink, JobList } from './job-list'
import { batchName, causeGroups, finishedToday, reasonChips } from './job-steps'
import type { QueueData } from './jobs'
import { useQueueCommand } from './queue-controls'

type Reason = QueueData['summary']['failure_reasons'][number]

const quietButton =
  'inline-flex min-h-[32px] items-center rounded-[8px] px-[12px] text-small text-muted underline hover:text-text coarse:min-h-11'

export function DonePanel({ jobs }: { jobs: DownloadJob[] }) {
  const command = useQueueCommand()
  const today = jobs.filter((job) => finishedToday(job, Date.now())).length
  return (
    <>
      <div className="mb-[12px] flex flex-wrap items-center gap-[10px]">
        <span className="text-small text-muted">
          {today} finished today
          {jobs.length > today ? ` · ${jobs.length} shown` : ''}
        </span>
        <span className="flex-1" />
        <Button
          className="min-h-[32px] py-0 text-small"
          disabled={command.isPending}
          onClick={() => {
            // It hides every done, failed and cancelled card at once, so ask first. History keeps
            // them.
            const ask = 'Clear all finished jobs from the queue? They stay in History.'
            if (window.confirm(ask)) command.mutate('clear-finished')
          }}
        >
          Clear all finished
        </Button>
      </div>
      <JobList jobs={jobs} variant="done" />
    </>
  )
}

/**
 * A missing recording is not a broken download: it gets its own tab, a plain explanation, the
 * sources that answered and the hand-picked match. Album downloads miss in clusters, so the
 * batch chips narrow the list to one.
 */
export function NoMatchPanel({
  jobs,
  count,
  reasons,
}: {
  jobs: DownloadJob[]
  count: number
  reasons: Reason[]
}) {
  const command = useQueueCommand()
  // null shows every miss. Single-track misses have an empty batch, so they need their own chip
  // rather than sharing the unfiltered state.
  const [group, setGroup] = useState<string | null>(null)
  const groups = [
    ...jobs.reduce(
      (map, job) => map.set(job.batch_id, [...(map.get(job.batch_id) ?? []), job]),
      new Map<string, DownloadJob[]>(),
    ),
  ].sort(([left], [right]) => left.localeCompare(right))
  // Chips only appear above one group, so the filter has to read from the same condition or
  // the list could narrow by a control the user cannot see.
  const grouped = groups.length > 1
  const selected = grouped && group !== null && groups.some(([id]) => id === group) ? group : null
  const shown = jobs.filter((job) => selected === null || job.batch_id === selected)
  return (
    <>
      {count > 0 && (
        <section
          aria-label="No match summary"
          className="mb-[12px] flex flex-wrap items-start gap-[12px] rounded-[12px] border border-line bg-raised px-[14px] py-[12px]"
        >
          <SearchX size={16} aria-hidden="true" className="mt-[2px] text-muted" />
          <div className="min-w-[200px] flex-1 text-body text-muted">
            <strong className="block text-text">
              {count} {count === 1 ? 'track has' : 'tracks have'} no close match
            </strong>
            No source had a recording close enough. These are not errors: pick a candidate by hand,
            try again later, or let them go.
            <ul className="mt-[6px] text-small">
              {reasons.map((reason) => (
                <li key={[reason.code, reason.message, reason.hint, reason.fix].join('|')}>
                  {reason.count} · {reason.hint || reason.message}
                </li>
              ))}
            </ul>
            {selected === null && shown.length < count && (
              <small className="block">Showing the latest {shown.length} below.</small>
            )}
          </div>
          <button
            className={quietButton}
            disabled={command.isPending}
            onClick={() => command.mutate('clear-unmatched')}
          >
            Clear no match
          </button>
        </section>
      )}
      {grouped && (
        <div
          className="my-[14px] flex flex-wrap gap-2"
          role="group"
          aria-label="No matches by download group"
        >
          {groups.map(([id, rows]) => (
            <button
              key={id}
              className={cx(
                'max-w-full truncate rounded-pill border px-3 py-[7px] text-small coarse:min-h-11',
                selected === id
                  ? 'border-good-line bg-active text-text'
                  : 'border-line bg-transparent text-muted',
              )}
              aria-pressed={selected === id}
              onClick={() => setGroup(selected === id ? null : id)}
            >
              {id === '' ? 'Single tracks' : batchName(rows)} ({rows.length})
            </button>
          ))}
        </div>
      )}
      {shown.length > 0 && <JobList jobs={shown} variant="nomatch" />}
    </>
  )
}

const causeIcon = (code: string) =>
  ['COOKIES_EXPIRED', 'AGE_RESTRICTED', 'POT_MISSING'].includes(code) ? (
    <KeyRound size={16} aria-hidden="true" />
  ) : ['DEST_UNWRITABLE', 'DISK_FULL', 'MOVE_FAILED'].includes(code) ? (
    <HardDrive size={16} aria-hidden="true" />
  ) : (
    <TriangleAlert size={16} aria-hidden="true" />
  )

/** Failures grouped by what went wrong, each group with its hint and the fix that clears it. */
export function ErrorsPanel({
  jobs,
  count,
  reasons,
}: {
  jobs: DownloadJob[]
  count: number
  reasons: Reason[]
}) {
  const command = useQueueCommand()
  const chips = reasonChips(reasons)
  return (
    <>
      {count > 0 && (
        <section
          aria-label="Failure summary"
          className="mb-[14px] flex flex-wrap items-center gap-[8px]"
        >
          <strong className="sr-only">
            {count} {count === 1 ? 'download' : 'downloads'} failed
          </strong>
          <ul className="contents">
            {chips.map((chip) => (
              <li
                key={chip.name}
                className="inline-flex h-[30px] items-center gap-[7px] rounded-pill border border-danger-line bg-danger-bg px-[11px] text-small text-danger"
              >
                {chip.name}
                <b className="font-semibold">{chip.count}</b>
              </li>
            ))}
          </ul>
          <span className="flex-1" />
          <Button
            variant="danger"
            className="min-h-[32px] py-0 text-small"
            disabled={command.isPending}
            onClick={() => command.mutate('retry-failed')}
          >
            <RotateCcw size={13} aria-hidden="true" />
            Retry all ({count})
          </Button>
          <button
            className={quietButton}
            disabled={command.isPending}
            onClick={() => command.mutate('clear-failed')}
          >
            Clear errors
          </button>
          {jobs.length < count && (
            <small className="basis-full text-muted">Showing the latest {jobs.length} below.</small>
          )}
        </section>
      )}
      {causeGroups(jobs).map((group) => (
        <section
          key={group.key}
          aria-label={group.title}
          className="mb-[12px] overflow-hidden rounded-[14px] border border-danger-line bg-raised"
        >
          <div className="flex flex-wrap items-center gap-[12px] bg-danger-bg px-[14px] py-[12px] text-danger">
            {causeIcon(group.code)}
            <div className="min-w-[200px] flex-1">
              <h3 className="text-body font-semibold text-text">{group.title}</h3>
              <p className="mt-[2px] text-small">
                {group.detail}
                {group.code && <small> ({group.code})</small>}
              </p>
            </div>
            <FixLink fix={group.fix} solid />
          </div>
          <ErrorRows jobs={group.jobs} />
        </section>
      ))}
    </>
  )
}
