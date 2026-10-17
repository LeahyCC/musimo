import type { Page, Route } from '@playwright/test'

import type { LibraryTrack } from '../src/api'
import { requestBody } from './library-fixtures'

/* A stand-in for the server's proposal routes, for specs that mock the chat. It keeps revisions
   and receipts the way the real routes do (a retried operation id returns its first receipt, a
   second commit to the same target needs `repeat`, and a refinement names the latest revision),
   so the browser is held to the contract rather than to a canned answer. The real routes are
   covered against generated files in tests/test_proposals.py, and in a browser by
   music-bot-proposals.spec.ts. */

/** What the next commit does instead of answering. `drop-after` lands the write and loses the
 *  reply, which is the case a retry with the same operation id has to reconcile. */
export type CommitFault = 'drop-before' | 'drop-after' | 'stale'

export type ProposalMock = {
  /** Every create and refine request body, in order. */
  creates: Record<string, unknown>[]
  refines: { id: string; body: Record<string, unknown> }[]
  /** Every commit request body, including retries. */
  commits: Record<string, unknown>[]
  /** What commits wrote, once per operation id. */
  saved: { name: string; ids: string[] }[]
  handed: string[][]
  /** Chooses how a commit goes wrong, from its body and how many commits came before it. */
  fault: ((body: Record<string, unknown>, count: number) => CommitFault | undefined) | undefined
  /** Held before each commit answers, to keep a request in flight. */
  hold: Promise<void> | undefined
  /** The songs a create or refine returns, when the default (filter the library) is wrong. */
  pick: ((intent: Record<string, unknown>, base: string[]) => LibraryTrack[]) | undefined
  /** Ids a revision lists that the library no longer has, so they come back in `missing_ids`. */
  ghosts: string[]
  /** Seconds the songs now add up to less than the total stored with the revision. */
  drift: number
  /** Ids a commit's receipt lists beyond the revision's own, as a receipt the card cannot match. */
  receiptExtra: string[]
}

type Stored = { revisions: Map<number, string[]>; latest: number }

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {}
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

const minutes = (seconds: number) => (seconds / 60).toFixed(1)

function envelope(
  code: string,
  message: string,
  fields: { field: string; message: string }[] = [],
) {
  return { contract_version: 3, status: 'error', error: { code, message, fields } }
}

const accepted = (version: unknown, allowed: number[]) =>
  typeof version === 'number' && allowed.includes(version)

/** What the real routes answer to a contract version they do not take. */
const refuseVersion = (route: Route) =>
  route.fulfill({
    status: 422,
    json: envelope('unsupported_version', 'That contract version is not supported.'),
  })

export async function proposalFixtures(page: Page, library: LibraryTrack[]): Promise<ProposalMock> {
  const mock: ProposalMock = {
    creates: [],
    refines: [],
    commits: [],
    saved: [],
    handed: [],
    fault: undefined,
    hold: undefined,
    pick: undefined,
    ghosts: [],
    drift: 0,
    receiptExtra: [],
  }
  const proposals = new Map<string, Stored>()
  const receipts = new Map<string, Record<string, unknown>>()
  const went = new Set<string>()
  let made = 0

  const byId = new Map(library.map((song) => [song.id, song]))
  const songs = (ids: string[]) =>
    ids.flatMap((id) => {
      const found = byId.get(id)
      return found ? [found] : []
    })

  /** The default pick: the proposal's own songs for a refinement, the library otherwise, with
   *  the artists the filters leave out dropped. */
  function choose(intent: Record<string, unknown>, base: string[]): LibraryTrack[] {
    if (mock.pick) return mock.pick(intent, base)
    const filters = object(intent.filters)
    const context = object(intent.context)
    const out = strings(filters.exclude_artists).map((name) => name.toLowerCase())
    const from =
      intent.scope === 'proposal'
        ? songs(base.length ? base : strings(context.proposal_ids))
        : intent.scope === 'queue'
          ? songs(strings(context.queue_ids))
          : library
    return from.filter((song) => !out.includes(song.artist.toLowerCase()))
  }

  function reply(id: string, revision: number, intent: Record<string, unknown>, ids: string[]) {
    const tracks = songs(ids)
    const total = tracks.reduce((sum, song) => sum + song.duration, 0)
    const target = Number(object(intent.filters).target_seconds) || 0
    const short = Math.max(0, target - total)
    const genres = new Map<string, number>()
    for (const song of tracks)
      if (song.genre) genres.set(song.genre, (genres.get(song.genre) ?? 0) + 1)
    const years = tracks.flatMap((song) => (song.year ? [song.year] : []))
    const step = Math.max(1, Math.floor(ids.length / 6))
    const complete = ids.length <= 12
    return {
      contract_version: 3,
      engine_version: 2,
      status: 'ok',
      proposal: {
        id,
        revision,
        latest_revision: proposals.get(id)?.latest ?? revision,
        created: '2026-10-17T00:00:00Z',
        intent,
        seed: intent.seed ?? null,
        ids,
        total_seconds: total,
        shortfall_seconds: short,
        summary:
          `${tracks.length} ${tracks.length === 1 ? 'song' : 'songs'}, ${minutes(total)} minutes. ` +
          'Based on saved library tags.' +
          (short ? ` ${minutes(short)} minutes short; no exclusions were relaxed.` : ''),
        overview: {
          requested: { scope: intent.scope, filters: {} },
          measured: {
            track_count: ids.length,
            // Added up from the songs as they are now, which the stored total need not match.
            total_seconds: total - mock.drift,
            artist_count: new Set(tracks.map((song) => song.artist)).size,
            genres: [...genres].map(([name, count]) => ({ name, count })),
            year_range: years.length ? { min: Math.min(...years), max: Math.max(...years) } : null,
            audio: null,
          },
          unknown: {
            // The server counts a song since removed among those with no length.
            duration_tracks:
              tracks.filter((song) => !song.duration).length + (ids.length - tracks.length),
            year_tracks: tracks.length - years.length,
            genre_tracks: tracks.filter((song) => !song.genre).length,
            artist_tracks: 0,
            missing_tracks: ids.length - tracks.length,
          },
        },
        sample: {
          ids: complete ? ids : ids.filter((_, index) => index % step === 0).slice(0, 6),
          complete,
        },
        snapshot: { id: `snap-${revision}` },
      },
      tracks,
      missing_ids: ids.filter((item) => !byId.has(item)),
      state_changed: false,
    }
  }

  await page.route('**/api/music-bot/proposals', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    const intent = requestBody(route)
    mock.creates.push(intent)
    if (!accepted(intent.contract_version, [1, 2, 3])) return refuseVersion(route)
    const ids = [...choose(intent, []).map((song) => song.id), ...mock.ghosts]
    made += 1
    const id = `pr-${made.toString(16).padStart(16, '0')}`
    proposals.set(id, { revisions: new Map([[1, ids]]), latest: 1 })
    return route.fulfill({ json: reply(id, 1, { ...intent, seed: intent.seed ?? 7 }, ids) })
  })

  await page.route(/\/api\/music-bot\/proposals\/pr-[0-9a-f]{16}\/revisions$/, async (route) => {
    const id = /(pr-[0-9a-f]{16})/.exec(route.request().url())?.[1] ?? ''
    const body = requestBody(route)
    mock.refines.push({ id, body })
    const stored = proposals.get(id)
    if (!stored)
      return route.fulfill({
        status: 404,
        json: envelope('proposal_not_found', 'No such proposal.'),
      })
    if (body.revision !== stored.latest)
      return route.fulfill({
        status: 409,
        json: envelope('revision_superseded', `Revision ${stored.latest} is the latest.`),
      })
    const intent = object(body.intent)
    const base = stored.revisions.get(stored.latest) ?? []
    // A refinement of the stored songs may not carry its own list, as the real route insists.
    if (intent.scope === 'proposal' && strings(object(intent.context).proposal_ids).length)
      return route.fulfill({
        status: 422,
        json: envelope('invalid_intent', 'Leave proposal_ids out.', [
          { field: 'intent.context.proposal_ids', message: 'Not allowed' },
        ]),
      })
    if (!accepted(intent.contract_version, [1, 2, 3])) return refuseVersion(route)
    const ids = [...choose(intent, base).map((song) => song.id), ...mock.ghosts]
    stored.latest += 1
    stored.revisions.set(stored.latest, ids)
    const echoed =
      intent.scope === 'proposal'
        ? { ...intent, context: { ...object(intent.context), proposal_ids: base } }
        : intent
    return route.fulfill({
      json: reply(id, stored.latest, { ...echoed, seed: intent.seed ?? 7 }, ids),
    })
  })

  async function commit(route: Route) {
    const id = /(pr-[0-9a-f]{16})/.exec(route.request().url())?.[1] ?? ''
    const body = requestBody(route)
    mock.commits.push({ ...body, proposal_id: id })
    // A commit body has been version 2 or 3 since proposals arrived.
    if (!accepted(body.contract_version, [2, 3])) return refuseVersion(route)
    if (mock.hold) await mock.hold
    const fault = mock.fault?.(body, mock.commits.length)
    if (fault === 'drop-before') return route.abort('failed')
    if (fault === 'stale')
      return route.fulfill({
        status: 409,
        json: envelope('proposal_stale', '1 thing the proposal depends on changed.', [
          {
            field: `songs.${strings(proposals.get(id)?.revisions.get(Number(body.revision)))[0]}`,
            message: 'The file is unavailable',
          },
        ]),
      })
    const operation = text(body.operation_id)
    const first = receipts.get(operation)
    const stored = proposals.get(id)
    const target = object(body.target)
    const revision = Number(body.revision)
    const ids = stored?.revisions.get(revision)
    if (!stored || !ids)
      return route.fulfill({
        status: 404,
        json: envelope('proposal_not_found', 'No such proposal.'),
      })
    let replayed = false
    let receipt: Record<string, unknown>
    if (first) {
      replayed = true
      receipt = first
    } else {
      if (revision !== stored.latest)
        return route.fulfill({
          status: 409,
          json: envelope('revision_superseded', `Revision ${stored.latest} is the latest.`),
        })
      const key = `${id}:${revision}:${text(target.kind)}`
      if (went.has(key) && body.repeat !== true)
        return route.fulfill({
          status: 409,
          json: envelope('already_committed', 'This revision already went there.'),
        })
      went.add(key)
      const playlist = target.kind === 'playlist'
      const receiptIds = [...ids, ...mock.receiptExtra]
      receipt = {
        operation_id: operation,
        proposal_id: id,
        revision,
        target: text(target.kind),
        ids: receiptIds,
        status: playlist ? 'saved' : 'ready_for_player',
        playlist_id: playlist ? `pl-${mock.saved.length + 1}` : null,
        playlist_name: playlist ? text(target.name) : null,
        created: '2026-10-17T00:00:00Z',
      }
      receipts.set(operation, receipt)
      if (playlist) mock.saved.push({ name: text(target.name), ids: receiptIds })
      else mock.handed.push(receiptIds)
    }
    if (fault === 'drop-after') return route.abort('failed')
    return route.fulfill({
      json: { contract_version: 3, status: 'ok', receipt, replayed },
    })
  }

  await page.route(/\/api\/music-bot\/proposals\/pr-[0-9a-f]{16}\/commit$/, commit)

  return mock
}

/** An installed model named in the settings and in the model list, so the chat takes requests.
 *  The chat reply itself is each spec's own to serve. */
export async function botModelFixtures(page: Page): Promise<void> {
  const named = (data: unknown) => ({
    ...(data && typeof data === 'object' ? data : {}),
    ollama_model: { value: 'fixture', origin: 'database', locked: false },
    music_timezone: { value: 'Pacific/Honolulu', origin: 'database', locked: false },
  })
  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch()
    const data = object(await response.json())
    await route.fulfill({ json: { ...data, settings: named(data.settings) } })
  })

  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    await route.fulfill({ json: named(await response.json()) })
  })

  await page.route('**/api/music-bot/models', (route) =>
    route.fulfill({ json: { models: ['fixture'], elapsed_ms: 2 } }),
  )
}
