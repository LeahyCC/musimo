import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { api, ApiError, jobSchema, validationMessage } from './api'

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

describe('api errors', () => {
  afterEach(() => vi.unstubAllGlobals())

  function failWith(body: unknown, status = 422) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    )
  }

  it('shows the detail a server sends as text', async () => {
    failWith({ detail: 'Paste the arl cookie.', code: 'bad_arl' }, 400)
    const error = await api('settings', z.object({})).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).message).toBe('Paste the arl cookie.')
    expect((error as ApiError).code).toBe('bad_arl')
  })

  // FastAPI's own validation answer is a list, and a bare "Request failed (422)" says nothing useful.
  it("joins the messages of a validation list, without pydantic's prefix", async () => {
    failWith({
      detail: [
        {
          loc: ['body', 'deezer_arl'],
          msg: 'Value error, Paste the arl cookie from a Deezer login.',
          type: 'value_error',
        },
        { loc: ['body', 'port'], msg: 'Field required', type: 'missing' },
      ],
    })

    await expect(api('settings', z.object({}))).rejects.toThrow(
      'Paste the arl cookie from a Deezer login. Field required.',
    )
  })

  it('falls back to the status when the body says nothing readable', async () => {
    failWith({ detail: [] }, 500)
    await expect(api('settings', z.object({}))).rejects.toThrow('Request failed (500)')
  })
})

describe('validationMessage', () => {
  it('keeps a message that has no prefix as it is', () => {
    expect(validationMessage([{ msg: 'Too long.' }])).toBe('Too long.')
  })
})
