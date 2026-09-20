import type { z } from 'zod'

import type { diagnosticsSchema } from './api'

type Diagnostics = z.infer<typeof diagnosticsSchema>

/** A finished scan is a healthy state; only an interrupted, failed or cancelled one needs a person
 *  to look at it. */
export const scanIsReady = (status: string) => ['idle', 'scanning', 'done'].includes(status)

/** Whether a library root is mounted, writable and reporting its free space. */
export function rootIsReady(disks: Diagnostics['disks'], root: string) {
  const disk = disks.find((d) => d.path === root)
  return Boolean(disk?.exists && disk.writable && disk.free_bytes !== null)
}

/** The one answer to "is the system ready", shared by Settings and Diagnostics so the two can
 *  never disagree. An unconfigured Navidrome (null) does not count against it, only an
 *  unreachable one. */
export function systemIsReady(data: Diagnostics) {
  const rootsReady = data.library.roots.every((root) => rootIsReady(data.disks, root))
  const navidromeDown = data.navidrome !== null && !data.navidrome.available
  const youtubeReady = data.sources.find((s) => s.source === 'youtube')?.status === 'healthy'
  const lastDownloadOk = !data.last_download || data.last_download.stage === 'done'
  return (
    rootsReady &&
    scanIsReady(data.library.status) &&
    !navidromeDown &&
    youtubeReady &&
    lastDownloadOk
  )
}
