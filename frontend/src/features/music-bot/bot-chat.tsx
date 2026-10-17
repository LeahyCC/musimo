import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'

import {
  api,
  botModelsSchema,
  botReplySchema,
  botSelectionSchema,
  librarySchema,
  settingsSchema,
} from '../../api'
import type { BotReply, BotScope, LibraryTrack } from '../../api'
import { usePlayer } from '../player/player'
import type { BotQueueAction } from '../player/player'
import {
  cardLine,
  COMMAND_HELP,
  explainFailure,
  isDirectCommand,
  rememberShown,
  resultLine,
  SHOWN_GENERATIONS,
  SHOWN_LIMIT,
  shownIds,
} from './bot-replies'
import type { BotFailure } from './bot-replies'
import type { ChatOutcome } from './pet-mood'
import { usePetSettings } from './pet-settings'
import { refreshedNote, staleLines } from './preview-text'
import {
  commitProposal,
  createProposal,
  idChanges,
  intentFromReply,
  intentSchema,
  newOperationId,
  overviewSchema,
  ProposalError,
  refineProposal,
  refreshIntent,
  UnknownOutcome,
} from './proposals'
import type { CommitReply, IntentContext, ProposalReply } from './proposals'

/* The music bot's conversation, shared by every place it opens: the pet's popover, the phone
   sheet and the /music-bot page. One provider means a chat started on the pet carries on in the
   page and back, and a reply that lands while the chat is closed can wake the pet.

   The model only reads the request. The server picks the songs and keeps them as a numbered
   revision of a proposal. Save and queue commit that revision by id, so a confirmation never runs
   the search again, and the player refuses a queue that changed underneath. Nothing here decides
   what plays. */

const HISTORY_KEY = 'musimo.music-bot.history'
const PROPOSAL_KEY = 'musimo.music-bot.proposal'
const LOG_KEY = 'musimo.music-bot.log'
const SHOWN_KEY = 'musimo.music-bot.shown'
const PREVIEW_KEY = 'musimo.music-bot.preview'
const shownSchema = z
  .array(z.array(z.string().regex(/^tr-[0-9a-f]{16}$/)).max(SHOWN_LIMIT))
  .max(SHOWN_GENERATIONS)
/** The stored revision the card shows. Its songs are `BotReply.tracks`; this is the rest. */
const previewSchema = z.object({
  id: z.string(),
  revision: z.number().int(),
  intent: intentSchema,
  overview: overviewSchema,
  /** About six songs standing for a long list. All of it when `complete`. */
  sampleIds: z.array(z.string()),
  complete: z.boolean(),
  /** Songs the revision lists that the library no longer has (the server's `missing_ids`). */
  missing: z.number().int().default(0),
})
export type Preview = z.infer<typeof previewSchema>

/** Why the last confirmation did not go through, and what the card offers next. */
export type Problem =
  | { kind: 'stale'; changes: string[] }
  | { kind: 'unknown'; what: 'save' | 'queue' }
  | { kind: 'repeat'; what: 'save' | 'queue' }

type Command = { kind: 'playlist'; name: string } | { kind: 'queue'; action: BotQueueAction }
/** A confirmation sent but not yet answered. Its operation id is sent again, never replaced. */
type Attempt = { command: Command; preview: Preview; operationId: string; repeat: boolean }

/** How long to wait before asking again with the same operation id after a dropped answer. */
export const RECONCILE_DELAY = 800
const COMMIT_TIMEOUT = 20_000
const QUEUE_MOVED = 'The queue changed. Ask again before applying.'

/** The model is told about this many recent messages. */
export const HISTORY_LIMIT = 8
/** What the chat shows. Older entries scroll away. */
const LOG_LIMIT = 40
/** Ollama keeps a model loaded this long after a reply (`keep_alive` in music_bot.py). */
const WARM_MS = 60_000
export const MAX_PROMPT = 2000

const historySchema = z
  .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(MAX_PROMPT) }))
  .max(HISTORY_LIMIT)
type Message = z.infer<typeof historySchema>[number]

const logEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.number(),
    kind: z.literal('user'),
    text: z.string().max(MAX_PROMPT),
    about: z.string().max(300).optional(),
  }),
  z.object({
    id: z.number(),
    kind: z.literal('reply'),
    text: z.string().max(2000),
    mood: z.enum(['talking', 'happy', 'confused', 'sorry']),
    suggestions: z.array(z.string().max(60)).max(3).default([]),
    // Set on a search result. The newest one renders as the live card; older ones as this line.
    card: z.string().max(300).optional(),
    note: z.string().max(200).optional(),
  }),
  z.object({
    id: z.number(),
    kind: z.literal('command'),
    icon: z.enum(['pause', 'play', 'skip']),
    text: z.string().max(400),
  }),
  z.object({ id: z.number(), kind: z.literal('note'), text: z.string().max(400) }),
  z.object({
    id: z.number(),
    kind: z.literal('error'),
    aside: z.string().max(200),
    text: z.string().max(1000),
    tone: z.enum(['danger', 'warn']),
    next: z.enum(['retry', 'send-again', 'replace']).nullable(),
    prompt: z.string().max(MAX_PROMPT).optional(),
  }),
])
export type LogEntry = z.infer<typeof logEntrySchema>
/** An entry before it has an id. Omit spread over the union, so each kind keeps its own fields. */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never
type NewEntry = WithoutId<LogEntry>
const logSchema = z.object({
  entries: z.array(logEntrySchema).max(LOG_LIMIT),
  cardId: z.number().nullable(),
})

function readSession<T>(key: string, schema: z.ZodType<T>, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key)
    if (raw === null) return fallback
    const parsed = schema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : fallback
  } catch {
    return fallback
  }
}

export type Reference = { id: string; label: string }
export type Applied = { action: BotQueueAction; count: number; undo: 'ready' | 'refused' | 'done' }

type BotChat = {
  name: string
  settings: ReturnType<typeof useSettingsQuery>
  models: ReturnType<typeof useModelsQuery>
  model: string
  chooseModel: (name: string) => void
  choosingModel: boolean
  /** Why the chat cannot take a request right now, if it cannot. */
  locked: 'busy' | 'offline' | 'nomodel' | null
  scan: z.infer<typeof librarySchema> | undefined
  log: readonly LogEntry[]
  /** The entry whose result is live, with actions. */
  cardId: number | null
  reply: BotReply | null
  /** The stored revision behind `reply`, or null before one exists. */
  preview: Preview | null
  /** Why the last confirmation did not go through. Set until it is dealt with. */
  problem: Problem | null
  /** Playlists saved from this preview, so the card can say so. */
  savedAs: readonly string[]
  /** Does what the problem offers: refresh the preview, or ask again with the same id. */
  resolveProblem: () => void
  /** Runs the same request again as the next revision of the open proposal. */
  refreshPreview: () => void
  dismissProblem: () => void
  applied: Applied | null
  /** The selection was restored after a reload, so the queue check needs a fresh request. */
  stale: boolean
  reference: Reference | null
  setReference: (reference: Reference | null) => void
  /** A scope the person picked for the next request, or null to let the model read the words. */
  scope: BotScope | null
  setScope: (scope: BotScope | null) => void
  /** What the radio shows: the pick, or what the last answer used. */
  shownScope: BotScope
  thinking: boolean
  startedAt: number | null
  cold: boolean
  applying: boolean
  /** A confirmation is out. It cannot be cancelled, since the server may already have recorded it. */
  confirming: boolean
  send: (text: string) => Promise<void>
  cancel: () => void
  apply: (action: BotQueueAction, singleId?: string) => Promise<void>
  save: (name: string) => Promise<boolean>
  undo: () => void
  removeSong: (id: string) => Promise<void>
  clear: () => void
  retry: (entry: Extract<LogEntry, { kind: 'error' }>) => void
  /** For the pet: the last result of a request, and when. */
  outcome: { mood: ChatOutcome; at: number } | null
  unread: boolean
  latestReply: string
  open: boolean
  setOpen: (open: boolean) => void
  /** When the track last changed, and when playback paused, for the pet's poses. */
  trackChangedAt: number | null
  pausedAt: number | null
}

const BotChatContext = createContext<BotChat | null>(null)

export function useBotChat(): BotChat {
  const chat = useContext(BotChatContext)
  if (!chat) throw new Error('useBotChat needs MusicBotProvider')
  return chat
}

const useSettingsQuery = () =>
  useQuery({
    queryKey: ['settings'],
    queryFn: ({ signal }) => api('settings', settingsSchema, { signal }),
  })

const useModelsQuery = (url: string | undefined) =>
  useQuery({
    queryKey: ['bot-models', url],
    enabled: url !== undefined,
    queryFn: ({ signal }) => api('music-bot/models', botModelsSchema, { signal }),
    retry: false,
    // A model server that comes up later is noticed without a reload.
    refetchInterval: (query) => (query.state.status === 'error' ? 30_000 : false),
  })

const trackLabel = (track: LibraryTrack) => `${track.title} · ${track.artist}`

/** The chat's answer with the stored revision's songs, length and sentence in place of its own. */
const shownReply = (answer: BotReply, made: ProposalReply): BotReply => ({
  ...answer,
  tracks: made.tracks,
  total_seconds: made.proposal.total_seconds,
  shortfall_seconds: made.proposal.shortfall_seconds,
  summary: made.proposal.summary,
})

const previewOf = (made: ProposalReply): Preview => ({
  id: made.proposal.id,
  revision: made.proposal.revision,
  intent: made.proposal.intent,
  overview: made.proposal.overview,
  sampleIds: made.proposal.sample.ids,
  complete: made.proposal.sample.complete,
  missing: made.missing_ids.length,
})

/** What a refinement says when its proposal is gone or already refined elsewhere. */
const REVISION_GONE = ['revision_superseded', 'proposal_not_found', 'revision_not_found']

export function MusicBotProvider({ children }: { children: ReactNode }) {
  const { name } = usePetSettings()
  const player = usePlayer()
  const latestPlayer = useRef(player)
  useEffect(() => {
    latestPlayer.current = player
  }, [player])
  const client = useQueryClient()
  const settings = useSettingsQuery()
  const models = useModelsQuery(settings.data?.ollama_url.value)
  const scanQuery = useQuery({
    queryKey: ['library'],
    queryFn: ({ signal }) => api('library', librarySchema, { signal }),
  })
  const scan = scanQuery.data

  const [history, setHistory] = useState<Message[]>(() =>
    readSession(HISTORY_KEY, historySchema, []),
  )
  const [saved] = useState(() => readSession(LOG_KEY, logSchema, { entries: [], cardId: null }))
  const [log, setLog] = useState<LogEntry[]>(saved.entries)
  const [cardId, setCardId] = useState<number | null>(saved.cardId)
  const [reply, setReply] = useState<BotReply | null>(() =>
    readSession(PROPOSAL_KEY, botReplySchema.nullable(), null),
  )
  const [preview, setPreview] = useState<Preview | null>(() =>
    readSession(PREVIEW_KEY, previewSchema.nullable(), null),
  )
  const [problem, setProblem] = useState<Problem | null>(null)
  const [savedAs, setSavedAs] = useState<string[]>([])
  const [shown, setShown] = useState<string[][]>(() => readSession(SHOWN_KEY, shownSchema, []))
  const [stamp, setStamp] = useState('')
  const [applied, setApplied] = useState<Applied | null>(null)
  const [reference, setReference] = useState<Reference | null>(null)
  const [scope, setScope] = useState<BotScope | null>(null)
  const [thinking, setThinking] = useState(false)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [cold, setCold] = useState(false)
  const [applying, setApplying] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [outcome, setOutcome] = useState<{ mood: ChatOutcome; at: number } | null>(null)
  const [unread, setUnread] = useState(false)
  const [open, setOpenState] = useState(false)
  const trackId = player.libraryTrack?.id ?? (player.track ? `preview-${player.track.id}` : null)
  const [trackChangedAt, setTrackChangedAt] = useState<number | null>(null)
  const [pausedAt, setPausedAt] = useState<number | null>(null)
  const previousTrack = useRef(trackId)
  const openRef = useRef(open)
  const request = useRef<AbortController | null>(null)
  const serial = useRef(0)
  /** The preview as the last answer left it, for work that began before the next render. */
  const latestPreview = useRef(preview)
  /** Held from the press of a confirmation to its answer, so a second press does nothing. */
  const committing = useRef(false)
  const attempt = useRef<Attempt | null>(null)
  /** Confirmations sent from this tab, as `proposal:revision:target`, so a second one says repeat. */
  const sent = useRef(new Set<string>())
  /** Raised by Clear, so a confirmation that finishes after it leaves the cleared chat alone. */
  const cleared = useRef(0)
  const repeatCommand = useRef<Command | null>(null)
  const nextId = useRef(saved.entries.reduce((top, entry) => Math.max(top, entry.id), 0) + 1)
  const lastAnswerAt = useRef(0)
  /** The last request sent, for Send again. A ref: an action can fail before the log re-renders. */
  const lastPrompt = useRef<string | undefined>(
    [...saved.entries].reverse().find((entry) => entry.kind === 'user')?.text,
  )
  const model = settings.data?.ollama_model.value ?? ''
  const connectionKey = settings.data ? `${settings.data.ollama_url.value}/${model}` : ''
  const previousConnection = useRef('')

  const push = useCallback((entry: NewEntry) => {
    const id = nextId.current++
    setLog((old) => [...old, { ...entry, id } as LogEntry].slice(-LOG_LIMIT))
    return id
  }, [])

  /** Shows a stored revision, or none. A different revision starts without saved playlists or a
   *  problem, which belonged to the one before. */
  const showPreview = useCallback((next: Preview | null) => {
    const old = latestPreview.current
    if (old?.id !== next?.id || old?.revision !== next?.revision) setSavedAs([])
    latestPreview.current = next
    setPreview(next)
    setProblem(null)
  }, [])

  const setOpen = useCallback((value: boolean) => {
    openRef.current = value
    setOpenState(value)
    if (value) setUnread(false)
  }, [])

  /** A reply is "unread" when it lands with every chat view closed. */
  const landed = useCallback((mood: ChatOutcome) => {
    setOutcome({ mood, at: Date.now() })
    if (!openRef.current) setUnread(true)
  }, [])

  useEffect(() => {
    if (previousConnection.current && previousConnection.current !== connectionKey) {
      serial.current += 1
      request.current?.abort()
      setThinking(false)
      setReply(null)
      showPreview(null)
      setCardId(null)
      push({ kind: 'note', text: 'Ollama settings changed. Send a new request.' })
    }
    previousConnection.current = connectionKey
  }, [connectionKey, push, showPreview])

  // Kept here once, not in each pet: a pet that mounts later (the chat's header, Now Playing)
  // must know the music paused three minutes ago, not when it appeared.
  useEffect(() => {
    if (previousTrack.current !== null && trackId !== null && previousTrack.current !== trackId)
      setTrackChangedAt(Date.now())
    previousTrack.current = trackId
  }, [trackId])

  useEffect(() => {
    setPausedAt(player.playing ? null : Date.now())
  }, [player.playing])

  useEffect(
    () => () => {
      serial.current += 1
      request.current?.abort()
    },
    [],
  )

  useEffect(() => {
    try {
      sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history))
      sessionStorage.setItem(PROPOSAL_KEY, JSON.stringify(reply))
      sessionStorage.setItem(LOG_KEY, JSON.stringify({ entries: log, cardId }))
      sessionStorage.setItem(SHOWN_KEY, JSON.stringify(shown))
      sessionStorage.setItem(PREVIEW_KEY, JSON.stringify(preview))
    } catch {
      /* Chat still works without storage. */
    }
  }, [history, reply, log, cardId, shown, preview])

  const chooseModel = useMutation({
    mutationFn: (choice: string) =>
      api('settings', settingsSchema, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ollama_model: choice }),
      }),
    onSuccess: (data) => {
      client.setQueryData(['settings'], data)
      setReply(null)
      showPreview(null)
      setCardId(null)
    },
  })

  const cancel = useCallback(() => {
    if (!request.current) return
    serial.current += 1
    request.current.abort()
    request.current = null
    setThinking(false)
    setApplying(false)
    setStartedAt(null)
    push({ kind: 'note', text: 'Cancelled. Nothing changed.' })
  }, [push])

  const fail = useCallback(
    (failure: BotFailure, prompt?: string) => {
      push({ kind: 'error', ...failure, prompt })
      landed('sorry')
    },
    [push, landed],
  )

  async function send(raw: string) {
    const text = raw.trim().slice(0, MAX_PROMPT)
    if (!text || locked) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    const id = ++serial.current
    const before = latestPlayer.current.botStamp()
    const live = latestPlayer.current
    // What the request is made against, kept to build the same intent from the answer.
    const context: IntentContext = {
      proposalIds: reply?.tracks.map((track) => track.id) ?? [],
      queueIds: live.queue.slice(live.currentIndex + 1).map((track) => track.id),
      shownIds: shownIds(shown),
    }
    push({ kind: 'user', text, about: reference?.label })
    lastPrompt.current = text
    setThinking(true)
    setStartedAt(Date.now())
    setCold(Date.now() - lastAnswerAt.current > WARM_MS)
    try {
      const answer = await api('music-bot/chat', botReplySchema, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: text,
          history,
          previous: reply?.plan ?? null,
          proposal_ids: context.proposalIds,
          queue_ids: context.queueIds,
          current_id: live.libraryTrack?.id ?? null,
          reference_id: reference?.id ?? null,
          shown_ids: context.shownIds,
          ...(scope ? { scope } : {}),
        }),
      })
      if (serial.current !== id) return
      lastAnswerAt.current = Date.now()
      const action = answer.plan.action
      let said = answer.summary || 'Done.'
      if (action === 'pause' || action === 'resume' || action === 'skip') {
        if (latestPlayer.current.botStamp() !== before) {
          fail(explainFailure('The player changed while waiting.', 'request'), text)
          return
        }

        if (!isDirectCommand(text, action)) {
          said = COMMAND_HELP
          push({ kind: 'reply', text: COMMAND_HELP, mood: 'confused', suggestions: [] })
          landed('confused')
        } else {
          const player = latestPlayer.current
          if (action === 'skip') player.next()
          else if ((action === 'pause') === player.playing) player.toggle()
          const upcoming = player.queue[player.currentIndex + 1]
          said = action === 'pause' ? 'Paused.' : action === 'resume' ? 'Playing.' : 'Skipped.'
          push({
            kind: 'command',
            icon: action === 'pause' ? 'pause' : action === 'resume' ? 'play' : 'skip',
            text:
              action === 'pause'
                ? 'Paused'
                : action === 'resume'
                  ? 'Playing'
                  : upcoming
                    ? `Skipped to ${trackLabel(upcoming)}`
                    : 'Skipped',
          })
          landed('happy')
        }
      } else if (action === 'search') {
        // The server keeps the result as a revision, and the card shows that revision.
        const made = await previewFor(answer, context, controller.signal)
        if (serial.current !== id) return
        const result = made ? shownReply(answer, made) : answer
        setReply(result)
        showPreview(made ? previewOf(made) : null)
        setShown((old) => rememberShown(old, answer))
        setStamp(before)
        setApplied(null)
        const entry = push({
          kind: 'reply',
          text: resultLine(result),
          mood: result.tracks.length ? 'talking' : 'sorry',
          suggestions: [],
          card: cardLine(result),
        })
        setCardId(entry)
        landed(result.tracks.length ? 'talking' : 'sorry')
      } else {
        const asking = action === 'clarify'
        push({
          kind: 'reply',
          text: answer.summary,
          mood: asking ? 'confused' : 'sorry',
          suggestions: answer.plan.suggestions,
          note: !asking && answer.plan.suggestions.length ? 'I can go by tags instead:' : undefined,
        })
        landed(asking ? 'confused' : 'sorry')
      }
      setHistory((old) =>
        [
          ...old,
          { role: 'user' as const, content: text },
          { role: 'assistant' as const, content: said.slice(0, MAX_PROMPT) },
        ].slice(-HISTORY_LIMIT),
      )
      // A picked scope is for the request it was picked for. The radio then shows what was used.
      setScope(null)
    } catch (problem) {
      if (serial.current !== id) return
      const message = problem instanceof Error ? problem.message : 'Request failed.'
      fail(explainFailure(message, 'request'), text)
      // A server that stopped answering shows as offline straight away rather than on the next poll.
      if (/reach Ollama|no longer installed|Choose an installed/i.test(message))
        void models.refetch()
    } finally {
      if (serial.current === id) {
        setThinking(false)
        setStartedAt(null)
        request.current = null
      }
    }
  }

  /** The preview for a search answer: the next revision of the open proposal, or a new proposal.
   *  Null for an empty answer, which has nothing to confirm. */
  async function previewFor(
    answer: BotReply,
    context: IntentContext,
    signal: AbortSignal,
  ): Promise<ProposalReply | null> {
    if (!answer.tracks.length) return null
    // "Add a song" has no intent of its own, so the list the chat built is kept as it stands.
    const keep = answer.plan.add_count > 0 ? answer.tracks.map((track) => track.id) : undefined
    const intent = intentFromReply(answer, context, keep)
    const open = latestPreview.current
    if (open && keep === undefined) {
      try {
        return await refineProposal(open.id, open.revision, intent, signal)
      } catch (problem) {
        // Refined in another tab, or pruned: a new proposal takes its place.
        if (!(problem instanceof ProposalError) || !REVISION_GONE.includes(problem.code))
          throw problem
      }
    }
    return createProposal(intent, signal)
  }

  /** Runs one server step that ends in a card, under the same cancel and supersede rules as a
   *  chat request. Null when it was cancelled or superseded, or failed (and said so). */
  async function working<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
    const id = ++serial.current
    const controller = new AbortController()
    request.current = controller
    setApplying(true)
    try {
      const done = await run(controller.signal)
      return id === serial.current ? done : null
    } catch (problem) {
      if (id === serial.current)
        fail(
          explainFailure(problem instanceof Error ? problem.message : 'Request failed.', 'request'),
          lastPrompt.current,
        )
      return null
    } finally {
      if (id === serial.current) {
        setApplying(false)
        request.current = null
      }
    }
  }

  /** Stores the card's exact list as a revision. A restored card, or one with a song taken out,
   *  has no server revision yet, and nothing is confirmed until it has. */
  async function keepList(songs: readonly LibraryTrack[]): Promise<boolean> {
    if (!reply) return false
    const kept = reply
    const made = await working((signal) =>
      createProposal(
        intentFromReply(
          kept,
          { proposalIds: [], queueIds: [], shownIds: [] },
          songs.map((song) => song.id),
        ),
        signal,
      ),
    )
    if (!made) return false
    setReply(shownReply(kept, made))
    showPreview(previewOf(made))
    return true
  }

  /** Play, queue and save all confirm the stored revision. With none yet, the first press makes
   *  the preview, and the person confirms what they can now see. */
  async function confirm(command: Command, repeat = false): Promise<boolean> {
    if (!reply || committing.current) return false
    const open = latestPreview.current
    if (!open) {
      if (await keepList(reply.tracks))
        push({ kind: 'note', text: 'I made a preview of this list first. Check it, then confirm.' })
      return false
    }
    return commit(command, open, reply.tracks, repeat)
  }

  /**
   * Sends one confirmation for the stored revision. The operation id is made once per press and
   * reused when no answer arrives, so the server returns its first receipt instead of doing it
   * twice. Nothing is queued before the server has recorded the commit, and the player is given
   * the receipt's ids, not the result of a new search.
   */
  async function commit(
    command: Command,
    at: Preview,
    tracks: readonly LibraryTrack[],
    repeat: boolean,
  ): Promise<boolean> {
    committing.current = true
    setConfirming(true)
    setProblem(null)
    const epoch = cleared.current
    const what = command.kind === 'playlist' ? 'save' : 'queue'
    const key = `${at.id}:${at.revision}:${command.kind}`
    try {
      if (command.kind === 'queue' && latestPlayer.current.botStamp() !== stamp)
        throw new Error(QUEUE_MOVED)
      const open = attempt.current
      const again =
        open?.preview.id === at.id &&
        open.preview.revision === at.revision &&
        open.command.kind === command.kind
      if (!again) attempt.current = { command, preview: at, operationId: newOperationId(), repeat }
      const sending = attempt.current
      if (!sending) return false
      const done = await confirmOnce(sending, repeat || sent.current.has(key))
      attempt.current = null
      sent.current.add(key)
      if (command.kind === 'playlist') {
        void client.invalidateQueries({ queryKey: ['library-playlists'] })
        const name = done.receipt.playlist_name ?? command.name
        if (epoch === cleared.current) setSavedAs((old) => [...old, name])
        push({ kind: 'note', text: `Saved as the playlist “${name}”.` })
        landed('happy')
        return true
      }
      const byId = new Map(tracks.map((track) => [track.id, track]))
      const exact: LibraryTrack[] = []
      for (const id of done.receipt.ids) {
        const song = byId.get(id)
        if (!song) throw new Error('A song in the approved list is no longer on the card.')
        exact.push(song)
      }
      latestPlayer.current.applyBotQueue(exact, command.action, stamp)
      setStamp(latestPlayer.current.botStamp())
      if (epoch === cleared.current)
        setApplied({ action: command.action, count: exact.length, undo: 'ready' })
      landed('happy')
      return true
    } catch (problem) {
      if (problem instanceof UnknownOutcome) {
        // Neither done nor not done. The same id is asked again; no new attempt is offered.
        setProblem({ kind: 'unknown', what })
        landed('sorry')
        return false
      }
      attempt.current = null
      if (problem instanceof ProposalError && problem.code === 'proposal_stale') {
        setProblem({ kind: 'stale', changes: staleLines(problem.fields, tracks) })
        landed('sorry')
        return false
      }

      if (problem instanceof ProposalError && problem.code === 'already_committed') {
        repeatCommand.current = command
        setProblem({ kind: 'repeat', what })
        return false
      }
      const message = problem instanceof Error ? problem.message : 'Could not apply selection.'
      if (command.kind === 'queue')
        push({ kind: 'note', text: `You pressed ${ACTION_NOTE[command.action]}` })
      fail(
        explainFailure(message, 'apply'),
        command.kind === 'queue' ? lastPrompt.current : undefined,
      )

      return false
    } finally {
      committing.current = false
      setConfirming(false)
    }
  }

  /** One confirmation, and if no answer came, the same one again once before giving up. */
  async function confirmOnce(sending: Attempt, repeat: boolean): Promise<CommitReply> {
    const ask = () =>
      commitProposal(
        sending.preview.id,
        {
          revision: sending.preview.revision,
          operationId: sending.operationId,
          target:
            sending.command.kind === 'playlist'
              ? { kind: 'playlist', name: sending.command.name.trim() }
              : { kind: 'queue' },
          repeat,
        },
        AbortSignal.timeout(COMMIT_TIMEOUT),
      )
    try {
      return await ask()
    } catch (problem) {
      if (!(problem instanceof UnknownOutcome)) throw problem
      await new Promise((resolve) => setTimeout(resolve, RECONCILE_DELAY))
      return ask()
    }
  }

  async function apply(action: BotQueueAction, singleId?: string) {
    if (!reply) return
    if (!singleId) {
      await confirm({ kind: 'queue', action })
      return
    }
    // One song, played at once from its menu. It is not a generated list, so there is no preview
    // to confirm; the server rechecks that one id the way it always has.
    const id = ++serial.current
    const controller = new AbortController()
    request.current = controller
    setApplying(true)
    try {
      const checked = await api('music-bot/validate', botSelectionSchema, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: [singleId],
          plan: reply.plan,
          reference_id: reply.reference_id,
          current_id: reply.current_id,
        }),
      })
      if (id !== serial.current) return
      latestPlayer.current.applyBotQueue(checked.tracks, action, stamp)
      setStamp(latestPlayer.current.botStamp())
      setApplied({ action, count: checked.tracks.length, undo: 'ready' })
      landed('happy')
    } catch (problem) {
      if (id !== serial.current) return
      const message = problem instanceof Error ? problem.message : 'Could not apply selection.'
      push({ kind: 'note', text: `You pressed ${ACTION_NOTE[action]} on one song` })
      fail(explainFailure(message, 'apply'), lastPrompt.current)
    } finally {
      if (id === serial.current) {
        setApplying(false)
        request.current = null
      }
    }
  }

  async function save(playlist: string): Promise<boolean> {
    if (!playlist.trim()) return false
    return confirm({ kind: 'playlist', name: playlist.trim() })
  }

  /** What the problem on the card offers: a refreshed preview, or the same confirmation again. */
  function resolveProblem() {
    if (!problem) return
    if (problem.kind === 'stale') void refresh()
    else if (problem.kind === 'unknown') {
      const open = attempt.current
      if (open) void confirm(open.command, open.repeat)
    } else if (repeatCommand.current) void confirm(repeatCommand.current, true)
  }

  /** The next revision of the same request, run now, for a preview that went stale. What it
   *  changed is said afterwards; nothing is confirmed by it. */
  async function refresh() {
    const at = latestPreview.current
    if (!reply || !at) return
    const kept = reply
    const made = await working((signal) =>
      refineProposal(at.id, at.revision, refreshIntent(at.intent), signal),
    )
    if (!made) return
    attempt.current = null
    setReply(shownReply(kept, made))
    showPreview(previewOf(made))
    setApplied(null)
    push({
      kind: 'note',
      text: refreshedNote(
        idChanges(
          kept.tracks.map((track) => track.id),
          made.tracks.map((track) => track.id),
        ),
      ),
    })
    landed('happy')
  }

  function undo() {
    try {
      latestPlayer.current.undoBotQueue()
      setStamp(latestPlayer.current.botStamp())
      setApplied((old) => (old ? { ...old, undo: 'done' } : old))
      push({ kind: 'note', text: 'Undone. Your queue is back how it was.' })
    } catch {
      // The player refuses once the queue moved on; its own message says the same thing.
      setApplied((old) => (old ? { ...old, undo: 'refused' } : old))
      landed('sorry')
    }
  }

  /** Takes a song off the card. The shorter list is stored as its own preview, so what is
   *  confirmed is what the card shows. */
  async function removeSong(id: string) {
    if (!reply || committing.current) return
    const rest = reply.tracks.filter((track) => track.id !== id)
    if (rest.length === reply.tracks.length) return
    if (reference?.id === id) setReference(null)
    if (!rest.length) {
      setReply({
        ...reply,
        tracks: [],
        total_seconds: 0,
        shortfall_seconds: reply.plan.target_seconds,
      })
      showPreview(null)
      return
    }
    await keepList(rest)
  }

  function clear() {
    serial.current += 1
    request.current?.abort()
    request.current = null
    setThinking(false)
    setApplying(false)
    setStartedAt(null)
    setHistory([])
    lastPrompt.current = undefined
    setLog([])
    setReply(null)
    cleared.current += 1
    attempt.current = null
    sent.current.clear()
    repeatCommand.current = null
    showPreview(null)
    setShown([])
    setCardId(null)
    setApplied(null)
    setReference(null)
    setScope(null)
    setUnread(false)
    setOutcome(null)
  }

  function retry(entry: Extract<LogEntry, { kind: 'error' }>) {
    if (entry.next === 'replace') void apply('replace')
    else if (entry.prompt) void send(entry.prompt)
  }

  const installed = models.data?.models
  const locked: BotChat['locked'] =
    scan?.status === 'scanning'
      ? 'busy'
      : models.isError || settings.isError
        ? 'offline'
        : settings.data && (!model || (installed !== undefined && !installed.includes(model)))
          ? 'nomodel'
          : null

  const latestReply = useMemo(() => {
    const last = [...log].reverse().find((entry) => entry.kind === 'reply')
    return last?.kind === 'reply' ? last.text : ''
  }, [log])

  const value: BotChat = {
    name,
    settings,
    models,
    model,
    chooseModel: (choice) => {
      cancel()
      chooseModel.mutate(choice)
    },
    choosingModel: chooseModel.isPending,
    locked,
    scan,
    log,
    cardId,
    reply,
    preview,
    problem,
    savedAs,
    resolveProblem,
    refreshPreview: () => void refresh(),
    dismissProblem: () => setProblem(null),
    applied,
    stale: Boolean(reply) && !stamp,
    reference,
    setReference,
    scope,
    setScope,
    shownScope: scope ?? reply?.plan.scope ?? 'library',
    thinking,
    startedAt,
    cold,
    applying,
    confirming,
    send,
    cancel,
    apply,
    save,
    undo,
    removeSong,
    clear,
    retry,
    outcome,
    unread,
    latestReply,
    open,
    setOpen,
    trackChangedAt,
    pausedAt,
  }

  return <BotChatContext.Provider value={value}>{children}</BotChatContext.Provider>
}

const ACTION_NOTE: Record<BotQueueAction, string> = {
  play: 'Play',
  next: 'Play next',
  append: 'Add to queue',
  replace: 'Replace upcoming',
}
