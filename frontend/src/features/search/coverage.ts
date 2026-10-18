import type { DownloadJob, MusicResult } from '../../api'
import type { CoverageCounts } from '../../ui'
import { activeJob } from '../downloads/jobs'

/** The catalog tracks that have a download running or waiting, from the job list. */
export function queuedTrackIds(jobs: readonly DownloadJob[]): Set<number> {
  const ids = new Set<number>()
  for (const job of jobs)
    if (job.catalog === 'deezer' && !job.hidden && activeJob(job)) ids.add(job.track_id)
  return ids
}

/**
 * An album's tracks sorted into the coverage bar's parts. A track that is owned or has another
 * edition in the library counts there even when a job is also running, since the file is already
 * here; only a track still missing can be queued.
 */
export function trackCoverage(tracks: readonly MusicResult[], queued: ReadonlySet<number>) {
  const counts: CoverageCounts = { owned: 0, otherEdition: 0, queued: 0, missing: 0 }
  for (const track of tracks) {
    if (track.ownership === 'owned') counts.owned++
    else if (track.ownership === 'edition') counts.otherEdition++
    else if (queued.has(track.id)) counts.queued++
    else counts.missing++
  }
  return counts
}

/**
 * An artist's releases as songs. The release rows carry a song count and how many of them the
 * library tags match, so this is an estimate until each album's own page has been checked, and it
 * cannot tell "another edition" apart; that part of the bar is left out for an artist.
 *
 * Deezer's artist listing often has no song counts at all (every `track_count` is 0). That is
 * "not known", not "nothing missing", so it returns undefined and the page says nothing.
 */
export function releaseCoverage(
  releases: readonly MusicResult[],
  jobs: readonly DownloadJob[],
): CoverageCounts | undefined {
  const ids = new Set(releases.map((release) => release.id))
  const total = releases.reduce((sum, release) => sum + release.track_count, 0)
  if (total === 0) return undefined
  const owned = releases.reduce(
    (sum, release) => sum + Math.min(release.owned_count, release.track_count),
    0,
  )
  const queued = Math.min(
    total - owned,
    jobs.filter(
      (job) => job.catalog === 'deezer' && !job.hidden && activeJob(job) && ids.has(job.album_id),
    ).length,
  )
  return { owned, otherEdition: 0, queued, missing: Math.max(0, total - owned - queued) }
}

/** "7/10" for an album card; empty until the release has a song count. */
export function ownedFraction(item: Pick<MusicResult, 'owned_count' | 'track_count'>): string {
  return item.track_count > 0 ? `${item.owned_count}/${item.track_count}` : ''
}

/** How much of a release the library holds, for the thin bar under its card. 0 to 1. */
export function ownedShare(item: Pick<MusicResult, 'owned_count' | 'track_count'>): number {
  return item.track_count > 0 ? Math.min(1, item.owned_count / item.track_count) : 0
}
