import type { z } from 'zod'

import type { diagnosticsSchema } from '../../api'
import { formatBytes } from '../../lib/format'
import { rootIsReady } from '../diagnostics/readiness'

type Diagnostics = z.infer<typeof diagnosticsSchema>

export type StepState = 'done' | 'now' | 'next'
export type WelcomeStep = {
  id: 'mounted' | 'collection' | 'scan'
  state: StepState
  title: string
  detail: string
}

/** What the compose file needs for an existing collection. Mirrors the README's example. */
export const COMPOSE_SNIPPET = `services:
  musimo:
    environment:
      MUSIMO_LIBRARY_ROOTS: /music:/collection
    volumes:
      - /srv/music:/collection:ro`

/**
 * The three first-run steps, worked out from what Diagnostics reports. Only the first step can be
 * checked (a root is mounted and writable); the second is an instruction, and the third is done
 * once the index holds files, at which point Home stops showing this page at all.
 */
export function welcomeSteps(data: Diagnostics | undefined): WelcomeStep[] {
  const roots = data?.library.roots ?? []
  const mounted =
    data !== undefined && roots.length > 0 && roots.every((r) => rootIsReady(data.disks, r))
  const free = data?.disks.find((disk) => disk.path === roots[0])?.free_bytes
  const scanning = data?.library.status === 'scanning'
  const scanned = data !== undefined && data.library.status !== 'idle' && !scanning
  return [
    {
      id: 'mounted',
      state: mounted ? 'done' : 'now',
      title: mounted ? 'Folders are mounted' : 'Mount a music folder',
      detail: mounted
        ? `${roots.join(', ')} ${roots.length === 1 ? 'is' : 'are'} readable and writable${
            free ? ` · ${formatBytes(free)} free` : ''
          }.`
        : roots.length
          ? `${roots.join(', ')} could not be read or written. Check the mount in compose.`
          : 'No music folder is set yet. List one in MUSIMO_LIBRARY_ROOTS.',
    },
    {
      id: 'collection',
      state: mounted ? 'now' : 'next',
      title: 'Point Musimo at your existing collection',
      detail:
        'Mount it read-only in compose.override.yaml, then list it in MUSIMO_LIBRARY_ROOTS. Musimo never moves or renames files there.',
    },
    {
      id: 'scan',
      state: mounted ? 'now' : 'next',
      title: 'Scan the library',
      detail: scanning
        ? `Scanning: ${data.library.indexed.toLocaleString()} of ${data.library.walked.toLocaleString()} files read so far. You can browse while it runs.`
        : scanned
          ? 'The last scan found no audio files. Check that the folder holds music and is listed above.'
          : 'Reads tags from every file once. A large library can take a while; you can browse while it runs.',
    },
  ]
}
