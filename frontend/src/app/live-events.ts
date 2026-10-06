import { useEffect, useState } from 'react'

import { useQueryClient } from '@tanstack/react-query'

import { api, controlsSchema, jobSchema, librarySchema, snapshotSchema } from '../api'
import { updateJob } from '../features/downloads/jobs'
import type { QueueData } from '../features/downloads/jobs'

export function useLiveEvents() {
  const client = useQueryClient()
  const [status, setStatus] = useState('Connecting')

  useEffect(() => {
    let stream: EventSource | undefined
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const connect = async () => {
      try {
        const snapshot = await api('snapshot', snapshotSchema, {
          signal: controller.signal,
        })
        if (disposed) return
        client.setQueryData(['settings'], snapshot.settings)
        client.setQueryData(['jobs'], {
          jobs: snapshot.jobs,
          controls: snapshot.controls,
          summary: snapshot.summary,
        })
        stream = new EventSource(`/api/events?after=${snapshot.cursor}`)
        stream.onopen = () => setStatus('Live')
        stream.onerror = () => setStatus('Reconnecting')
        stream.addEventListener('change', (event: MessageEvent<string>) => {
          const raw: unknown = JSON.parse(event.data)
          if (typeof raw !== 'object' || !raw || !('kind' in raw)) return
          if (raw.kind === 'job.updated' && 'payload' in raw) {
            const parsed = jobSchema.safeParse(raw.payload)
            if (parsed.success) {
              updateJob(client, parsed.data)
              if (['done', 'failed', 'cancelled'].includes(parsed.data.stage)) {
                void client.invalidateQueries({ queryKey: ['history'] })
                void client.invalidateQueries({ queryKey: ['activity'] })
              }
            }
            return
          }

          if (raw.kind === 'queue.updated' && 'payload' in raw) {
            const parsed = controlsSchema.safeParse(raw.payload)
            if (parsed.success)
              client.setQueryData(['jobs'], (old: QueueData | undefined) => ({
                jobs: old?.jobs ?? [],
                controls: parsed.data,
                summary: old?.summary ?? { active: 0, failed: 0, failure_reasons: [] },
              }))
            return
          }

          void client.invalidateQueries({ queryKey: ['activity'] })

          if (raw.kind === 'library.updated' && 'payload' in raw) {
            const parsed = librarySchema.safeParse(raw.payload)
            if (parsed.success) {
              client.setQueryData(['library'], parsed.data)
              if (parsed.data.status !== 'scanning') {
                void client.invalidateQueries({ queryKey: ['search'] })
                void client.invalidateQueries({ queryKey: ['album'] })
                void client.invalidateQueries({ queryKey: ['artist'] })
                void client.invalidateQueries({ queryKey: ['artist-download-plan'] })
              }
            }
          } else {
            void client.invalidateQueries({ queryKey: ['settings'] })
            void client.invalidateQueries({ queryKey: ['diagnostics'] })
          }
        })

        stream.addEventListener('reset', () => {
          stream?.close()
          setStatus('Syncing')
          void connect()
        })
      } catch {
        if (!disposed) {
          setStatus('Offline')
          timer = setTimeout(() => void connect(), 2000)
        }
      }
    }
    void connect()
    return () => {
      disposed = true
      controller.abort()
      stream?.close()
      clearTimeout(timer)
    }
  }, [client])

  return status
}
