import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { AlertTriangle } from 'lucide-react'

import { api, diagnosticsSchema, settingsSchema } from './api'
import type { Controls } from './api'
import { cx } from './cx'

export function formatLabel(format: string): string {
  return format === 'original'
    ? 'Original source quality'
    : format === 'm4a'
      ? 'M4A / AAC'
      : format === 'opus'
        ? 'Opus'
        : 'MP3 · converted'
}

/**
 * The name of the site a job downloads from. The server owns the names, so this only builds one
 * from the source when a payload from an older server did not send it.
 */
export function siteLabel(source: string, label?: string): string {
  return label || source.charAt(0).toUpperCase() + source.slice(1)
}

/**
 * Every source paused by blocking errors, with its name. A server from before per-source pausing
 * sends only the flag, and that flag has always meant YouTube.
 */
export function pausedSources(controls: Controls | undefined): { source: string; label: string }[] {
  if (!controls) return []
  if (!controls.paused_sources.length) {
    return controls.source_paused ? [{ source: 'youtube', label: 'YouTube' }] : []
  }
  return controls.paused_sources.map((source) => ({
    source,
    label: siteLabel(source, controls.source_labels[source]),
  }))
}

export const DESTINATION_PROBLEM =
  'That folder is missing or read-only. Choose another destination, or fix it in Settings.'

/**
 * Whether a download to `target` cannot work. It is false while the disks are still unknown, so the
 * button is not held back by a slow request.
 */
export function destinationBroken(
  disks: { path: string; exists: boolean; writable: boolean }[] | undefined,
  target: string,
): boolean {
  if (!disks || !target) return false
  const disk = disks.find((item) => item.path === target)
  return !disk || !disk.exists || !disk.writable
}

/** The short format choices a track's download controls offer, in one place. */
export function FormatOptions() {
  return (
    <>
      <option value="original">Original</option>
      <option value="m4a">M4A</option>
      <option value="opus">Opus</option>
      <option value="mp3">MP3</option>
    </>
  )
}

export function DownloadTarget({
  format,
  target,
  lead = 'to',
  className,
}: {
  format?: string
  target?: string
  /** The words before the destination. A page that shows the line once says "Downloads go to". */
  lead?: string
  className?: string
}) {
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: ({ signal }) => api('settings', settingsSchema, { signal }),
  })
  const diagnostics = useQuery({
    queryKey: ['diagnostics'],
    queryFn: ({ signal }) => api('diagnostics', diagnosticsSchema, { signal }),
  })

  const chosenFormat = format ?? settings.data?.output_format.value ?? 'original'
  const chosenTarget = target ?? settings.data?.destination.value ?? ''
  const problem = destinationBroken(diagnostics.data?.disks, chosenTarget)

  return (
    <small className={cx('download-target', className)}>
      {lead}{' '}
      <Link to="/settings" hash="library">
        {chosenTarget || '(not set)'}
      </Link>{' '}
      · {formatLabel(chosenFormat)}
      {problem && (
        <>
          {' '}
          <AlertTriangle size={14} aria-hidden="true" className="inline-block align-[-2px]" />{' '}
          <Link to="/settings" hash="library">
            not available
          </Link>
        </>
      )}
    </small>
  )
}
