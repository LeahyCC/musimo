import { describe, expect, it } from 'vitest'

import { jobSchema } from '../../api'
import type { DownloadJob } from '../../api'
import {
  batchSegments,
  causeGroups,
  dayLabel,
  failedStep,
  groupJobs,
  jobFraction,
  jobStep,
  matchConfidence,
  reasonChips,
  sourcesTried,
  withDays,
} from './job-steps'

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

const candidate = (id: string, source: string, score = 0.5) => ({
  id,
  title: 'Take',
  artist: 'Artist',
  duration: 180,
  score,
  topic: false,
  reason: 'close',
  source,
  source_label: '',
  url: '',
})

describe('jobStep', () => {
  it('puts each running stage on its own step', () => {
    const steps = ['matching', 'downloading', 'converting', 'tagging', 'moving', 'scanning'].map(
      (stage) => jobStep(job({ stage, error_code: '' })).current,
    )
    // Moving and the scan after it are one step: the model has no step between them.
    expect(steps).toEqual(['match', 'download', 'convert', 'tag', 'move', 'move'])
  })

  it('shows download progress only when the size is known', () => {
    expect(jobStep(job({ stage: 'downloading', progress: 0.62, total: 100 })).label).toBe(
      'Downloading · 62%',
    )
    expect(jobStep(job({ stage: 'downloading', progress: 0, total: 0 })).label).toBe('Downloading')
  })

  it('claims no step for jobs that kept no record of one', () => {
    for (const stage of ['queued', 'paused', 'pausing', 'retry_wait', 'cancelling', 'cancelled'])
      expect(jobStep(job({ stage })).current).toBe('queued')
    expect(jobStep(job({ stage: 'queued' })).tone).toBe('good')
    expect(jobStep(job({ stage: 'paused' }))).toMatchObject({ tone: 'warn', label: 'Paused' })
    expect(jobStep(job({ stage: 'retry_wait', retry_at: 0 })).label).toBe('Waiting to retry')
  })

  it('finishes every step when done', () => {
    expect(jobStep(job({ stage: 'done' }))).toEqual({
      current: 'done',
      tone: 'good',
      label: 'Done',
    })
  })

  it('reads the failed step from the error code, and guesses none when the code is ambiguous', () => {
    expect(jobStep(job({ error_code: 'COOKIES_EXPIRED' }))).toEqual({
      current: 'download',
      tone: 'danger',
      label: 'Failed at download',
    })
    expect(jobStep(job({ error_code: 'TRANSCODE_FAILED' })).current).toBe('convert')
    expect(jobStep(job({ error_code: 'TAG_FAILED' })).label).toBe('Failed at tagging')
    expect(jobStep(job({ error_code: 'MOVE_FAILED' })).current).toBe('move')
    expect(jobStep(job({ error_code: 'DISK_FULL' }))).toEqual({
      current: 'queued',
      tone: 'danger',
      label: 'Failed',
    })
    expect(failedStep('DEST_UNWRITABLE')).toBeUndefined()
  })

  it('holds a missing recording at Match as a warning, not an error', () => {
    expect(jobStep(job({}))).toEqual({ current: 'match', tone: 'warn', label: 'No close match' })
  })
})

describe('jobFraction', () => {
  it('counts each step as a fifth and fills the download step with its progress', () => {
    expect(jobFraction(job({ stage: 'queued' }))).toBe(0)
    expect(jobFraction(job({ stage: 'matching' }))).toBe(0)
    expect(jobFraction(job({ stage: 'downloading', progress: 0.5, total: 10 }))).toBeCloseTo(0.3)
    expect(jobFraction(job({ stage: 'tagging' }))).toBeCloseTo(0.6)
    expect(jobFraction(job({ stage: 'done' }))).toBe(1)
    expect(jobFraction(job({ stage: 'failed' }))).toBe(1)
  })
})

describe('groupJobs', () => {
  it('groups by batch, then by album, then loose tracks, in the order they were queued', () => {
    const groups = groupJobs([
      job({ id: 'single', created_at: 1 }),
      job({ id: 'b2', batch_id: 'batch', batch_label: 'Mordechai', created_at: 3 }),
      job({
        id: 'album',
        album_id: 9,
        meta: { ...job({}).meta, album: 'Universe' },
        created_at: 4,
      }),
      job({ id: 'b1', batch_id: 'batch', created_at: 2 }),
    ])
    expect(groups.map((group) => [group.key, group.title, group.batchId])).toEqual([
      ['single', 'Single tracks', ''],
      ['batch', 'Mordechai', 'batch'],
      ['album:9', 'Universe', ''],
    ])
    expect(groups[1]?.jobs.map((row) => row.id)).toEqual(['b1', 'b2'])
  })

  it('draws one segment per track', () => {
    expect(
      batchSegments([
        job({ stage: 'done' }),
        job({ stage: 'downloading' }),
        job({ stage: 'failed' }),
        job({ stage: 'queued' }),
        job({ stage: 'paused' }),
      ]),
    ).toEqual(['done', 'running', 'failed', 'waiting', 'waiting'])
  })
})

describe('causeGroups', () => {
  it('gathers failures by code, hint and fix, biggest first', () => {
    const cookie = {
      error_code: 'COOKIES_EXPIRED',
      error_hint: 'Sign in',
      error_fix: 'settings:sources',
    }
    const groups = causeGroups([
      job({ id: 'a', error_code: 'MOVE_FAILED', error_hint: 'Move', error_fix: '' }),
      job({ id: 'b', ...cookie }),
      job({ id: 'c', ...cookie }),
    ])
    expect(groups.map((group) => [group.code, group.jobs.length, group.fix])).toEqual([
      ['COOKIES_EXPIRED', 2, 'settings:sources'],
      ['MOVE_FAILED', 1, ''],
    ])
  })

  it('names each reason once on the chips and drops empty ones', () => {
    expect(
      reasonChips([
        { code: 'RATE_LIMITED', message: 'a', count: 2 },
        { code: 'RATE_LIMITED', message: 'b', count: 1 },
        { code: 'ODD', message: 'Something odd', count: 1 },
        { code: 'DISK_FULL', message: '', count: 0 },
      ]),
    ).toEqual([
      { code: 'RATE_LIMITED', name: 'Rate limited', count: 3 },
      { code: 'ODD', name: 'Something odd', count: 1 },
    ])
  })
})

describe('no match and done details', () => {
  it('counts the near candidates each source sent back', () => {
    expect(
      sourcesTried(
        job({
          candidates: [
            candidate('1', 'youtube'),
            candidate('2', 'youtube'),
            candidate('3', 'soundcloud'),
          ],
        }),
      ),
    ).toEqual([
      { source: 'youtube', label: 'Youtube', count: 2 },
      { source: 'soundcloud', label: 'Soundcloud', count: 1 },
    ])
  })

  it('badges the match only when the job carries a score or the check flag', () => {
    expect(matchConfidence(job({ stage: 'done' }))).toBeNull()
    expect(matchConfidence(job({ check_match: true }))).toEqual({
      tone: 'warn',
      text: 'Check match',
    })

    expect(
      matchConfidence(job({ candidates: [candidate('x', 'youtube', 0.92)], selected: 'x' })),
    ).toEqual({ tone: 'good', text: '92% match' })

    expect(
      matchConfidence(job({ candidates: [candidate('x', 'youtube', 0.6)], selected: 'x' })),
    ).toEqual({ tone: 'warn', text: '60% match' })
  })
})

describe('history days', () => {
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime() / 1000
  const now = at(2026, 10, 17, 15) * 1000

  it('names today and yesterday, and dates the rest', () => {
    expect(dayLabel(at(2026, 10, 17, 1), now)).toMatch(/^TODAY · /)
    expect(dayLabel(at(2026, 10, 16, 23), now)).toBe('YESTERDAY')
    expect(dayLabel(at(2026, 10, 15), now)).not.toMatch(/TODAY|YESTERDAY/)
    expect(dayLabel(at(2025, 10, 15), now)).toMatch(/2025/)
  })

  it('puts a heading on the first row of each day only', () => {
    const rows = [at(2026, 10, 17, 14), at(2026, 10, 17, 9), at(2026, 10, 16), at(2026, 10, 15)]
    const headed = withDays(
      rows.map((created_at) => ({ created_at })),
      now,
    ).map((row) => row.heading)
    expect(headed[0]).toMatch(/^TODAY/)
    expect(headed[1]).toBe('')
    expect(headed[2]).toBe('YESTERDAY')
    expect(headed[3]).not.toBe('')
  })
})
