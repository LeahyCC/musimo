import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { z } from 'zod'

import { api } from './api'

const activitySchema = z.object({
  events: z.array(z.object({ id: z.number(), kind: z.string(), created_at: z.string() })),
  count: z.number(),
  cursor: z.number(),
})
const labels: Record<string, string> = {
  'settings.updated': 'Settings saved',
  'library.updated': 'Library index updated',
  'source.updated': 'Source connection updated',
  'job.updated': 'Download updated',
  'job.created': 'Download queued',
  'queue.updated': 'Queue updated',
}

export function RecentActivity() {
  const client = useQueryClient()
  const activity = useQuery({
    queryKey: ['activity'],
    queryFn: ({ signal }) => api('activity', activitySchema, { signal }),
  })
  const clear = useMutation({
    mutationFn: (through: number) =>
      api('activity', activitySchema, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ through }),
      }),
    onSuccess: (data) => {
      client.setQueryData(['activity'], data)
      void client.invalidateQueries({ queryKey: ['diagnostics'] })
    },
  })
  return (
    <section className="events-section" aria-labelledby="activity-heading">
      <div className="section-heading">
        <h2 id="activity-heading">Recent activity</h2>
        <button
          type="button"
          className="button"
          disabled={!activity.data?.count || clear.isPending}
          onClick={() => activity.data && clear.mutate(activity.data.cursor)}
        >
          <Trash2 size={15} />
          {clear.isPending ? 'Clearing…' : 'Clear all'}
        </button>
      </div>
      {activity.isPending && <p role="status">Loading activity…</p>}
      {activity.isError && (
        <p className="error" role="alert">
          {activity.error.message}{' '}
          <button type="button" onClick={() => void activity.refetch()}>
            Retry
          </button>
        </p>
      )}
      {clear.isError && (
        <p className="error" role="alert">
          {clear.error.message}
        </p>
      )}
      {activity.data &&
        (activity.data.count ? (
          <>
            <p className="muted small">
              Showing the latest {activity.data.events.length} of {activity.data.count} entries.
            </p>
            <div
              className="activity-scroll"
              role="region"
              aria-label="Recent activity entries"
              tabIndex={0}
            >
              <ul className="event-list">
                {activity.data.events.map((event) => (
                  <li key={event.id}>
                    <span className="event-dot" />
                    <span>{labels[event.kind] ?? event.kind.replaceAll('.', ' ')}</span>
                    <time dateTime={event.created_at}>
                      {new Date(event.created_at).toLocaleString()}
                    </time>
                    <code>#{event.id}</code>
                  </li>
                ))}
              </ul>
            </div>
          </>
        ) : (
          <p className="muted" role="status">
            No recent activity. New events will appear here.
          </p>
        ))}
      <p className="muted small">
        Clears this activity feed. Download history and live update records are kept separately.
      </p>
    </section>
  )
}
