import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { z } from 'zod'

import { api, jobsSchema } from '../../api'
import type { Controls, DownloadJob } from '../../api'

export type QueueData = {
  jobs: DownloadJob[]
  controls: Controls
  summary: {
    active: number
    failed: number
    failure_reasons: { code: string; message: string; count: number; hint?: string; fix?: string }[]
  }
}
export const activeJob = (job: DownloadJob) => !['done', 'failed', 'cancelled'].includes(job.stage)
export const unmatchedJob = (job: Pick<DownloadJob, 'stage' | 'error_code'>) =>
  job.stage === 'failed' && job.error_code === 'NO_MATCH'
export const errorJob = (job: Pick<DownloadJob, 'stage' | 'error_code'>) =>
  job.stage === 'failed' && job.error_code !== 'NO_MATCH'

/** The queue line while a pause between groups of tracks is still ahead. `now` is milliseconds. */
export function paceWaitText(paceUntil: number, now: number): string {
  if (!(paceUntil > 0) || paceUntil * 1000 <= now) return ''
  const time = new Date(paceUntil * 1000).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })
  return `Waiting until ${time} before the next tracks.`
}

/** Counts from the server's reason list, which covers jobs past the 50 the page shows. */
export function failureTallies(summary: QueueData['summary'] | undefined, jobs: DownloadJob[]) {
  const reasons = summary?.failure_reasons ?? []
  if (reasons.length === 0) {
    return {
      unmatched: jobs.filter(unmatchedJob).length,
      errors: jobs.filter(errorJob).length,
    }
  }
  return {
    unmatched: reasons
      .filter((reason) => reason.code === 'NO_MATCH')
      .reduce((total, reason) => total + reason.count, 0),
    errors: reasons
      .filter((reason) => reason.code !== 'NO_MATCH')
      .reduce((total, reason) => total + reason.count, 0),
  }
}

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
      // The server groups reasons by hint and fix as well. A no-match hint names the sources
      // that were asked, so two rows can share a code and message.
      const index = summary.failure_reasons.findIndex(
        (reason) =>
          reason.code === item.error_code &&
          reason.message === item.error &&
          (reason.hint ?? '') === item.error_hint &&
          (reason.fix ?? '') === item.error_fix,
      )
      if (index >= 0) {
        const reason = summary.failure_reasons[index]
        if (reason) summary.failure_reasons[index] = { ...reason, count: reason.count + delta }
        if (summary.failure_reasons[index]?.count === 0) summary.failure_reasons.splice(index, 1)
      } else if (delta > 0) {
        summary.failure_reasons.push({
          code: item.error_code,
          message: item.error,
          hint: item.error_hint,
          fix: item.error_fix,
          count: 1,
        })
      }
    }
    return {
      controls: old?.controls ?? {
        paused: false,
        source_paused: false,
        paused_sources: [],
        source_labels: {},
        pace_until: 0,
      },
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

export const failureMessage = (
  job: Pick<DownloadJob, 'error_code' | 'error'> & { error_hint?: string },
) =>
  job.error_hint ||
  (job.error_code === 'NO_MATCH'
    ? 'No matching recording was found. Nothing was downloaded.'
    : job.error || 'The download stopped without an error message.')
