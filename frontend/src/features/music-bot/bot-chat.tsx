import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'

import {
  api,
  botModelsSchema,
  botReplySchema,
  botSelectionSchema,
  libraryPlaylistDetailSchema,
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
  resultLine,
  withoutSong,
} from './bot-replies'
import type { BotFailure } from './bot-replies'
import type { ChatOutcome } from './pet-mood'
import { usePetSettings } from './pet-settings'

/* The music bot's conversation, shared by every place it opens: the pet's popover, the phone
   sheet and the /music-bot page. One provider means a chat started on the pet carries on in the
   page and back, and a reply that lands while the chat is closed can wake the pet.

   The model only reads the request. The server picks the songs, every action rechecks them, and
   the player refuses a queue that changed underneath, so nothing here decides what plays. */

const HISTORY_KEY = 'musimo.music-bot.history'
const PROPOSAL_KEY = 'musimo.music-bot.proposal'
const LOG_KEY = 'musimo.music-bot.log'
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
  send: (text: string) => Promise<void>
  cancel: () => void
  apply: (action: BotQueueAction, singleId?: string) => Promise<void>
  save: (name: string) => Promise<boolean>
  undo: () => void
  removeSong: (id: string) => void
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
  const [stamp, setStamp] = useState('')
  const [applied, setApplied] = useState<Applied | null>(null)
  const [reference, setReference] = useState<Reference | null>(null)
  const [scope, setScope] = useState<BotScope | null>(null)
  const [thinking, setThinking] = useState(false)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [cold, setCold] = useState(false)
  const [applying, setApplying] = useState(false)
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
      setCardId(null)
      push({ kind: 'note', text: 'Ollama settings changed. Send a new request.' })
    }
    previousConnection.current = connectionKey
  }, [connectionKey, push])

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
    } catch {
      /* Chat still works without storage. */
    }
  }, [history, reply, log, cardId])

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
          proposal_ids: reply?.tracks.map((track) => track.id) ?? [],
          queue_ids: live.queue.slice(live.currentIndex + 1).map((track) => track.id),
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
        setReply(answer)
        setStamp(before)
        setApplied(null)
        const entry = push({
          kind: 'reply',
          text: resultLine(answer),
          mood: answer.tracks.length ? 'talking' : 'sorry',
          suggestions: [],
          card: cardLine(answer),
        })
        setCardId(entry)
        landed(answer.tracks.length ? 'talking' : 'sorry')
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

  async function apply(action: BotQueueAction, singleId?: string) {
    if (!reply) return
    const id = ++serial.current
    const controller = new AbortController()
    request.current = controller
    const ids = singleId ? [singleId] : reply.tracks.map((track) => track.id)
    setApplying(true)
    try {
      const checked = await api('music-bot/validate', botSelectionSchema, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, plan: reply.plan }),
      })
      if (id !== serial.current) return
      latestPlayer.current.applyBotQueue(checked.tracks, action, stamp)
      setStamp(latestPlayer.current.botStamp())
      setApplied({ action, count: checked.tracks.length, undo: 'ready' })
      landed('happy')
    } catch (problem) {
      if (id !== serial.current) return
      const message = problem instanceof Error ? problem.message : 'Could not apply selection.'
      push({
        kind: 'note',
        text: `You pressed ${ACTION_NOTE[action]}${singleId ? ' on one song' : ''}`,
      })
      fail(explainFailure(message, 'apply'), lastPrompt.current)
    } finally {
      if (id === serial.current) {
        setApplying(false)
        request.current = null
      }
    }
  }

  async function save(playlist: string): Promise<boolean> {
    if (!reply || !playlist.trim()) return false
    const id = ++serial.current
    const controller = new AbortController()
    request.current = controller
    setApplying(true)
    try {
      const checked = await api('music-bot/validate', botSelectionSchema, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: reply.tracks.map((track) => track.id), plan: reply.plan }),
      })
      await api('library/playlists', libraryPlaylistDetailSchema, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: playlist.trim(),
          song_ids: checked.tracks.map((track) => track.id),
        }),
      })
      void client.invalidateQueries({ queryKey: ['library-playlists'] })
      push({ kind: 'note', text: `Saved as the playlist “${playlist.trim()}”.` })
      landed('happy')
      return true
    } catch (problem) {
      if (id === serial.current)
        fail(
          explainFailure(problem instanceof Error ? problem.message : 'Could not save.', 'apply'),
        )
      return false
    } finally {
      if (id === serial.current) {
        setApplying(false)
        request.current = null
      }
    }
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

  function removeSong(id: string) {
    setReply((old) => (old ? withoutSong(old, id) : old))
    if (reference?.id === id) setReference(null)
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
