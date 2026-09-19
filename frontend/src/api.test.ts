import { describe, expect, it } from 'vitest'

import { jobSchema } from './api'

const job = {
  id: 'a',
  track_id: 1,
  format: 'original',
  target: '/music',
  stage: 'queued',
  desired: 'run',
  meta: { id: 1, title: 'Song', artist: 'Band', album: 'Song', art: '', duration: 200 },
  candidates: [],
  selected: '',
  check_match: false,
  attempts: 0,
  retry_at: 0,
  progress: 0,
  downloaded: 0,
  total: 0,
  speed: 0,
  eta: null,
  error_code: '',
  error: '',
  retryable: false,
  error_hint: '',
  error_fix: '',
  tool_tail: '',
  tool_version: '',
  warnings: [],
  final_path: '',
  codec: '',
  actual_bitrate: 0,
  created_at: 0,
  updated_at: 0,
  hidden: false,
}

describe('jobSchema', () => {
  // One unreadable job would empty the whole queue, so every catalog the server stores must parse.
  it('reads jobs from every catalog', () => {
    for (const catalog of ['deezer', 'podcast', 'link'])
      expect(jobSchema.parse({ ...job, catalog }).catalog).toBe(catalog)
  })

  // A server from before notes existed leaves the field out, and the queue still has to load.
  it('gives a job with no notes an empty list, and keeps the notes a server sends', () => {
    expect(jobSchema.parse(job).notes).toEqual([])
    const noted = jobSchema.parse({ ...job, notes: ['Tagged from the Deezer catalog'] })
    expect(noted.notes).toEqual(['Tagged from the Deezer catalog'])
    expect(noted.warnings).toEqual([])
  })
})
