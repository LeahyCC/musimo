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

/** Failures of one recording. They are not a broken source or a broken install. */
const ONE_RECORDING = new Set([
  'NO_MATCH',
  'DURATION_MISMATCH',
  'GEO_RESTRICTED',
  'LIVE_STREAM',
  'AGE_RESTRICTED',
  'SITE_NOT_ALLOWED',
])

const ONE_RECORDING_TEXT: Record<string, string> = {
  NO_MATCH: 'No close recording',
  DURATION_MISMATCH: 'The file length did not match',
  GEO_RESTRICTED: 'Not available in this country',
  LIVE_STREAM: 'Live streams are not saved',
  AGE_RESTRICTED: 'That video needs a sign-in',
  SITE_NOT_ALLOWED: 'That site is not supported',
}

/** The last-download line. A single missed song stays in plain words, without its code. */
export function lastDownloadSummary(stage: string, code: string) {
  if (stage === 'done') return 'Completed successfully'
  if (stage === 'cancelled') return 'Cancelled'
  const plain = ONE_RECORDING_TEXT[code]
  if (plain) return plain
  return code ? `Failed: ${code}` : 'Failed'
}

/** Whether that last download means the install needs a look. One missed song does not. */
export function lastDownloadConcernsSystem(stage: string, code: string) {
  if (stage === 'done' || stage === 'cancelled') return false
  return !ONE_RECORDING.has(code)
}

export type LastDownloadMark = {
  tone: 'ready' | 'not-ready' | 'not-tested'
  word: 'Success' | 'Failed' | 'Note'
}

/** The last-download chip. One answer for its color and its word. */
export function lastDownloadMark(stage: string, code: string): LastDownloadMark {
  if (stage === 'done') return { tone: 'ready', word: 'Success' }
  if (lastDownloadConcernsSystem(stage, code)) return { tone: 'not-ready', word: 'Failed' }
  return { tone: 'not-tested', word: 'Note' }
}

/** The one answer to "is the system ready", shared by Settings and Diagnostics so the two can
 *  never disagree. An unconfigured Navidrome (null) does not count against it, only an
 *  unreachable one. Every reported source counts, not only YouTube. A song with no match does not. */
export function systemIsReady(data: Diagnostics) {
  const rootsReady = data.library.roots.every((root) => rootIsReady(data.disks, root))
  const navidromeDown = data.navidrome !== null && !data.navidrome.available
  const youtube = data.sources.find((s) => s.source === 'youtube')
  const sourcesReady =
    youtube?.status === 'healthy' && data.sources.every((source) => source.status === 'healthy')
  const last = data.last_download
  const lastDownloadOk = !last || !lastDownloadConcernsSystem(last.stage, last.error_code)
  return (
    rootsReady &&
    scanIsReady(data.library.status) &&
    !navidromeDown &&
    sourcesReady &&
    lastDownloadOk
  )
}
