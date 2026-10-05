import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'

import { jobSchema } from './api'
import type { DownloadJob } from './api'
import { errorJob, failureTallies, unmatchedJob, updateJob } from './downloads'
import type { QueueData } from './downloads'

const job = (over: Partial<DownloadJob>): DownloadJob =>
  jobSchema.parse({
    id: 'job',
    batch_id: '',
    batch_label: '',
    album_id: 0,
    catalog: 'deezer',
    source: 'youtube',
    track_id: 1,
    format: 'original',
    target: '/music',
    stage: 'failed',
    desired: 'run',
    meta: { id: 1, title: 'Song', artist: 'Artist', album: '', art: '', duration: 180 },
    candidates: [],
    selected: '',
    check_match: false,
    attempts: 1,
    retry_at: 0,
    progress: 0,
    downloaded: 0,
    total: 0,
    speed: 0,
    eta: null,
    error_code: 'NO_MATCH',
    error: 'No sufficiently close recording found',
    retryable: false,
    error_hint: 'No matching recording was found on YouTube.',
    error_fix: 'card:pick',
    tool_tail: '',
    tool_version: '',
    warnings: [],
    notes: [],
    final_path: '',
    codec: '',
    actual_bitrate: 0,
    created_at: 1,
    updated_at: 1,
    hidden: false,
    ...over,
  })

describe('failure piles', () => {
  it('splits no match from real failures', () => {
    const missing = job({})
    const broken = job({ error_code: 'SOURCE_BLOCKED' })
    expect([unmatchedJob(missing), errorJob(missing)]).toEqual([true, false])
    expect([unmatchedJob(broken), errorJob(broken)]).toEqual([false, true])
    expect(failureTallies(undefined, [missing, broken, job({ stage: 'done' })])).toEqual({
      unmatched: 1,
      errors: 1,
    })
  })

  it('moves a retried job out of the reason row that holds its hint', () => {
    // The server groups reasons by hint as well, and a no-match hint names the sources asked.
    // Matching on code and message alone took the count from the wrong row.
    const both = job({
      id: 'both',
      error_hint: 'No matching recording was found on YouTube or SoundCloud.',
    })
    const client = new QueryClient()
    const reasons: QueueData['summary']['failure_reasons'] = [
      {
        code: 'NO_MATCH',
        message: both.error,
        hint: 'No matching recording was found on YouTube.',
        fix: 'card:pick',
        count: 2,
      },
      { code: 'NO_MATCH', message: both.error, hint: both.error_hint, fix: 'card:pick', count: 1 },
    ]
    client.setQueryData<QueueData>(['jobs'], {
      jobs: [both],
      controls: { paused: false, source_paused: false, paused_sources: [], source_labels: {} },
      summary: { active: 0, failed: 3, failure_reasons: reasons },
    })

    updateJob(client, {
      ...both,
      stage: 'queued',
      error_code: '',
      error: '',
      error_hint: '',
      error_fix: '',
    })
    const after = client.getQueryData<QueueData>(['jobs'])?.summary.failure_reasons
    expect(after?.map((reason) => [reason.hint, reason.count])).toEqual([
      ['No matching recording was found on YouTube.', 2],
    ])
  })
})
