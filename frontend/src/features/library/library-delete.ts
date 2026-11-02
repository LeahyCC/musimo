import { useMutation, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'

import { api } from '../../api'
import { useToast } from '../../ui'

export type DeleteKind = 'track' | 'album' | 'artist'

export const deleteResultSchema = z.object({
  deleted: z.array(z.string()),
  failed: z.array(z.object({ id: z.string(), reason: z.string() })),
})

const PATHS: Record<DeleteKind, string> = {
  track: 'library/tracks',
  album: 'library/albums',
  artist: 'library/artists',
}

/** The question asked before a delete. The file is moved, not erased, so it says where it goes. */
export function deleteQuestion(kind: DeleteKind, name: string, editions = 1): string {
  const what =
    kind === 'artist'
      ? `“${name}” and all their albums`
      : kind === 'album'
        ? `the album “${name}”${editions > 1 ? ` (all ${editions} editions)` : ''}`
        : `“${name}”`
  return `Delete ${what}? The files move to the trash. Empty it in Settings to free the space.`
}

/** What to say once the server answers. A partial delete names how many were left behind. */
export function deleteSummary(deleted: number, failed: number): string {
  const songs = (count: number) => `${count} ${count === 1 ? 'song' : 'songs'}`
  if (!failed) return `Moved ${songs(deleted)} to the trash.`
  return `Moved ${songs(deleted)} to the trash. ${songs(failed)} could not be moved (read-only or already gone).`
}

/**
 * Delete a song, album or artist into the trash after a confirm. Every library list and detail
 * is refetched, since live events do not refresh the library-* queries. A card that stands for
 * several editions passes all their ids; they go one request each and the answers are added up.
 */
export function useLibraryDelete(onDeleted?: (kind: DeleteKind, id: string) => void) {
  const client = useQueryClient()
  const toast = useToast()
  const mutation = useMutation({
    mutationFn: async ({ kind, ids }: { kind: DeleteKind; ids: string[] }) => {
      const results = await Promise.allSettled(
        ids.map((id) =>
          api(`${PATHS[kind]}/${encodeURIComponent(id)}`, deleteResultSchema, {
            method: 'DELETE',
          }),
        ),
      )
      const done = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      )
      // Nothing moved anywhere: show the server's reason. Otherwise a refused edition counts as failed.
      if (!done.length && results[0]?.status === 'rejected') throw results[0].reason
      return {
        deleted: done.flatMap((result) => result.deleted),
        failed: [
          ...done.flatMap((result) => result.failed),
          ...ids
            .filter((_, index) => results[index]?.status === 'rejected')
            .map((id) => ({ id, reason: 'refused' })),
        ],
      }
    },
    onSuccess: (result, { kind, ids }) => {
      toast.show({
        tone: result.failed.length ? 'warn' : 'good',
        text: deleteSummary(result.deleted.length, result.failed.length),
      })
      for (const id of ids) onDeleted?.(kind, id)
      void client.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey[0]
          return typeof key === 'string' && key.startsWith('library')
        },
      })
    },
    onError: (error) => toast.show({ tone: 'danger', text: error.message }),
  })
  return {
    pending: mutation.isPending,
    remove: (kind: DeleteKind, id: string | string[], name: string) => {
      const ids = typeof id === 'string' ? [id] : id
      if (window.confirm(deleteQuestion(kind, name, ids.length))) mutation.mutate({ kind, ids })
    },
  }
}
