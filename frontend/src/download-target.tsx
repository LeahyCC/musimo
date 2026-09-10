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
          <AlertTriangle size={14} aria-hidden="true" />{' '}
          <Link to="/settings" hash="library">
            not available
          </Link>
        </>
      )}
    </small>
  )
}
