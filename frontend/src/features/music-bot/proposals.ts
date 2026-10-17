import { z } from 'zod'

import { libraryTrackSchema } from '../../api'
import type { BotReply } from '../../api'

/* The browser's side of the server's proposals (`/api/music-bot/proposals`): a result is stored
   as a revision, refined into the next one, and committed by id, revision and operation id. The
   server picks and keeps the songs. Nothing here chooses, sorts or swaps one; it builds the
   request the chat's own plan describes and reads what comes back. */

/** The engine's contract version. An intent may say 1 to 3 and a commit 2 or 3, so this one
 *  number is accepted by create, refine and commit. Version 3 added `filters.total_length`, which
 *  the chat never sets but a stored intent can carry, so it is kept when an intent is sent again. */
export const CONTRACT_VERSION = 3

const idList = z.array(z.string())
const range = z.object({ min: z.number(), max: z.number() }).nullable()
const coverage = z.object({ measured: z.number(), total: z.number() })

const filtersSchema = z.object({
  artists: idList,
  exclude_artists: idList,
  genres: idList,
  year_from: z.number().nullable(),
  year_to: z.number().nullable(),
  favourites: z.boolean(),
  history: z.enum(['any', 'played', 'unplayed', 'familiar']),
  exclude_played_days: z.number(),
  min_seconds: z.number(),
  max_seconds: z.number().nullable(),
  target_seconds: z.number(),
  // Version 3. Kept as the server sent it, so a refresh asks for the same total length.
  total_length: z.record(z.string(), z.unknown()).nullable().default(null),
  limit: z.number(),
  similar_to_current: z.boolean(),
  tempo: z.enum(['', 'slow', 'medium', 'fast']),
  tempo_min: z.number().nullable(),
  tempo_max: z.number().nullable(),
  energy: z.enum(['', 'low', 'medium', 'high']),
  energy_compared: z.enum(['', 'calmer', 'more_intense']),
  tempo_compared: z.enum(['', 'slower', 'faster']),
  sound: z.string(),
})

const contextSchema = z.object({
  current_id: z.string().nullable(),
  reference_id: z.string().nullable(),
  proposal_ids: idList,
  queue_ids: idList,
  // Null asks the server to use its own memory of what was shown. A preview an older build stored
  // holds a list instead.
  shown_ids: idList.nullable(),
})

/** The canonical request a proposal is made from, as the server echoes it with its seed. */
export const intentSchema = z.object({
  contract_version: z.number(),
  action: z.literal('search'),
  scope: z.enum(['library', 'proposal', 'queue']),
  filters: filtersSchema,
  seed: z.number().nullable(),
  context: contextSchema,
  explanation: z.string(),
})
export type Intent = z.infer<typeof intentSchema>

/** Three kinds of fact, kept apart: what was asked, what the songs show, and what is unknown. */
export const overviewSchema = z.object({
  measured: z.object({
    track_count: z.number(),
    total_seconds: z.number(),
    artist_count: z.number(),
    genres: z.array(z.object({ name: z.string(), count: z.number() })),
    year_range: z.object({ min: z.number(), max: z.number() }).nullable(),
    // Null unless a tempo and energy recipe is on. A genre name never stands in for it.
    audio: z
      .object({
        tempo: range,
        energy: range,
        tempo_coverage: coverage,
        energy_coverage: coverage,
      })
      .nullable(),
  }),
  unknown: z.object({
    duration_tracks: z.number(),
    year_tracks: z.number(),
    genre_tracks: z.number(),
    artist_tracks: z.number(),
    missing_tracks: z.number(),
  }),
})
export type Overview = z.infer<typeof overviewSchema>

const proposalSchema = z.object({
  id: z.string(),
  revision: z.number().int(),
  latest_revision: z.number().int(),
  intent: intentSchema,
  seed: z.number().nullable(),
  ids: idList,
  total_seconds: z.number(),
  shortfall_seconds: z.number(),
  summary: z.string(),
  overview: overviewSchema,
  sample: z.object({ ids: idList, complete: z.boolean() }),
})

export const proposalReplySchema = z.object({
  proposal: proposalSchema,
  tracks: z.array(libraryTrackSchema).max(500),
  missing_ids: idList,
})
export type ProposalReply = z.infer<typeof proposalReplySchema>

const receiptSchema = z.object({
  operation_id: z.string(),
  proposal_id: z.string(),
  revision: z.number().int(),
  target: z.enum(['playlist', 'queue']),
  ids: idList,
  // Never "playing": the server does not know whether audio started.
  status: z.enum(['saved', 'ready_for_player']),
  playlist_id: z.string().nullable(),
  playlist_name: z.string().nullable(),
})
export type Receipt = z.infer<typeof receiptSchema>
const commitReplySchema = z.object({ receipt: receiptSchema, replayed: z.boolean() })
export type CommitReply = z.infer<typeof commitReplySchema>

const envelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fields: z.array(z.object({ field: z.string(), message: z.string() })).default([]),
  }),
})

/** The server refused, in its typed envelope. Nothing was written unless the status says 5xx. */
export class ProposalError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly fields: { field: string; message: string }[] = [],
  ) {
    super(message)
    this.name = 'ProposalError'
  }
}

/** A commit got no clear answer (the network dropped, it timed out, or the server failed), so it
 *  may or may not have gone through. Sending the same operation id again finds out. */
export class UnknownOutcome extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnknownOutcome'
  }
}

function failure(status: number, data: unknown): ProposalError {
  const typed = envelopeSchema.safeParse(data)
  if (typed.success) {
    const { code, message, fields } = typed.data.error
    return new ProposalError(message, code, status, fields)
  }
  // FastAPI's own errors, such as the 499 a cancelled request gets.
  const plain = z.object({ detail: z.string() }).safeParse(data)
  return new ProposalError(
    plain.success ? plain.data.detail : `Request failed (${status}).`,
    'http_error',
    status,
  )
}

async function send<T>(
  path: string,
  schema: z.ZodType<T>,
  init: { method: 'POST' | 'GET' | 'DELETE'; body?: unknown; signal?: AbortSignal },
): Promise<T> {
  const response = await fetch(`/api/music-bot/${path}`, {
    method: init.method,
    signal: init.signal,
    ...(init.body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) }),
  })
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok) throw failure(response.status, data)
  const parsed = schema.safeParse(data)
  if (!parsed.success)
    throw new ProposalError(
      'The server answered in a form I could not read.',
      'invalid_response',
      200,
    )
  return parsed.data
}

/** Stores a result as revision 1. Writes only the proposal tables: no playlist, queue or play. */
export const createProposal = (intent: Intent, signal?: AbortSignal) =>
  send('proposals', proposalReplySchema, { method: 'POST', body: intent, signal })

/** The next revision of the same proposal. `revision` must be the latest one. */
export const refineProposal = (
  id: string,
  revision: number,
  intent: Intent,
  signal?: AbortSignal,
) =>
  send(`proposals/${id}/revisions`, proposalReplySchema, {
    method: 'POST',
    body: { revision, intent: refinementOf(intent) },
    signal,
  })

/** What the server remembers of the library results already shown, for every device. It is
 *  suggestion memory: songs shown go after equally fitting ones, and are never a taste score. */
const memorySchema = z.object({
  revision: z.number().int(),
  /** Presented results kept (at most three). */
  results: z.number().int(),
  /** Distinct songs those results give a search to put last (at most 500). */
  songs: z.number().int(),
  /** Whether this call added a result. False for a repeat of one already recorded. */
  recorded: z.boolean(),
})
export type ShownMemory = z.infer<typeof memorySchema>

export const readMemory = (signal?: AbortSignal) =>
  send('memory', memorySchema, { method: 'GET', signal })

/** Tells the server a stored library revision was shown. It reads the songs from the revision,
 *  and the same revision sent twice counts once. */
export const presentResult = (id: string, revision: number, signal?: AbortSignal) =>
  send('memory/shown', memorySchema, {
    method: 'POST',
    body: { proposal_id: id, revision },
    signal,
  })

/** Forgets the shown songs on every device. Play history, likes and playlists are not touched. */
export const forgetMemory = () => send('memory', memorySchema, { method: 'DELETE' })

export type CommitTarget = { kind: 'playlist'; name: string } | { kind: 'queue' }

export type CommitRequest = {
  revision: number
  operationId: string
  target: CommitTarget
  /** Says yes to committing a revision again to a target it already went to. */
  repeat: boolean
}

/** Saves or hands back exactly this revision. It never runs the search again. A failure to hear
 *  an answer is `UnknownOutcome`; a typed refusal is `ProposalError` and wrote nothing. */
export async function commitProposal(
  id: string,
  request: CommitRequest,
  signal?: AbortSignal,
): Promise<CommitReply> {
  try {
    return await send(`proposals/${id}/commit`, commitReplySchema, {
      method: 'POST',
      signal,
      body: {
        contract_version: CONTRACT_VERSION,
        revision: request.revision,
        operation_id: request.operationId,
        target: request.target,
        repeat: request.repeat,
      },
    })
  } catch (problem) {
    // A reply that cannot be read may be the receipt of a write that happened, so it is not a
    // refusal: the same operation id is asked again.
    if (
      problem instanceof ProposalError &&
      problem.status < 500 &&
      problem.code !== 'invalid_response'
    )
      throw problem
    throw new UnknownOutcome(problem instanceof Error ? problem.message : 'No answer.')
  }
}

/** A fresh id for one user action. Made once, and sent again unchanged when that action is
 *  retried, so the server returns the first receipt instead of doing it twice. */
export function newOperationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return `op-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/** The songs the chat's request was made against. What was shown lately is the server's to read. */
export type IntentContext = {
  proposalIds: readonly string[]
  queueIds: readonly string[]
}

/**
 * The intent that makes the chat's own selection again: its plan's filters, the seed it drew, and
 * the songs it was made against. The server then stores what that intent resolves to,
 * so the preview is the server's result rather than a copy of the chat's. A refinement of the
 * chat's list (`add_count`) has no intent of its own, so `freeze` states the exact list as a
 * selection to keep, which a person can then commit as it is.
 */
export function intentFromReply(
  reply: BotReply,
  context: IntentContext,
  freeze?: readonly string[],
): Intent {
  const { plan } = reply
  const frozen = freeze !== undefined
  return {
    contract_version: CONTRACT_VERSION,
    action: 'search',
    scope: frozen ? 'proposal' : plan.scope,
    filters: {
      artists: plan.artists,
      exclude_artists: plan.exclude_artists,
      genres: plan.genres,
      year_from: plan.year_from,
      year_to: plan.year_to,
      favourites: plan.favourites,
      history: plan.history,
      exclude_played_days: plan.exclude_played_days,
      min_seconds: plan.min_seconds,
      max_seconds: plan.max_seconds,
      target_seconds: plan.target_seconds,
      total_length: null,
      limit: plan.limit,
      similar_to_current: plan.similar_to_current,
      tempo: plan.tempo,
      tempo_min: plan.tempo_min,
      tempo_max: plan.tempo_max,
      energy: plan.energy,
      energy_compared: plan.energy_compared,
      tempo_compared: plan.tempo_compared,
      sound: plan.sound,
    },
    // A seed repeats a library draw. A kept list was not drawn.
    seed: !frozen && plan.scope === 'library' ? reply.generation_seed : null,
    context: {
      current_id: reply.current_id,
      reference_id: reply.reference_id,
      proposal_ids: frozen
        ? [...freeze]
        : plan.scope === 'proposal'
          ? [...context.proposalIds]
          : [],
      queue_ids: !frozen && plan.scope === 'queue' ? [...context.queueIds] : [],
      // Never sent: the server reads its own memory for a library search, and none otherwise.
      shown_ids: null,
    },
    explanation: '',
  }
}

/** A refinement of a stored revision uses that revision's songs, so the server refuses ids. */
function refinementOf(intent: Intent): Intent {
  // A repeat reads the memory as it is now, not a list an older build stored with the intent.
  const context = { ...intent.context, shown_ids: null }
  return intent.scope === 'proposal'
    ? { ...intent, context: { ...context, proposal_ids: [] } }
    : { ...intent, context }
}

/** The same request again, for a preview that went stale. It keeps the seed and the filters. */
export const refreshIntent = (intent: Intent): Intent => refinementOf(intent)

/** Songs in `after` that were not in `before`, and the other way round. */
export function idChanges(
  before: readonly string[],
  after: readonly string[],
): { added: number; removed: number } {
  const had = new Set(before)
  const has = new Set(after)
  return {
    added: after.filter((id) => !had.has(id)).length,
    removed: before.filter((id) => !has.has(id)).length,
  }
}
