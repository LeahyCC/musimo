import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api, librarySchema } from './api'
import { Button, ErrorBanner } from './ui'

export function LibraryPanel() {
  const client = useQueryClient()
  const query = useQuery({
    queryKey: ['library'],
    queryFn: ({ signal }) => api('library', librarySchema, { signal }),
  })
  const command = useMutation({
    mutationFn: (action: 'scan' | 'cancel') =>
      api(`library/${action}`, librarySchema, { method: 'POST' }),
    onSuccess: (data) => client.setQueryData(['library'], data),
  })
  const data = query.data
  return (
    <section className="library-panel" aria-label="Library index">
      <h3>Library index</h3>
      {data && (
        <>
          <strong>{data.total_files.toLocaleString()} audio files indexed</strong>
          <p role="status">
            {data.detail} · {data.walked.toLocaleString()} walked · {data.indexed.toLocaleString()}{' '}
            indexed · {data.elapsed}s · {data.errors} errors
          </p>
          {data.status === 'scanning' && <progress aria-label="Library scan in progress" />}
          <div className="button-row">
            <Button
              disabled={data.status === 'scanning' || command.isPending}
              onClick={() => command.mutate('scan')}
            >
              Scan library now
            </Button>
            {data.status === 'scanning' && (
              <Button disabled={command.isPending} onClick={() => command.mutate('cancel')}>
                Cancel scan
              </Button>
            )}
          </div>
        </>
      )}
      {(query.isError || command.isError) && (
        <ErrorBanner role="alert">
          {query.error?.message ?? command.error?.message}
          <button type="button" onClick={() => void query.refetch()}>
            Retry
          </button>
        </ErrorBanner>
      )}
    </section>
  )
}
