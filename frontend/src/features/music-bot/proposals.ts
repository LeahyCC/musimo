import { z } from 'zod'

import { libraryTrackSchema } from '../../api'
import type { BotReply } from '../../api'

/* The browser's side of the server's proposals (`/api/music-bot/proposals`): a result is stored
   as a revision, refined into the next one, and committed by id, revision and operation id. The
   server picks and keeps the songs. Nothing here chooses, sorts or swaps one; it builds the
   request the chat's own plan describes and reads what comes back. */

/** The engine's contract version. An intent may say 1 to 5, a commit 2 to 5 and an edit only 5, so
 *  this one number is accepted by create, refine, edit and commit. Version 3 added
 *  `filters.total_length`, which the chat never sets but a stored intent can carry, so it is kept
 *  when an intent is sent again. Version 4 is the first where an omitted `shown_ids` means the
 *  server's memory of shown songs, which is what the chat relies on. Version 5 added the edit route
 *  and the fields behind it (`exclude_ids`, `keep_ids`, `pinned_ids`, `add_count`), so the chat
 *  never sends an older one. */
export const CONTRACT_VERSION = 5

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
  // Version 5: songs never picked, the ones a person removed. An intent an older build stored
  // has none, and says so.
  exclude_ids: idList.default([]),
})

const contextSchema = z.object({
  current_id: z.string().nullable(),
  reference_id: z.string().nullable(),
  proposal_ids: idList,
  queue_ids: idList,
  // Null asks the server to use its own memory of what was shown. A preview an older build stored
  // holds a list instead.
  shown_ids: idList.nullable(),
  // Version 5, library scope. Kept songs go first as they are, pinned ones are those a person
  // protected, and `add_count` is how many new songs follow them (null: as the filters say).
  keep_ids: idList.default([]),
  pinned_ids: idList.default([]),
  add_count: z.number().int().nullable().default(null),
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
  snapshot: z.object({
    // The memory revision the songs were chosen against. Null when the request named its own
    // list or read none. A stand-in server may leave `shown` out.
    shown: z.object({ memory_revision: z.number().int().nullable() }).optional(),
  }),
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

/** The latest revision of a proposal. Reads only. */
export const readProposal = (id: string, signal?: AbortSignal) =>
  send(`proposals/${id}`, proposalReplySchema, { method: 'GET', signal })

/** A change to the latest revision. The server writes the new intent from the stored one, so the
 *  filters and the length carry over and the browser cannot change them by accident. */
export type ProposalEdit =
  /** The same filters and a fresh seed. `pinnedIds` replaces the revision's pins; left out, they
   *  stay as they are. */
  | { kind: 'another'; pinnedIds?: readonly string[] }
  /** Every song stays, then up to `count` new ones that fit the same filters. */
  | { kind: 'add'; count: number }
  /** These songs go and are never picked again in this proposal. */
  | { kind: 'remove'; ids: readonly string[] }

const editReplySchema = proposalReplySchema.extend({ replayed: z.boolean() })
export type EditReply = z.infer<typeof editReplySchema>

function editBody(edit: ProposalEdit): Record<string, unknown> {
  if (edit.kind === 'remove') return { kind: 'remove', ids: [...edit.ids] }
  if (edit.kind === 'add') return { kind: 'add', count: edit.count }
  return edit.pinnedIds === undefined
    ? { kind: 'another' }
    : { kind: 'another', pinned_ids: [...edit.pinnedIds] }
}

/**
 * Stores the next revision for an edit. `revision` must be the latest, and `operationId` is made
 * once per press and sent again unchanged when no answer came: the server then returns the
 * revision its first attempt made (`replayed: true`) instead of adding or removing twice. A failure
 * to hear an answer is `UnknownOutcome`; a typed refusal is `ProposalError` and wrote nothing.
 */
export async function editProposal(
  id: string,
  revision: number,
  operationId: string,
  edit: ProposalEdit,
  signal?: AbortSignal,
): Promise<EditReply> {
  try {
    return await send(`proposals/${id}/edits`, editReplySchema, {
      method: 'POST',
      signal,
      body: {
        contract_version: CONTRACT_VERSION,
        revision,
        operation_id: operationId,
        edit: editBody(edit),
      },
    })
  } catch (problem) {
    // A reply that cannot be read may be the answer to a write that happened, and 499 is what a
    // dropped connection leaves behind, so neither is a refusal: the same operation id is asked
    // again.
    if (
      problem instanceof ProposalError &&
      problem.status < 500 &&
      problem.status !== 499 &&
      problem.code !== 'invalid_response'
    )
      throw problem
    throw new UnknownOutcome(problem instanceof Error ? problem.message : 'No answer.')
  }
}

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
  /** Why a result was not recorded when that is not a repeat: "forgotten" means the memory was
   *  forgotten (perhaps on another device) after this result was made. Not an error. */
  reason: z.string().default(''),
})
export type ShownMemory = z.infer<typeof memorySchema>

export const readMemory = (signal?: AbortSignal) =>
  send('memory', memorySchema, { method: 'GET', signal })

/** Tells the server a stored library revision was shown. It reads the songs from the revision,
 *  and the same revision sent twice counts once. `memoryRevision` is the memory the result was
 *  built against, so a Forget pressed elsewhere while the card was on its way is respected: the
 *  server then answers `recorded: false, reason: "forgotten"`. */
export const presentResult = (
  id: string,
  revision: number,
  memoryRevision: number | null,
  signal?: AbortSignal,
) =>
  send('memory/shown', memorySchema, {
    method: 'POST',
    body: { proposal_id: id, revision, memory_revision: memoryRevision },
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
    // A reply that cannot be read may be the receipt of a write that happened, and 499 is what a
    // dropped connection leaves behind, so neither is a refusal: the same operation id is asked
    // again.
    if (
      problem instanceof ProposalError &&
      problem.status < 500 &&
      problem.status !== 499 &&
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
 * so the preview is the server's result rather than a copy of the chat's. An answer that adds
 * songs (`add_count`) while its filters changed has no intent of its own, so `freeze` states the
 * exact list as a selection to keep, which a person can then commit as it is.
 *
 * `carry` is what the open proposal remembers. The songs a person removed travel with every
 * refinement, so one taken off never comes back. The pinned songs travel only with a library
 * search, where the server keeps them first as they are. A refinement of a proposal or the queue
 * only narrows a list that is already there, with no draw to protect a song from, so it drops the
 * pins.
 */
export function intentFromReply(
  reply: BotReply,
  context: IntentContext,
  freeze?: readonly string[],
  carry?: Carry,
): Intent {
  const { plan } = reply
  const frozen = freeze !== undefined
  const scope = frozen ? 'proposal' : plan.scope
  const pins = scope === 'library' ? [...(carry?.pinnedIds ?? [])] : []
  return {
    contract_version: CONTRACT_VERSION,
    action: 'search',
    scope,
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
      exclude_ids: [...(carry?.excludeIds ?? [])],
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
      keep_ids: pins,
      pinned_ids: pins,
      add_count: null,
    },
    explanation: '',
  }
}

/** What an open proposal keeps across a follow-up. */
export type Carry = {
  /** The songs a person removed. */
  excludeIds: readonly string[]
  /** The songs a person pinned. */
  pinnedIds: readonly string[]
}

/**
 * Whether the chat's answer asks for the same search as the open revision, so that adding a song
 * can be the server's edit of that revision. The filters a person can see are compared. Left out
 * are the removed songs and the total length, which are the server's and not the plan's, and
 * `limit`: the chat's own answer to "add a song" raises its limit to the kept songs plus the new
 * one, while the edit sets that itself. A comparison with a song also needs the same song, since
 * the edit carries the one the revision was made with.
 */
export function sameSearch(reply: BotReply, open: Intent): boolean {
  if (open.scope !== 'library' || reply.plan.scope !== 'library') return false
  const asked: Record<string, unknown> = { ...open.filters }
  const now: Record<string, unknown> = {
    ...intentFromReply(reply, { proposalIds: [], queueIds: [] }).filters,
  }
  for (const left of ['exclude_ids', 'total_length', 'limit']) {
    delete asked[left]
    delete now[left]
  }
  const same = Object.keys(asked).every(
    (key) => JSON.stringify(asked[key]) === JSON.stringify(now[key]),
  )
  const { plan } = reply
  const compares =
    plan.similar_to_current || plan.energy_compared !== '' || plan.tempo_compared !== ''
  return (
    same &&
    (!compares ||
      (reply.reference_id === open.context.reference_id &&
        reply.current_id === open.context.current_id))
  )
}

/** A refinement of a stored revision uses that revision's songs, so the server refuses ids. */
function refinementOf(intent: Intent): Intent {
  // A repeat reads the memory as it is now, not a list an older build stored with the intent.
  // It also says the current version, since an intent an older build stored says 3 or lower,
  // which reads no memory.
  const context = { ...intent.context, shown_ids: null }
  const current = { ...intent, contract_version: CONTRACT_VERSION }
  return intent.scope === 'proposal'
    ? { ...current, context: { ...context, proposal_ids: [] } }
    : { ...current, context }
}

/**
 * The same request again, for a preview that went stale. It keeps the seed and the filters. `gone`
 * are songs the library no longer has: a kept song is never dropped quietly by the server, so one
 * that left the library would refuse the whole request (`unknown_song`). The refresh drops it here
 * instead, and the caller says so.
 */
export function refreshIntent(intent: Intent, gone: readonly string[] = []): Intent {
  const again = refinementOf(intent)
  if (!gone.length) return again
  const left = new Set(gone)
  return {
    ...again,
    context: {
      ...again.context,
      keep_ids: again.context.keep_ids.filter((song) => !left.has(song)),
      pinned_ids: again.context.pinned_ids.filter((song) => !left.has(song)),
    },
  }
}

/** The songs a refusal names as kept but unplayable (their folder is offline). The server keeps
 *  such a song in the list and says which, so the person can take it out. Null for any other
 *  refusal. */
export function unavailableSongs(problem: unknown): string[] | null {
  if (!(problem instanceof ProposalError) || problem.code !== 'song_unavailable') return null
  return problem.fields.flatMap(
    ({ field }) => /^context\.keep_ids\.(tr-[0-9a-f]{16})$/.exec(field)?.[1] ?? [],
  )
}

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
