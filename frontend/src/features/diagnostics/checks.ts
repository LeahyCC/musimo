import type { z } from 'zod'

import type { diagnosticsSchema } from '../../api'
import { lastDownloadMark, lastDownloadSummary, rootIsReady, scanIsReady } from './readiness'
import { sourceProblems } from './source-status'

type Diagnostics = z.infer<typeof diagnosticsSchema>
type Disk = Diagnostics['disks'][number]

/* What the Diagnostics page draws, worked out once. Both layouts show the same checks and the same
   five pipeline steps; they only lay them out differently. The yes-or-no answer for the whole
   system is `systemIsReady`, and these rows are built from the same rules (`readiness.ts`,
   `source-status.ts`), so a row cannot say Ready while the banner says otherwise. */

/** `good` is ready, `danger` is not, `warn` is working but with something to look at, and `idle` is
 *  not tested or not there. The page turns each into a color. */
export type Tone = 'good' | 'warn' | 'danger' | 'idle'

export type CheckAction =
  { kind: 'test-write'; label: string } | { kind: 'resume'; label: string; source: string }

export type ReadinessCheck = {
  id: string
  name: string
  /** The word on the pill: Ready, Not ready, Paused, Not tested. */
  state: string
  tone: Tone
  /** A line in words. */
  detail: string
  /** A path, drawn in the mono face under the name. */
  path?: string
  /** Free space on a disk, for the meter. */
  disk?: Disk
  action?: CheckAction
}

const toneOf = (ready: boolean): Tone => (ready ? 'good' : 'danger')

/** The same words the page has always used for how much room is left. */
export function diskLine(disk: Disk | undefined, formatSize: (bytes: number | null) => string) {
  if (!disk?.exists) return 'Not mounted'

  return disk.writable ? `${formatSize(disk.free_bytes)} free` : 'Not writable'
}

/**
 * Every check, in the order the page lists them. `destination` is the folder downloads go to, which
 * only Settings knows; without it that row is left out rather than guessed.
 */
export function buildChecks(
  data: Diagnostics,
  destination: string | undefined,
  paused: readonly { source: string; label: string }[],
  formatSize: (bytes: number | null) => string,
): ReadinessCheck[] {
  const pausedIds = new Set(paused.map((row) => row.source))
  const checks: ReadinessCheck[] = []

  for (const root of data.library.roots) {
    const disk = data.disks.find((d) => d.path === root)
    const ready = rootIsReady(data.disks, root)
    checks.push({
      id: `root-${root}`,
      name: 'Library root',
      state: ready ? 'Ready' : 'Not ready',
      tone: toneOf(ready),
      detail: diskLine(disk, formatSize),
      path: root,
      disk,
    })
  }

  if (destination !== undefined) {
    const disk = data.disks.find((d) => d.path === destination)
    const ready = Boolean(disk?.exists && disk.writable)
    checks.push({
      id: 'destination',
      name: 'Download destination',
      state: ready ? 'Ready' : 'Not ready',
      tone: toneOf(ready),
      detail: diskLine(disk, formatSize),
      path: destination,
      action: ready ? { kind: 'test-write', label: 'Test write' } : undefined,
    })
  }

  const scanReady = scanIsReady(data.library.status)
  checks.push({
    id: 'scan',
    name: 'Library scan',
    state: scanReady ? 'Ready' : 'Not ready',
    tone: toneOf(scanReady),
    detail:
      data.library.status === 'idle'
        ? `${data.library.total_files} files indexed`
        : data.library.status === 'scanning'
          ? `Scanning (${data.library.indexed} files)`
          : data.library.detail,
  })

  if (data.player) {
    const { available, configured } = data.player
    checks.push({
      id: 'player',
      name: 'Player',
      state: available ? 'Ready' : configured ? 'Not ready' : 'Not configured',
      tone: available ? 'good' : configured ? 'danger' : 'idle',
      detail: available ? data.player.version : data.player.detail,
    })
  }

  for (const source of data.sources.filter((row) => row.source === 'youtube')) {
    const ready = source.status === 'healthy'
    checks.push({
      id: 'youtube',
      name: 'YouTube download helper',
      state: ready ? 'Ready' : 'Not ready',
      tone: toneOf(ready),
      detail: `${source.detail}${pausedIds.has('youtube') ? ' · Paused' : ''}`,
    })
  }

  for (const problem of sourceProblems(data.sources, paused, data.download_sources)) {
    if (problem.id === 'youtube') continue
    checks.push({
      id: `source-${problem.id}`,
      name: problem.title,
      state: problem.paused ? 'Paused' : 'Not ready',
      tone: 'danger',
      detail: problem.detail,
      action: problem.paused
        ? { kind: 'resume', label: `Try ${problem.label} again`, source: problem.id }
        : undefined,
    })
  }

  const last = data.last_download
  if (last) {
    const mark = lastDownloadMark(last.stage, last.error_code)
    checks.push({
      id: 'last-download',
      name: 'Last download',
      state: mark.word,
      tone: mark.tone === 'ready' ? 'good' : mark.tone === 'not-ready' ? 'danger' : 'idle',
      detail: `${lastDownloadSummary(last.stage, last.error_code)} · ${new Date(last.created_at * 1000).toLocaleString()}`,
    })
  } else {
    checks.push({
      id: 'last-download',
      name: 'Last download',
      state: 'Not tested',
      tone: 'idle',
      detail: 'No download attempted yet',
    })
  }

  return checks
}

export type PipelineStep = {
  id: 'catalog' | 'sources' | 'worker' | 'library' | 'player'
  name: string
  tone: Tone
  /** A few words, drawn small and in the mono face. */
  detail: string
}

/**
 * The five stops a song passes: the catalog that names it, the sources that fetch it, the worker
 * that runs the queue, the library it lands in and the player that plays it. Each reads from what
 * the server reports, and a step it reports nothing for says so instead of looking fine.
 */
export function buildPipeline(
  data: Diagnostics,
  paused: readonly { source: string; label: string }[],
): PipelineStep[] {
  const catalog = data.sources.find((row) => row.source === 'deezer')
  const listed = data.download_sources
  const trouble = new Set([
    ...sourceProblems(data.sources, paused, listed).map((problem) => problem.id),
    ...listed.filter((source) => !source.working).map((source) => source.id),
  ])
  const working = listed.filter((source) => !trouble.has(source.id)).length
  const rootsReady = data.library.roots.every((root) => rootIsReady(data.disks, root))
  const scanReady = scanIsReady(data.library.status)
  const queuePaused = data.queue.paused || paused.length > 0

  return [
    {
      id: 'catalog',
      name: 'Catalog',
      tone: !catalog ? 'idle' : catalog.status === 'healthy' ? 'good' : 'danger',
      detail: !catalog
        ? 'Not reported'
        : catalog.status !== 'healthy'
          ? catalog.detail || catalog.status
          : catalog.latency_ms === null
            ? 'Deezer'
            : `Deezer · ${catalog.latency_ms} ms`,
    },
    {
      id: 'sources',
      name: 'Sources',
      tone: listed.length === 0 ? 'idle' : trouble.size === 0 ? 'good' : 'warn',
      detail: listed.length === 0 ? 'None reported' : `${working} of ${listed.length} ready`,
    },
    {
      id: 'worker',
      name: 'Worker',
      tone: queuePaused ? 'warn' : 'good',
      detail: data.queue.paused
        ? 'queue paused'
        : paused.length > 0
          ? `${paused.length} source paused`
          : 'queue running',
    },
    {
      id: 'library',
      name: 'Library',
      tone: toneOf(rootsReady && scanReady),
      detail: !rootsReady
        ? 'folder not ready'
        : !scanReady
          ? data.library.detail
          : `${data.library.total_files.toLocaleString()} files`,
    },
    {
      id: 'player',
      name: 'Player',
      tone:
        !data.player || !data.player.configured
          ? 'idle'
          : data.player.available
            ? 'good'
            : 'danger',
      detail: !data.player
        ? 'Not reported'
        : data.player.available
          ? 'ready'
          : data.player.configured
            ? 'not ready'
            : 'not configured',
    },
  ]
}

/** "5 of 6 checks pass", for the line under the banner. */
export function checkSummary(checks: readonly ReadinessCheck[]) {
  const passing = checks.filter((check) => check.tone === 'good').length

  return `${passing} of ${checks.length} checks pass`
}
