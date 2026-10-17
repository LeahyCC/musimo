import { afterEach, describe, expect, it, vi } from 'vitest'

import { botReplySchema, libraryTrackSchema } from '../../api'
import type { BotReply } from '../../api'
import {
  commitProposal,
  CONTRACT_VERSION,
  createProposal,
  forgetMemory,
  idChanges,
  intentFromReply,
  intentSchema,
  newOperationId,
  presentResult,
  ProposalError,
  proposalReplySchema,
  readMemory,
  refineProposal,
  refreshIntent,
  UnknownOutcome,
} from './proposals'

const song = (n: number) => `tr-${n.toString(16).padStart(16, '0')}`

const plan = {
  action: 'search',
  scope: 'library',
  artists: [],
  exclude_artists: ['Harbor Static'],
  genres: ['Rock'],
  year_from: 1990,
  year_to: 1999,
  favourites: false,
  history: 'any',
  exclude_played_days: 0,
  min_seconds: 0,
  max_seconds: null,
  target_seconds: 3600,
  limit: 100,
  similar_to_current: false,
  explanation: '',
}

function reply(changes: Record<string, unknown> = {}, extra: Partial<BotReply> = {}): BotReply {
  return botReplySchema.parse({
    plan: { ...plan, ...changes },
    tracks: [1, 2, 3].map((n) =>
      libraryTrackSchema.parse({ id: song(n), title: `Song ${n}`, duration: 240 }),
    ),
    total_seconds: 720,
    shortfall_seconds: 0,
    summary: '3 songs.',
    elapsed_ms: 5,
    generation_seed: 77,
    reference_id: song(9),
    current_id: song(8),
    ...extra,
  })
}

const context = { proposalIds: [song(1), song(2)], queueIds: [song(3)] }

describe('intentFromReply', () => {
  it('repeats a library draw: the plan’s filters, its seed and the songs it was made against', () => {
    const intent = intentFromReply(reply(), context)
    expect(intent).toMatchObject({
      contract_version: 4,
      action: 'search',
      scope: 'library',
      seed: 77,
      filters: {
        genres: ['Rock'],
        exclude_artists: ['Harbor Static'],
        year_from: 1990,
        year_to: 1999,
        target_seconds: 3600,
        limit: 100,
      },
      context: {
        current_id: song(8),
        reference_id: song(9),
        shown_ids: null,
        proposal_ids: [],
        queue_ids: [],
      },
    })
  })

  it('sends only the list a scope reads, since the server refuses the others', () => {
    expect(intentFromReply(reply({ scope: 'proposal' }), context)).toMatchObject({
      scope: 'proposal',
      seed: null,
      context: { proposal_ids: [song(1), song(2)], queue_ids: [], shown_ids: null },
    })

    expect(intentFromReply(reply({ scope: 'queue' }), context)).toMatchObject({
      scope: 'queue',
      seed: null,
      context: { proposal_ids: [], queue_ids: [song(3)], shown_ids: null },
    })
  })

  it('never sends the shown songs: the server reads its own memory', () => {
    for (const scope of ['library', 'proposal', 'queue']) {
      expect(intentFromReply(reply({ scope }), context).context.shown_ids).toBeNull()
    }
  })

  it('keeps an exact list as a selection to refine, with no seed to redraw it', () => {
    const intent = intentFromReply(reply({ add_count: 2 }), context, [song(1), song(5)])
    expect(intent.scope).toBe('proposal')
    expect(intent.seed).toBeNull()
    expect(intent.context.proposal_ids).toEqual([song(1), song(5)])
    expect(intent.context.shown_ids).toBeNull()
  })
})

describe('contract version', () => {
  it('is one the server accepts for an intent (1 to 4) and for a commit (2 to 4)', () => {
    expect(CONTRACT_VERSION).toBeGreaterThanOrEqual(2)
    expect(CONTRACT_VERSION).toBeLessThanOrEqual(4)
    expect(intentFromReply(reply(), context).contract_version).toBe(CONTRACT_VERSION)
  })

  it('is 4 or more, the first version where an omitted shown list reads the server memory', () => {
    expect(CONTRACT_VERSION).toBeGreaterThanOrEqual(4)
  })

  it('upgrades an intent an older build stored, so a refresh still reads the memory', () => {
    const older = { ...intentFromReply(reply(), context), contract_version: 3 }
    expect(refreshIntent(older).contract_version).toBe(CONTRACT_VERSION)
    expect(refreshIntent({ ...older, scope: 'proposal' }).contract_version).toBe(CONTRACT_VERSION)
  })

  it('asks for no total length, since the chat has only the old fill target', () => {
    expect(intentFromReply(reply(), context).filters.total_length).toBeNull()
  })

  it('keeps a total length a stored intent carries, so a refresh asks for the same one', () => {
    const stored = {
      ...intentFromReply(reply(), context),
      filters: {
        ...intentFromReply(reply(), context).filters,
        total_length: { mode: 'about', seconds: 3600 },
      },
    }
    expect(intentSchema.parse(stored).filters.total_length).toEqual({
      mode: 'about',
      seconds: 3600,
    })

    expect(refreshIntent(intentSchema.parse(stored)).filters.total_length).toEqual({
      mode: 'about',
      seconds: 3600,
    })
  })

  it('reads an older stored intent that has no total length as none', () => {
    const { total_length: _, ...filters } = intentFromReply(reply(), context).filters
    expect(
      intentSchema.parse({ ...intentFromReply(reply(), context), filters }).filters.total_length,
    ).toBeNull()
  })
})

describe('refreshIntent', () => {
  it('leaves a library intent, with its seed, as it ran', () => {
    const intent = intentFromReply(reply(), context)
    expect(refreshIntent(intent)).toEqual(intent)
  })

  it('drops the song list of a refinement, which the server reads from the revision', () => {
    const intent = intentFromReply(reply({ scope: 'proposal' }), context)
    expect(refreshIntent(intent).context.proposal_ids).toEqual([])
    expect(refreshIntent(intent).scope).toBe('proposal')
  })
})

describe('idChanges', () => {
  it('counts the songs that came in and the songs that left', () => {
    expect(idChanges([song(1), song(2), song(3)], [song(2), song(3), song(4), song(5)])).toEqual({
      added: 2,
      removed: 1,
    })
    expect(idChanges([song(1)], [song(1)])).toEqual({ added: 0, removed: 0 })
  })
})

describe('newOperationId', () => {
  it('fits the server’s rule and is new each time', () => {
    const ids = new Set(Array.from({ length: 50 }, newOperationId))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9._:-]{8,80}$/)
  })
})

const proposal = {
  id: 'pr-0123456789abcdef',
  revision: 1,
  latest_revision: 1,
  intent: intentFromReply(reply(), context),
  seed: 77,
  ids: [song(1)],
  total_seconds: 240,
  shortfall_seconds: 0,
  summary: '1 song.',
  overview: {
    requested: { scope: 'library', filters: {} },
    measured: {
      track_count: 1,
      total_seconds: 240,
      artist_count: 1,
      genres: [],
      year_range: null,
      audio: null,
    },
    unknown: {
      duration_tracks: 0,
      year_tracks: 1,
      genre_tracks: 1,
      artist_tracks: 0,
      missing_tracks: 0,
    },
  },
  sample: { ids: [song(1)], complete: true },
  snapshot: { id: 'snap-1', shown: { memory_revision: 5 } },
}
const receipt = {
  operation_id: 'op-12345678',
  proposal_id: proposal.id,
  revision: 1,
  target: 'queue',
  ids: [song(1)],
  status: 'ready_for_player',
  playlist_id: null,
  playlist_name: null,
  created: '2026-10-17T00:00:00Z',
}

function answer(status: number, body: unknown) {
  const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(Response.json(body, { status })))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

function sentBody(fetcher: ReturnType<typeof answer>): Record<string, unknown> {
  const init = fetcher.mock.calls[0]?.[1]
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

afterEach(() => vi.unstubAllGlobals())

describe('the proposal routes', () => {
  it('creates a proposal from an intent and reads the revision back', async () => {
    const fetcher = answer(200, { proposal, tracks: [], missing_ids: [] })
    const made = await createProposal(intentFromReply(reply(), context))
    expect(made.proposal.id).toBe(proposal.id)
    expect(fetcher).toHaveBeenCalledWith(
      '/api/music-bot/proposals',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('refines the named revision, and sends no song list for a refinement', async () => {
    const fetcher = answer(200, { proposal, tracks: [], missing_ids: [] })
    await refineProposal(proposal.id, 3, intentFromReply(reply({ scope: 'proposal' }), context))
    expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/music-bot/proposals/${proposal.id}/revisions`)
    const body = sentBody(fetcher)
    expect(body.revision).toBe(3)
    expect(body.intent).toMatchObject({ scope: 'proposal', context: { proposal_ids: [] } })
  })

  it('commits by id, revision and operation id, and nothing else', async () => {
    const fetcher = answer(200, { receipt, replayed: false })
    const done = await commitProposal(proposal.id, {
      revision: 1,
      operationId: 'op-12345678',
      target: { kind: 'queue' },
      repeat: false,
    })
    expect(done.receipt.status).toBe('ready_for_player')
    expect(sentBody(fetcher)).toEqual({
      contract_version: 4,
      revision: 1,
      operation_id: 'op-12345678',
      target: { kind: 'queue' },
      repeat: false,
    })
  })

  it('reads a typed refusal, with the changes a stale commit names', async () => {
    answer(409, {
      status: 'error',
      error: {
        code: 'proposal_stale',
        message: '1 thing changed.',
        fields: [{ field: `songs.${song(1)}`, message: 'The file is unavailable' }],
      },
    })
    const refusal = await commitProposal(proposal.id, {
      revision: 1,
      operationId: 'op-12345678',
      target: { kind: 'queue' },
      repeat: false,
    }).catch((problem: unknown) => problem)
    expect(refusal).toBeInstanceOf(ProposalError)
    expect(refusal).toMatchObject({
      code: 'proposal_stale',
      status: 409,
      fields: [{ field: `songs.${song(1)}`, message: 'The file is unavailable' }],
    })
  })

  it('calls a commit with no clear answer unknown, so the same id is asked again', async () => {
    const request = {
      revision: 1,
      operationId: 'op-12345678',
      target: { kind: 'playlist', name: 'Road' },
      repeat: false,
    } as const
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )
    await expect(commitProposal(proposal.id, request)).rejects.toBeInstanceOf(UnknownOutcome)
    answer(502, 'Bad gateway')
    await expect(commitProposal(proposal.id, request)).rejects.toBeInstanceOf(UnknownOutcome)
    answer(500, { status: 'error', error: { code: 'internal_error', message: 'Failed.' } })
    await expect(commitProposal(proposal.id, request)).rejects.toBeInstanceOf(UnknownOutcome)
  })

  it('calls a commit reply it cannot read unknown, since the write may have happened', async () => {
    const request = {
      revision: 1,
      operationId: 'op-12345678',
      target: { kind: 'queue' },
      repeat: false,
    } as const
    // A 200 whose body is not a receipt, and a 200 that is not JSON at all.
    answer(200, { receipt: { operation_id: 'op-12345678' } })
    await expect(commitProposal(proposal.id, request)).rejects.toBeInstanceOf(UnknownOutcome)
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() => Promise.resolve(new Response('<html>', { status: 200 }))),
    )
    await expect(commitProposal(proposal.id, request)).rejects.toBeInstanceOf(UnknownOutcome)
  })

  it('still calls an unreadable create reply a plain failure: it only writes a preview', async () => {
    answer(200, { proposal: {} })
    await expect(createProposal(intentFromReply(reply(), context))).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })

  it('does not call a typed refusal unknown: nothing was written', async () => {
    answer(409, { status: 'error', error: { code: 'already_committed', message: 'Again?' } })
    await expect(
      commitProposal(proposal.id, {
        revision: 1,
        operationId: 'op-12345678',
        target: { kind: 'queue' },
        repeat: false,
      }),
    ).rejects.toMatchObject({ code: 'already_committed' })
  })
})

describe('the shown-song memory routes', () => {
  const memory = { status: 'ok', profile: 'default', revision: 2, results: 1, songs: 3 }

  it('reads what the server holds', async () => {
    const fetcher = answer(200, { ...memory, recorded: false })
    expect(await readMemory()).toEqual({
      revision: 2,
      results: 1,
      songs: 3,
      recorded: false,
      reason: '',
    })
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/music-bot/memory')
  })

  it('reports a presentation by proposal and revision, never by song', async () => {
    const fetcher = answer(200, { ...memory, recorded: true })
    expect((await presentResult(proposal.id, 4, 5)).recorded).toBe(true)
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/music-bot/memory/shown')
    expect(sentBody(fetcher)).toEqual({ proposal_id: proposal.id, revision: 4, memory_revision: 5 })
  })

  it('says which memory revision the result was built against, or none', async () => {
    const fetcher = answer(200, { ...memory, recorded: true })
    await presentResult(proposal.id, 1, null)
    expect(sentBody(fetcher)).toMatchObject({ memory_revision: null })
  })

  it('reads a result that was not recorded after a forget as an answer, not an error', async () => {
    answer(200, { ...memory, results: 0, songs: 0, recorded: false, reason: 'forgotten' })
    await expect(presentResult(proposal.id, 1, 5)).resolves.toMatchObject({
      recorded: false,
      reason: 'forgotten',
      songs: 0,
    })
  })

  it('reads the memory revision a stored proposal was built against', () => {
    expect(
      proposalReplySchema.parse({ proposal, tracks: [], missing_ids: [] }).proposal.snapshot,
    ).toEqual({ shown: { memory_revision: 5 } })
  })

  it('forgets with a DELETE and no body', async () => {
    const fetcher = answer(200, { ...memory, revision: 3, results: 0, songs: 0, recorded: false })
    expect((await forgetMemory()).songs).toBe(0)
    expect(fetcher).toHaveBeenCalledWith(
      '/api/music-bot/memory',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(fetcher.mock.calls[0]?.[1]?.body).toBeUndefined()
  })

  it('reads a typed refusal', async () => {
    answer(404, {
      status: 'error',
      error: { code: 'proposal_not_found', message: 'No such proposal.' },
    })

    await expect(presentResult(proposal.id, 1, null)).rejects.toMatchObject({
      code: 'proposal_not_found',
      status: 404,
    })
  })
})
