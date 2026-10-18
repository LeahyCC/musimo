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
  isLibraryResult,
  resultLine,
} from './bot-replies'
import type { BotFailure } from './bot-replies'
import type { ChatOutcome } from './pet-mood'
import { usePetSettings } from './pet-settings'
import { editNote, refreshedNote, staleGone, staleLines } from './preview-text'
import {
  commitProposal,
  createProposal,
  editProposal,
  forgetMemory,
  idChanges,
  intentFromReply,
  intentSchema,
  newOperationId,
  overviewSchema,
  presentResult,
  ProposalError,
  readMemory,
  readProposal,
  refineProposal,
  refreshIntent,
  sameSearch,
  unavailableSongs,
  UnknownOutcome,
} from './proposals'
import type {
  Carry,
  CommitReply,
  EditReply,
  IntentContext,
  ProposalEdit,
  ProposalReply,
  ShownMemory,
} from './proposals'

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
/** Where an older build kept the shown songs in this tab. The server holds them now; the leftover
 *  is removed so the two cannot disagree. */
const LEGACY_SHOWN_KEY = 'musimo.music-bot.shown'
const PREVIEW_KEY = 'musimo.music-bot.preview'
const MEMORY_KEY = ['bot-memory'] as const
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
  /** Which songs those are, so a refresh can leave them out of the request. */
  missingIds: z.array(z.string()).default([]),
})
export type Preview = z.infer<typeof previewSchema>

/** Why the last confirmation did not go through, and what the card offers next. */
export type Problem =
  /** `gone` are the songs it says left the library. */
  | { kind: 'stale'; changes: string[]; gone: string[] }
  | { kind: 'unknown'; what: 'save' | 'queue' | 'edit' }
  | { kind: 'repeat'; what: 'save' | 'queue' }
  /** The server recorded a queue confirmation, but the card cannot apply it as recorded. */
  | { kind: 'recorded' }
  /** The open revision was refined elsewhere or is gone, so an edit of it was not made. */
  | { kind: 'changed' }
  /** Kept songs whose files cannot be played now. They stay in the preview, never dropped quietly,
   *  and each can be taken out. */
  | { kind: 'unavailable'; songs: string[] }

type Command = { kind: 'playlist'; name: string } | { kind: 'queue'; action: BotQueueAction }
/** A confirmation sent but not yet answered. Its operation id is sent again, never replaced. */
type Attempt = { command: Command; preview: Preview; operationId: string; repeat: boolean }
/** An edit sent but not yet answered, kept the same way. */
type EditAttempt = { edit: ProposalEdit; preview: Preview; operationId: string }

/** How long to wait before asking again with the same operation id after a dropped answer. */
export const RECONCILE_DELAY = 800
const COMMIT_TIMEOUT = 20_000
const EDIT_TIMEOUT = 20_000
const QUEUE_MOVED = 'The queue changed. Ask again before applying.'
/** Said whenever something fails after the server accepted a confirmation. */
const RECORDED = 'The server recorded this confirmation, but your queue was not changed.'

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
  /** An edit's answer never came, so nothing else can start until it is asked again or ended. */
  holding: boolean
  /** The songs pinned on the card. Seeded from the revision, and sent with Another set. */
  pins: readonly string[]
  togglePin: (id: string) => void
  /** Another set: the pinned songs stay and the rest are drawn again, as the next revision. */
  anotherSet: () => Promise<void>
  /** One more song that fits the same filters, as the next revision. */
  addSong: () => Promise<void>
  /** Clears the conversation in this browser. The server's memory of shown songs is kept. */
  clear: () => void
  /** What the server remembers of the results already shown, for every device. */
  memory: ShownMemory | undefined
  /** Forgets those songs on every device. Play history, likes and playlists stay. */
  forget: () => void
  forgetting: boolean
  forgetFailed: boolean
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
  missingIds: made.missing_ids,
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
  // An edit whose answer never came: the same request is asked again from the card before anything
  // else starts, so no other request can be made meanwhile.
  const holding = problem?.kind === 'unknown' && problem.what === 'edit'
  // The songs pinned on the card. They are the person's until Another set sends them, so they live
  // here and start from what the open revision holds.
  const [pins, setPins] = useState<string[]>(() => preview?.intent.context.pinned_ids.slice() ?? [])
  const [savedAs, setSavedAs] = useState<string[]>([])
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
  const editAttempt = useRef<EditAttempt | null>(null)
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
   *  problem, which belonged to the one before. The pins are the revision's own unless the caller
   *  says which stay: an edit that cannot carry a pin the server has not seen yet keeps it here. */
  const showPreview = useCallback((next: Preview | null, pinned?: readonly string[]) => {
    const old = latestPreview.current
    if (old?.id !== next?.id || old?.revision !== next?.revision) setSavedAs([])
    latestPreview.current = next
    setPreview(next)
    setPins([...(pinned ?? next?.intent.context.pinned_ids ?? [])])
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
      sessionStorage.setItem(PREVIEW_KEY, JSON.stringify(preview))
      sessionStorage.removeItem(LEGACY_SHOWN_KEY)
    } catch {
      /* Chat still works without storage. */
    }
  }, [history, reply, log, cardId, preview])

  const memory = useQuery({
    queryKey: MEMORY_KEY,
    queryFn: ({ signal }) => readMemory(signal),
    // Another device may present or forget; a refetch on focus is enough to notice.
    retry: false,
  })
  const forgetting = useMutation({
    mutationFn: forgetMemory,
    onSuccess: (data) => client.setQueryData(MEMORY_KEY, data),
  })

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
    // A cancelled edit is not asked again: the person's next press is a new one.
    editAttempt.current = null
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
    if (!text || locked || holding) return
    request.current?.abort()
    // A request of its own ends any edit still waiting to be asked again.
    editAttempt.current = null
    const controller = new AbortController()
    request.current = controller
    const id = ++serial.current
    const before = latestPlayer.current.botStamp()
    const live = latestPlayer.current
    // What the request is made against, kept to build the same intent from the answer.
    const context: IntentContext = {
      proposalIds: reply?.tracks.map((track) => track.id) ?? [],
      queueIds: live.queue.slice(live.currentIndex + 1).map((track) => track.id),
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
        const stored = await previewFor(answer, context, controller.signal)
        if (serial.current !== id) return
        if (stored === 'changed') {
          // The open revision was refined elsewhere or is gone. Nothing was added, and the card is
          // left as it is until the person asks to see the current one.
          setProblem({ kind: 'changed' })
          push({
            kind: 'note',
            text: 'That preview changed, so I did not make that change. Refresh it, then ask again.',
          })
          landed('sorry')
          return
        }
        const made = stored?.made ?? null
        const result = made ? shownReply(answer, made) : answer
        setReply(result)
        showPreview(made ? previewOf(made) : null, stored?.pinned)
        if (made && isLibraryResult(answer)) presented(made)
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
      if (problem instanceof UnknownOutcome) {
        // An add whose answer never came. Whether it landed is not known, so the same operation id
        // is asked again from the card rather than a new edit being made.
        setProblem({ kind: 'unknown', what: 'edit' })
        landed('sorry')
        return
      }
      const unplayable = unavailableSongs(problem)
      if (unplayable) {
        // A kept or pinned song that cannot play blocks the request, and is named on the card.
        setProblem({ kind: 'unavailable', songs: unplayable })
        landed('sorry')
        return
      }
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

  /** Tells the server this library result is on screen, so asking again finds other songs. Called
   *  only once the card is shown: a request that was cancelled or superseded never gets here. The
   *  server records a revision once, so a repeat is harmless, and a failure only means these songs
   *  are not remembered. */
  function presented(made: ProposalReply) {
    presentResult(
      made.proposal.id,
      made.proposal.revision,
      made.proposal.snapshot.shown?.memory_revision ?? null,
    )
      .then((data) => client.setQueryData(MEMORY_KEY, data))
      .catch(() => void client.invalidateQueries({ queryKey: MEMORY_KEY }))
  }

  /** What an open proposal carries into a follow-up: the songs removed from it, and the ones pinned
   *  on the card. */
  function carryOf(open: Preview | null): Carry | undefined {
    return open ? { excludeIds: open.intent.filters.exclude_ids, pinnedIds: pins } : undefined
  }

  /**
   * The preview for a search answer: an edit of the open proposal, its next revision, or a new
   * proposal. Null for an empty answer, which has nothing to confirm, and 'changed' when the open
   * proposal was refined elsewhere or is gone, so the add was not made.
   */
  async function previewFor(
    answer: BotReply,
    context: IntentContext,
    signal: AbortSignal,
  ): Promise<{ made: ProposalReply; pinned?: string[] } | 'changed' | null> {
    if (!answer.tracks.length) return null
    const open = latestPreview.current
    const adding = answer.plan.add_count > 0
    if (open && adding && sameSearch(answer, open.intent)) {
      // The same search with more songs is the server's `add` edit: it keeps every song, picks the
      // new ones against its memory of what was shown, and the card shows its revision, not the
      // chat's own list.
      try {
        const made = await runEdit(
          open,
          { kind: 'add', count: answer.plan.add_count },
          newOperationId(),
          signal,
        )
        // A pin the server has not seen yet stays pinned on the card.
        const ids = new Set(made.proposal.ids)
        return { made, pinned: pins.filter((pin) => ids.has(pin)) }
      } catch (problem) {
        if (problem instanceof ProposalError && REVISION_GONE.includes(problem.code))
          return 'changed'
        throw problem
      }
    }
    // An add whose filters changed, or with nothing open to add to, has no edit that says so: the
    // edit route carries the open revision's filters over untouched, so it cannot change them. The
    // chat's own list (the old songs and the new ones) is stored as it stands instead. It was
    // built without knowing which songs were removed, so those are taken out of it here.
    const carry = carryOf(open)
    const removed = new Set(carry?.excludeIds)
    const keep = adding
      ? answer.tracks.map((track) => track.id).filter((song) => !removed.has(song))
      : undefined
    if (keep?.length === 0) return null
    const intent = intentFromReply(answer, context, keep, carry)
    if (open && keep === undefined) {
      try {
        return { made: await refineProposal(open.id, open.revision, intent, signal) }
      } catch (problem) {
        // Refined in another tab, or pruned. A new proposal is not made in its place unasked: the
        // card says the preview changed and offers Refresh preview.
        if (problem instanceof ProposalError && REVISION_GONE.includes(problem.code))
          return 'changed'
        throw problem
      }
    }
    return { made: await createProposal(intent, signal) }
  }

  /**
   * One edit of the open revision, and if no answer came, the same one again once before giving up.
   * The operation id belongs to the press that made it and is given here: it is kept until the
   * answer is definite, so the server returns its first revision instead of adding or removing
   * twice, and Check again after an unknown outcome sends that same id. A later press makes its own,
   * even for the same edit of the same revision. Nothing here decides which songs change.
   */
  async function runEdit(
    at: Preview,
    change: ProposalEdit,
    operationId: string,
    signal: AbortSignal,
  ): Promise<EditReply> {
    const sending: EditAttempt = { edit: change, preview: at, operationId }
    editAttempt.current = sending
    const ask = () =>
      editProposal(
        at.id,
        at.revision,
        sending.operationId,
        change,
        AbortSignal.any([signal, AbortSignal.timeout(EDIT_TIMEOUT)]),
      )
    try {
      let done: EditReply
      try {
        done = await ask()
      } catch (problem) {
        if (!(problem instanceof UnknownOutcome) || signal.aborted) throw problem
        await new Promise((resolve) => setTimeout(resolve, RECONCILE_DELAY))
        done = await ask()
      }
      editAttempt.current = null
      return done
    } catch (problem) {
      // Only a definite refusal ends the attempt. Without an answer it is asked again, same id.
      if (!(problem instanceof UnknownOutcome)) editAttempt.current = null
      throw problem
    }
  }

  /** Starts a request that supersedes any other. The one before is aborted and its waiting state
   *  cleared here, since its own cleanup is skipped once it is superseded. */
  function begin() {
    request.current?.abort()
    // Nothing else starts while an edit waits to be asked again; one that does ends that edit.
    editAttempt.current = null
    setThinking(false)
    setStartedAt(null)
    const id = ++serial.current
    const controller = new AbortController()
    request.current = controller
    return { id, controller }
  }

  /** Runs one server step that ends in a card, under the same cancel and supersede rules as a
   *  chat request. Null when it was cancelled or superseded, or failed (and said so). A failure
   *  offers Send again with the last request, unless the step is not that request's to repeat. */
  async function working<T>(
    run: (signal: AbortSignal) => Promise<T>,
    again: { prompt: string | undefined; during: 'request' | 'apply' } = {
      prompt: lastPrompt.current,
      during: 'request',
    },
  ): Promise<T | null> {
    const { id, controller } = begin()
    setApplying(true)
    try {
      const done = await run(controller.signal)
      return id === serial.current ? done : null
    } catch (problem) {
      if (id === serial.current)
        fail(
          explainFailure(
            problem instanceof Error ? problem.message : 'Request failed.',
            again.during,
          ),
          again.prompt,
        )
      return null
    } finally {
      if (id === serial.current) {
        setApplying(false)
        request.current = null
      }
    }
  }

  /** A kept song has left the library since the card read its revision, so the server refused the
   *  request (`unknown_song`). Reading the revision again lists which songs, and the card then
   *  shows what it shows for any song the library lost, with Refresh preview. False when the read
   *  finds none, or finds another revision. */
  async function learnMissing(at: Preview, signal: AbortSignal): Promise<boolean> {
    try {
      const read = await readProposal(at.id, signal)
      if (signal.aborted || read.proposal.revision !== at.revision || !read.missing_ids.length)
        return false
      const kept = reply
      if (kept) setReply(shownReply(kept, read))
      const here = new Set(read.proposal.ids)
      showPreview(
        previewOf(read),
        pins.filter((pin) => here.has(pin)),
      )

      push({
        kind: 'note',
        text: 'Some songs in this preview left your library. Refresh the preview to leave them out.',
      })
      landed('sorry')
      return true
    } catch {
      return false
    }
  }

  /** A call on the open revision. When that revision is gone or no longer the latest, the call
   *  was not made: the card says the preview changed and offers Refresh preview, and no new
   *  proposal is made in its place. With no answer at all the outcome is unknown, and the same
   *  operation id is asked again from the card. */
  function onOpenRevision<T>(run: (signal: AbortSignal) => Promise<T>) {
    return async (signal: AbortSignal): Promise<T | null> => {
      try {
        return await run(signal)
      } catch (problem) {
        if (signal.aborted) return null
        if (problem instanceof ProposalError && REVISION_GONE.includes(problem.code)) {
          setProblem({ kind: 'changed' })
          landed('sorry')
          return null
        }

        if (problem instanceof UnknownOutcome) {
          setProblem({ kind: 'unknown', what: 'edit' })
          landed('sorry')
          return null
        }
        const unplayable = unavailableSongs(problem)
        if (unplayable) {
          setProblem({ kind: 'unavailable', songs: unplayable })
          landed('sorry')
          return null
        }

        if (problem instanceof ProposalError && problem.code === 'unknown_song') {
          // A kept song left the library after this revision was read. Reading it again names
          // which, and the card then offers Refresh preview.
          const at = latestPreview.current
          if (at && (await learnMissing(at, signal))) return null
        }
        throw problem
      }
    }
  }

  /**
   * Another set, one more song, or a song fewer, as the next revision of the open proposal. The
   * server picks and keeps the songs; the card then shows its revision. Under the same cancel and
   * supersede rules as any request. Each press makes its own operation id; only Check again, which
   * passes the attempt that got no answer, sends an id again.
   */
  async function editPreview(change: ProposalEdit, again?: EditAttempt): Promise<boolean> {
    const at = latestPreview.current
    if (!reply || !at || committing.current) return false
    const kept = reply
    const operationId = again?.operationId ?? newOperationId()
    const made = await working(
      onOpenRevision((signal) => runEdit(at, change, operationId, signal)),
      {
        prompt: undefined,
        during: 'apply',
      },
    )
    if (!made) return false
    attempt.current = null
    const before = kept.tracks.map((track) => track.id)
    setReply(shownReply(kept, made))
    // Another set sent the pins, so the server's are the card's. An add or a remove cannot carry a
    // pin the server has not seen yet, so the card keeps its own that are still in the list: a pin
    // on a song that was removed goes with it.
    const here = new Set(made.proposal.ids)
    showPreview(
      previewOf(made),
      change.kind === 'another' ? undefined : pins.filter((pin) => here.has(pin)),
    )
    setApplied(null)
    push({
      kind: 'note',
      text: editNote(
        change.kind,
        idChanges(before, made.proposal.ids),
        change.kind === 'another' ? change.pinnedIds?.length : 0,
      ),
    })
    // A remove draws nothing, so nothing new was shown. The server counts it the same way.
    if (change.kind !== 'remove' && made.proposal.intent.scope === 'library') presented(made)
    landed('happy')
    return true
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
          { proposalIds: [], queueIds: [] },
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
    // True once the server has the confirmation, so nothing after it may say "nothing happened".
    let recorded = false
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
      recorded = true
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
        if (song) exact.push(song)
      }

      if (exact.length !== done.receipt.ids.length) {
        // The receipt names a song the card does not hold. The queue is left alone rather than
        // given a different list, and the card says the confirmation is on record.
        setProblem({ kind: 'recorded' })
        landed('sorry')
        return false
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
        setProblem({
          kind: 'stale',
          changes: staleLines(problem.fields, tracks),
          gone: staleGone(problem.fields),
        })
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
      const failure = explainFailure(message, 'apply')
      fail(
        recorded ? { ...failure, text: `${RECORDED} ${failure.text}` } : failure,
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
    const { id, controller } = begin()
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

  /** What the problem on the card offers: a refreshed preview, or the same request again. */
  function resolveProblem() {
    if (!problem) return
    if (problem.kind === 'stale' || problem.kind === 'recorded') void refresh()
    else if (problem.kind === 'changed') void reload()
    else if (problem.kind === 'unknown' && problem.what === 'edit') {
      // The same edit with the same operation id: the server returns the revision the first
      // attempt made if it landed, and makes it now if it did not.
      const open = editAttempt.current
      if (open) void editPreview(open.edit, open)
    } else if (problem.kind === 'unknown') {
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
    // A kept song that left the library would refuse the whole request, so it is left out of it:
    // the ones the card knows are gone, and the ones a stale commit just named.
    const gone = [...at.missingIds, ...(problem?.kind === 'stale' ? problem.gone : [])]
    const left = new Set(gone)
    const dropped = at.intent.context.keep_ids.filter((song) => left.has(song)).length
    const made = await working(
      onOpenRevision((signal) =>
        refineProposal(at.id, at.revision, refreshIntent(at.intent, gone), signal),
      ),
    )
    if (!made) return
    attempt.current = null
    setReply(shownReply(kept, made))
    // The card's own pins that are still in the list stay pinned.
    const here = new Set(made.proposal.ids)
    showPreview(
      previewOf(made),
      pins.filter((pin) => here.has(pin)),
    )
    setApplied(null)
    push({
      kind: 'note',
      text: refreshedNote(
        idChanges(
          kept.tracks.map((track) => track.id),
          made.tracks.map((track) => track.id),
        ),
        dropped,
      ),
    })
    landed('happy')
  }

  /** Shows the revision the server holds now, for a preview that changed under the card (refined
   *  from another tab or device). Only the person pressing Refresh preview gets here, so a proposal
   *  that is gone altogether is stored again from the card, and the note says so. */
  async function reload() {
    const at = latestPreview.current
    if (!reply || !at) return
    const kept = reply
    const gone = { value: false }
    const made = await working(
      async (signal) => {
        try {
          return await readProposal(at.id, signal)
        } catch (problem) {
          if (!(problem instanceof ProposalError) || !REVISION_GONE.includes(problem.code))
            throw problem
        }
        gone.value = true
        const nothing: IntentContext = { proposalIds: [], queueIds: [] }
        // A library search is made again from its own request. A list with no search behind it
        // (a refinement) can only be stored as the songs the card holds.
        return createProposal(
          at.intent.scope === 'proposal'
            ? intentFromReply(
                kept,
                nothing,
                kept.tracks.map((track) => track.id),
                carryOf(at),
              )
            : refreshIntent(at.intent, at.missingIds),
          signal,
        )
      },
      { prompt: undefined, during: 'apply' },
    )
    if (!made) return
    attempt.current = null
    editAttempt.current = null
    setReply(shownReply(kept, made))
    showPreview(previewOf(made))
    setApplied(null)
    push({
      kind: 'note',
      text: gone.value
        ? 'That preview was gone, so I stored this list again.'
        : refreshedNote(
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

  /** Takes a song off the card as the next revision of the open proposal, which also keeps it from
   *  being drawn again there. What is confirmed is what the card shows. */
  async function removeSong(id: string) {
    // A kept song that cannot be played is the one thing taken out while its problem is showing:
    // the server named it and will not drop it, so the person does.
    const named = problem?.kind === 'unavailable' && problem.songs.includes(id)
    if (!reply || committing.current || thinking || applying || (problem && !named)) return
    const rest = reply.tracks.filter((track) => track.id !== id)
    if (rest.length === reply.tracks.length) return
    if (reference?.id === id) setReference(null)
    if (!rest.length) {
      // The server refuses to leave a proposal empty, and an empty card has nothing to confirm.
      setReply({
        ...reply,
        tracks: [],
        total_seconds: 0,
        shortfall_seconds: reply.plan.target_seconds,
      })
      showPreview(null)
      editAttempt.current = null
      return
    }

    // A restored card has no stored revision to edit, so its shorter list is stored as the first.
    if (!latestPreview.current) {
      if (await keepList(rest))
        push({ kind: 'note', text: 'I stored the shorter list as a new preview.' })
      return
    }
    await editPreview({ kind: 'remove', ids: [id] })
  }

  /** Pins or unpins a song on the card. Nothing is sent until Another set. */
  function togglePin(id: string) {
    if (committing.current || thinking || applying || problem) return
    setPins((old) => (old.includes(id) ? old.filter((pin) => pin !== id) : [...old, id]))
  }

  /** The two library-only edits are not offered on a refinement, which the server refuses. */
  const libraryPreview = () => latestPreview.current?.intent.scope === 'library'

  async function anotherSet() {
    if (!libraryPreview() || committing.current || thinking || applying || problem) return
    await editPreview({ kind: 'another', pinnedIds: pins })
  }

  async function addSong() {
    if (!libraryPreview() || committing.current || thinking || applying || problem) return
    await editPreview({ kind: 'add', count: 1 })
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
    editAttempt.current = null
    sent.current.clear()
    repeatCommand.current = null
    showPreview(null)
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
    holding,
    pins,
    togglePin,
    anotherSet,
    addSong,
    clear,
    memory: memory.data,
    forget: () => forgetting.mutate(),
    forgetting: forgetting.isPending,
    forgetFailed: forgetting.isError,
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
