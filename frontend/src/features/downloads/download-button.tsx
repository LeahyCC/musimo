import { useId, useLayoutEffect, useRef, useState } from 'react'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDownToLine, Clock, MoreHorizontal, RotateCcw } from 'lucide-react'

import { api, diagnosticsSchema, jobSchema, settingsSchema } from '../../api'
import type { MusicResult } from '../../api'
import { cx } from '../../lib/cx'
import { errorBannerClassName, IconButton } from '../../ui'
import { formatLabel, FormatOptions } from './download-target'
import { activeJob, failureMessage, updateJob, useJobs } from './jobs'

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
      {/* An owned track already shows its "In library" badge, so it gets no download button
          rather than a disabled tick that says the same thing. The format lives in the options
          popover and shows on this button's name and tooltip. */}
      {!owned && (
        <IconButton
          aria-label={
            existing
              ? `${item.title} is ${existing.stage}`
              : failed
                ? `Retry ${item.title}. ${failureMessage(failed)}`
                : `Download ${item.title} to ${target || settings.data?.destination.value || '(not set)'} · ${formatLabel(selected)}`
          }
          title={
            existing?.stage
              ? existing.stage
              : failed
                ? failureMessage(failed)
                : `to ${target || settings.data?.destination.value || '(not set)'} · ${formatLabel(selected)}`
          }
          disabled={Boolean(existing) || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {existing ? (
            <Clock size={17} />
          ) : failed ? (
            <RotateCcw size={17} />
          ) : (
            <ArrowDownToLine size={17} />
          )}
        </IconButton>
      )}
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
        {/* It follows the destination so the focus rule above lands on the same control on every
            screen. */}
        <label className="mt-[10px] grid min-w-0 gap-[6px] text-small">
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
