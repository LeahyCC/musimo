import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'

import { api } from '../../api'
import { formatBytes } from '../../lib/format'
import { Button, ErrorBanner } from '../../ui'
import { SettingsBlock } from './settings-layout'

const trashSchema = z.object({
  size: z.number(),
  files: z.number(),
  roots: z.array(
    z.object({ root: z.string(), path: z.string(), size: z.number(), files: z.number() }),
  ),
})

/** What Delete in the library moved to each folder's .musimo-trash, and a way to empty it for good. */
export function TrashPanel() {
  const client = useQueryClient()
  // The key starts with "library" so a delete in the library refetches it too.
  const query = useQuery({
    queryKey: ['library-trash'],
    queryFn: ({ signal }) => api('library/trash', trashSchema, { signal }),
  })
  const empty = useMutation({
    mutationFn: () => api('library/trash', trashSchema, { method: 'DELETE' }),
    onSuccess: (data) => client.setQueryData(['library-trash'], data),
  })
  const data = query.data
  const noun = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'file' : 'files'}`
  return (
    <SettingsBlock>
      <section aria-label="Trash">
        <h3 className="mb-[12px] text-body font-medium">Trash</h3>
        {data && (
          <>
            <strong>
              {data.files ? `${formatBytes(data.size)} · ${noun(data.files)}` : 'Empty'}
            </strong>
            <p className="my-[10px] text-small text-muted">
              Deleted songs, albums and artists wait here. While a file is in the trash it will not
              be downloaded again. Emptying it erases the files for good.
            </p>
            {data.roots
              .filter((row) => row.files)
              .map((row) => (
                <code key={row.path} className="mb-[8px] block text-small text-accent">
                  {row.path} · {formatBytes(row.size)}
                </code>
              ))}
            <Button
              variant="danger"
              disabled={!data.files || empty.isPending}
              onClick={() => {
                if (window.confirm(`Erase ${noun(data.files)} in the trash for good?`))
                  empty.mutate()
              }}
            >
              Empty trash
            </Button>
          </>
        )}
        {(query.isError || empty.isError) && (
          <ErrorBanner role="alert" className="my-[10px]">
            {query.error?.message ?? empty.error?.message}
            <button type="button" onClick={() => void query.refetch()}>
              Retry
            </button>
          </ErrorBanner>
        )}
      </section>
    </SettingsBlock>
  )
}
