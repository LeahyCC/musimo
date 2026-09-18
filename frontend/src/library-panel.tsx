import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api, librarySchema } from './api'
import { Button, ErrorBanner, Panel } from './ui'

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
    <Panel className="my-[20px]" aria-label="Library index">
      <h3 className="mb-[12px]">Library index</h3>
      {data && (
        <>
          <strong>{data.total_files.toLocaleString()} audio files indexed</strong>
          <p role="status" className="my-[10px] text-small">
            {data.detail} · {data.walked.toLocaleString()} walked · {data.indexed.toLocaleString()}{' '}
            indexed · {data.elapsed}s · {data.errors} errors
          </p>
          {data.status === 'scanning' && (
            <progress
              aria-label="Library scan in progress"
              className="mb-[12px] w-full accent-accent"
            />
          )}
          <div className="flex flex-wrap items-center gap-[16px]">
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
        <ErrorBanner role="alert" className="my-[10px]">
          {query.error?.message ?? command.error?.message}
          <button type="button" onClick={() => void query.refetch()}>
            Retry
          </button>
        </ErrorBanner>
      )}
    </Panel>
  )
}
