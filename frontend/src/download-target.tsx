import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { AlertTriangle } from 'lucide-react'

import { api, diagnosticsSchema, settingsSchema } from './api'

export function formatLabel(format: string): string {
  return format === 'original'
    ? 'Original source quality'
    : format === 'm4a'
      ? 'M4A / AAC'
      : format === 'opus'
        ? 'Opus'
        : 'MP3 · converted'
}

const SITE_LABELS: Record<string, string> = { youtube: 'YouTube', podcast: 'Podcasts' }

/** The name of the site a job downloads from. A site added on the server shows capitalised. */
export function siteLabel(source: string): string {
  return SITE_LABELS[source] ?? source.charAt(0).toUpperCase() + source.slice(1)
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

export function DownloadTarget({ format, target }: { format?: string; target?: string }) {
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
  const disk = diagnostics.data?.disks.find((d) => d.path === chosenTarget)
  const problem = diagnostics.data && chosenTarget && (!disk || !disk.exists || !disk.writable)

  return (
    <small className="download-target">
      to{' '}
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
