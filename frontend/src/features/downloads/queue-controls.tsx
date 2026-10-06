import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'

import { api, commandSchema, settingsSchema } from '../../api'
import { RowMenu } from '../../components/row-menu'
import type { RowMenuAction } from '../../components/row-menu'
import { Button, ErrorBanner, FieldSelect } from '../../ui'
import { pausedSources } from './download-target'
import { activeJob, failureTallies, useJobs } from './jobs'
import type { QueueData } from './jobs'

export function QueueControls() {
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
  const visible = (queue.data?.jobs ?? []).filter((job) => !job.hidden)
  const { unmatched, errors } = failureTallies(queue.data?.summary, visible)
  const hasFinished = queue.data?.jobs.some((job) => !job.hidden && !activeJob(job)) ?? false
  const moreActions: RowMenuAction[] = [
    ...(errors > 0
      ? [
          { label: `Retry errors (${errors})`, onSelect: () => command.mutate('retry-failed') },
          { label: `Clear errors (${errors})`, onSelect: () => command.mutate('clear-failed') },
        ]
      : []),
    ...(unmatched > 0
      ? [
          {
            label: `Clear no match (${unmatched})`,
            onSelect: () => command.mutate('clear-unmatched'),
          },
        ]
      : []),
    ...(hasFinished
      ? [
          {
            label: 'Clear all finished',
            onSelect: () => {
              // It hides every done, failed and cancelled card at once, so ask first. History keeps
              // them.
              const ask = 'Clear all finished jobs from the queue? They stay in History.'
              if (window.confirm(ask)) command.mutate('clear-finished')
            },
          },
        ]
      : []),
  ]
  // One line per paused site.
  const paused = pausedSources(queue.data?.controls)
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
        {/* The three that clean up after a run live in a menu, and only the ones with something to
            act on are listed. With none, there is no menu at all. */}
        {moreActions.length > 0 && (
          <RowMenu label="More queue actions" actions={moreActions} disabled={command.isPending} />
        )}
      </div>
      {paused.map(({ source, label }) => (
        <ErrorBanner role="alert" key={source}>
          {label} paused after repeated blocking errors.{' '}
          <Link to="/diagnostics">Check diagnostics</Link>
          <button
            onClick={() => command.mutate(`resume-source?source=${encodeURIComponent(source)}`)}
          >
            Try {label} again
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
