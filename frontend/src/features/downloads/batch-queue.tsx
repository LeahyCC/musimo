import { useState } from 'react'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Pause, Play, X } from 'lucide-react'

import { api, commandSchema } from '../../api'
import type { DownloadJob } from '../../api'
import { cx } from '../../lib/cx'
import { Button, ErrorBanner, IconButton, PipelineBar } from '../../ui'
import { siteLabel } from './download-target'
import {
  JobArt,
  JobButtons,
  JobDetails,
  JobNotes,
  stageTextClassName,
  useJobActions,
} from './job-list'
import { batchSegments, batchTally, groupJobs, jobStep } from './job-steps'
import type { JobGroup, SegmentState } from './job-steps'
import { activeJob } from './jobs'

const segmentFill: Record<SegmentState, string> = {
  done: 'bg-accent',
  // The design's running segment is the accent dulled toward the line color.
  running: 'bg-[color-mix(in_oklab,var(--color-accent)_55%,var(--color-line))]',
  failed: 'bg-danger',
  waiting: 'bg-line',
}

/** A long album would draw hundreds of rows; the rest wait behind a button. */
const ROWS_SHOWN = 12

function useBatchCommand() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, command }: { id: string; command: string }) =>
      api(`batches/${id}/${command}`, commandSchema, { method: 'POST' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['jobs'] }),
  })
}

/**
 * One album or artist download: its cover, name, a segment per track and the batch's own pause.
 * Albums queued track by track, and loose tracks, have no batch on the server, so no pause.
 */
export function BatchHeader({ group }: { group: JobGroup }) {
  const command = useBatchCommand()
  const tally = batchTally(group.jobs)
  const segments = batchSegments(group.jobs)
  const first = group.jobs[0]
  const sources = [...new Set(group.jobs.map((job) => siteLabel(job.source, job.source_label)))]
  const artists = [...new Set(group.jobs.map((job) => job.meta.artist).filter(Boolean))]
  const running = group.jobs.some(
    (job) => activeJob(job) && !['paused', 'pausing', 'cancelling'].includes(job.stage),
  )
  const paused = group.jobs.some((job) => job.stage === 'paused')
  const trouble = [
    tally.failed ? `${tally.failed} failed` : '',
    tally.unmatched ? `${tally.unmatched} no match` : '',
  ].filter(Boolean)
  return (
    <div className="flex flex-wrap items-center gap-[14px] px-[16px] py-[14px] max-phone:gap-[10px] max-phone:px-[12px]">
      {first && <JobArt job={first} size={52} />}
      <div className="min-w-0 flex-[1_1_200px] max-phone:flex-[1_1_0]">
        <h3 className="truncate text-lead font-semibold">{group.title}</h3>
        <p className="truncate text-small text-muted">
          {[
            artists.length === 1 ? artists[0] : artists.length ? `${artists.length} artists` : '',
            `${group.jobs.length} ${group.jobs.length === 1 ? 'track' : 'tracks'}`,
            sources.join(', '),
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
      <div className="min-w-[160px] flex-[0_1_260px] max-phone:order-last max-phone:flex-[1_1_100%]">
        <div className="mb-[6px] flex justify-between font-mono text-[10.5px] tracking-[0.6px] text-muted uppercase">
          <span>
            {tally.done} of {group.jobs.length} done
          </span>
          {trouble.length > 0 && <span className="text-danger">{trouble.join(' · ')}</span>}
        </div>
        <div
          className="flex h-[6px] gap-[2px]"
          role="img"
          aria-label={`${group.title}: ${tally.done} of ${group.jobs.length} done${trouble.length ? `, ${trouble.join(', ')}` : ''}`}
        >
          {segments.map((state, index) => (
            <span key={index} className={cx('flex-1 rounded-[2px]', segmentFill[state])} />
          ))}
        </div>
      </div>
      {group.batchId && (running || paused) && (
        <div className="flex gap-[4px]">
          <IconButton
            title={running ? 'Pause batch' : 'Resume batch'}
            aria-label={`${running ? 'Pause' : 'Resume'} ${group.title}`}
            className="h-[34px] w-[34px] rounded-[9px] bg-hover text-text"
            disabled={command.isPending}
            onClick={() =>
              command.mutate({ id: group.batchId, command: running ? 'pause' : 'resume' })
            }
          >
            {running ? <Pause size={14} /> : <Play size={14} />}
          </IconButton>
          <IconButton
            title="Cancel batch"
            aria-label={`Cancel ${group.title}`}
            className="h-[34px] w-[34px] rounded-[9px] hover:bg-hover hover:text-danger"
            disabled={command.isPending}
            onClick={() => command.mutate({ id: group.batchId, command: 'cancel' })}
          >
            <X size={14} />
          </IconButton>
        </div>
      )}
      {command.isError && (
        <ErrorBanner className="basis-full" role="alert">
          {command.error.message}
        </ErrorBanner>
      )}
    </div>
  )
}

function BatchRow({ job, position }: { job: DownloadJob; position: number }) {
  const actions = useJobActions(job)
  const step = jobStep(job)
  const failed = job.stage === 'failed'
  return (
    <article
      className={cx(
        'job-card',
        job.stage,
        'grid grid-cols-[22px_minmax(0,1fr)_minmax(120px,200px)_auto] items-center gap-x-[12px] rounded-[10px] px-[8px] py-[7px]',
        'max-phone:grid-cols-[22px_minmax(0,1fr)_auto] max-phone:gap-x-[8px]',
        failed && 'bg-danger/6',
      )}
      id={`job-${job.id}`}
    >
      <span className="font-mono text-tiny text-faint">{String(position).padStart(2, '0')}</span>
      <span className="min-w-0">
        <strong className="block truncate font-medium">{job.meta.title}</strong>
        <span className={cx('block truncate text-small', stageTextClassName(step))}>
          {[
            step.label,
            failed ? job.error_hint || job.error : '',
            siteLabel(job.source, job.source_label),
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
      <PipelineBar
        current={step.current}
        tone={step.tone}
        className="max-phone:col-start-2 max-phone:col-end-4 max-phone:row-start-2 max-phone:mt-[6px]"
      />
      <span className="flex text-muted max-phone:row-start-1 max-phone:col-start-3">
        <JobButtons job={job} actions={actions} />
      </span>
      <div className="col-start-2 col-end-5 min-w-0 empty:hidden max-phone:col-end-4">
        <JobNotes job={job} />
        <JobDetails job={job} actions={actions} />
        {actions.error && <ErrorBanner role="alert">{actions.error}</ErrorBanner>}
      </div>
    </article>
  )
}

function BatchSection({ group }: { group: JobGroup }) {
  const [all, setAll] = useState(false)
  // Finished tracks are counted in the bar; the rows are what is still moving or went wrong.
  const rows = group.jobs.filter((job) => job.stage !== 'done')
  const shown = all ? rows : rows.slice(0, ROWS_SHOWN)
  return (
    <section
      className="overflow-hidden rounded-[18px] bg-raised"
      aria-label={group.title}
      data-batch={group.key}
    >
      <BatchHeader group={group} />
      <div className="px-[8px] pb-[8px]">
        {shown.map((job) => (
          <BatchRow key={job.id} job={job} position={group.jobs.indexOf(job) + 1} />
        ))}
        {rows.length > shown.length && (
          <Button className="mt-[4px] w-full" onClick={() => setAll(true)}>
            Show {rows.length - shown.length} more
          </Button>
        )}
      </div>
    </section>
  )
}

/** The Listening room's queue: every batch with something still to do, as its own section. */
export function BatchQueue({ jobs }: { jobs: DownloadJob[] }) {
  // Loose tracks share no batch, so a long-finished single would sit in the bar beside today's.
  // That section holds only what is still moving.
  const groups = groupJobs(jobs)
    .map((group) =>
      group.key === 'single' ? { ...group, jobs: group.jobs.filter(activeJob) } : group,
    )
    .filter((group) => group.jobs.some(activeJob))
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-[12px]">
      {groups.map((group) => (
        <BatchSection key={group.key} group={group} />
      ))}
    </div>
  )
}

/** Classic's queue keeps one slim line per batch above the cards, for its pause and progress. */
export function BatchSummaries({ jobs }: { jobs: DownloadJob[] }) {
  const groups = groupJobs(jobs).filter(
    (group) => group.batchId && group.jobs.length > 1 && group.jobs.some(activeJob),
  )
  if (!groups.length) return null
  return (
    <div className="mb-[12px] grid grid-cols-[minmax(0,1fr)] gap-[8px]">
      {groups.map((group) => (
        <section
          key={group.key}
          aria-label={group.title}
          className="rounded-[12px] border border-line bg-raised"
        >
          <BatchHeader group={group} />
        </section>
      ))}
    </div>
  )
}
