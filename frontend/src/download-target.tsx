import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'

import { api, diagnosticsSchema, settingsSchema } from './api'

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
  const problem = disk && (!disk.exists || !disk.writable)

  const formatLabel =
    chosenFormat === 'original'
      ? 'Original source quality'
      : chosenFormat === 'm4a'
        ? 'M4A / AAC'
        : chosenFormat === 'opus'
          ? 'Opus'
          : 'MP3 · converted'

  return (
    <small className="download-target">
      to {chosenTarget || '(not set)'} · {formatLabel}
      {problem && (
        <>
          {' '}
          <AlertTriangle size={14} aria-label="Destination not available" />
        </>
      )}
    </small>
  )
}
