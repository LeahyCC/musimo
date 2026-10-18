import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Pause, Play } from 'lucide-react'

import { api, commandSchema, settingsSchema } from '../../api'
import { cx } from '../../lib/cx'
import { Button, ErrorBanner, SelectChip, useToast } from '../../ui'
import { formatLabel, pausedSources } from './download-target'
import { activeJob, paceWaitText, useJobs } from './jobs'
import type { QueueData } from './jobs'

export const useSettings = () =>
  useQuery({
    queryKey: ['settings'],
    queryFn: ({ signal }) => api('settings', settingsSchema, { signal }),
  })

/**
 * A command for the whole queue (`pause`, `retry-failed`, `clear-unmatched`…). The server answers
 * with the new controls and any jobs it could not act on; those, and a failed request, are toasts,
 * since the button that asked may be anywhere on the page.
 */
export function useQueueCommand() {
  const client = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: (action: string) => api(`queue/${action}`, commandSchema, { method: 'POST' }),
    onSuccess: (data) => {
      client.setQueryData<QueueData>(['jobs'], (old) => ({
        jobs: old?.jobs ?? [],
        controls: data.controls,
        summary: old?.summary ?? { active: 0, failed: 0, failure_reasons: [] },
      }))
      void client.invalidateQueries({ queryKey: ['jobs'] })
      if (data.errors.length) toast.show({ tone: 'danger', text: data.errors.join(' · ') })
    },
    onError: (error) => toast.show({ tone: 'danger', text: error.message }),
  })
}

export function PauseAllButton({ className }: { className?: string }) {
  const queue = useJobs()
  const command = useQueueCommand()
  const paused = queue.data?.controls.paused ?? false
  return (
    <Button
      className={cx('min-h-[36px] py-0', className)}
      disabled={command.isPending}
      onClick={() => command.mutate(paused ? 'resume' : 'pause')}
    >
      {paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
      {paused ? 'Resume all' : 'Pause all'}
    </Button>
  )
}

export function CancelQueuedButton({ className }: { className?: string }) {
  const command = useQueueCommand()
  return (
    <Button
      className={cx('min-h-[36px] py-0', className)}
      disabled={command.isPending}
      onClick={() => command.mutate('cancel-queued')}
    >
      Cancel queued
    </Button>
  )
}

const PARALLEL = [
  { value: '1', label: '1' },
  { value: '2', label: '2' },
  { value: '3', label: '3' },
] as const

/** How many downloads run at once. Saved straight to Settings, unless the server locks it. */
export function ParallelChip() {
  const client = useQueryClient()
  const settings = useSettings()
  const concurrency = useMutation({
    mutationFn: (value: number) =>
      api('settings', settingsSchema, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ concurrency: value }),
      }),
    onSuccess: (data) => client.setQueryData(['settings'], data),
  })
  const value = String(settings.data?.concurrency.value ?? 2)
  return (
    <SelectChip
      label="Parallel downloads"
      value={PARALLEL.some((option) => option.value === value) ? value : '2'}
      options={PARALLEL}
      disabled={settings.data?.concurrency.locked || concurrency.isPending}
      onChange={(next) => concurrency.mutate(Number(next))}
    />
  )
}

/** "saving to /music as M4A / AAC", from Settings. Nothing until Settings has loaded. */
export function SaveTarget({ lead = 'saving to' }: { lead?: string }) {
  const settings = useSettings()
  if (!settings.data) return null
  const format = settings.data.output_format.value
  return (
    <>
      {lead} <span className="font-mono text-text">{settings.data.destination.value}</span>{' '}
      {format === 'original' ? (
        'in the original format'
      ) : (
        <>
          as <span className="text-text">{formatLabel(format)}</span>
        </>
      )}
    </>
  )
}

/** The pause between groups of tracks and any site paused for blocking: lines above the list. */
export function QueueAlerts() {
  const queue = useJobs()
  const command = useQueueCommand()
  const visible = (queue.data?.jobs ?? []).filter((job) => !job.hidden)
  const wait = visible.some(activeJob)
    ? paceWaitText(queue.data?.controls.pace_until ?? 0, Date.now())
    : ''
  // One line per paused site.
  const paused = pausedSources(queue.data?.controls)
  return (
    <>
      {wait && (
        <p className="mb-3 text-small text-muted" role="status">
          {wait}
        </p>
      )}
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
    </>
  )
}

/** The queue sheet's controls: the same pause, parallel and cancel the page header has. */
export function QueueControls() {
  return (
    <>
      <div className="my-4 flex flex-wrap items-center gap-2">
        <ParallelChip />
        <PauseAllButton />
        <CancelQueuedButton />
      </div>
      <QueueAlerts />
    </>
  )
}
