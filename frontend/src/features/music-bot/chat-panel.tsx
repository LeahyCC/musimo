import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'

import { useNavigate, useRouter } from '@tanstack/react-router'
import { ChevronLeft, ListMusic, Pause, Play, Settings, SkipForward, Trash2, X } from 'lucide-react'

import type { BotScope } from '../../api'
import { cx } from '../../lib/cx'
import { Button, FieldSelect } from '../../ui'
import { usePlayer } from '../player/player'
import { useBotChat } from './bot-chat'
import type { LogEntry } from './bot-chat'
import { headerButton, softButton } from './chat-buttons'
import { Composer } from './chat-composer'
import { Centered, Locked } from './chat-locked'
import { ChatSettings } from './chat-settings'
import { Pet } from './pet'
import type { PetState } from './pet-mood'
import { ResultCard } from './result-card'
import { usePetLook, usePetState } from './use-pet'

export type ChatLayout = 'popover' | 'sheet' | 'page'

const SCOPES: readonly { id: BotScope; label: string }[] = [
  { id: 'library', label: 'Whole library' },
  { id: 'proposal', label: 'This selection' },
  { id: 'queue', label: 'Up next' },
]

const STARTERS = [
  'An hour of my favourite 90s music',
  'Play some hip hop',
  'Something like this song',
  'Songs I haven’t played yet',
] as const

type ChatPanelProps = {
  layout: ChatLayout
  /** Closes the popover or sheet. The page has none. */
  onClose?: () => void
  /** Where focus starts when the panel opens. */
  autoFocus?: boolean
  /** Opens the chat's own settings view straight away. */
  startInSettings?: boolean
}

/**
 * The music bot's chat, in the shape its host gives it: a popover on the footer, a sheet on a
 * phone, or the /music-bot page. Everything it does goes through `useBotChat`, so the three are
 * one conversation.
 */
export function ChatPanel({
  layout,
  onClose,
  autoFocus = false,
  startInSettings = false,
}: ChatPanelProps) {
  const chat = useBotChat()
  const look = usePetLook()
  const petState = usePetState()
  const [view, setView] = useState<'chat' | 'settings'>(startInSettings ? 'settings' : 'chat')
  const settings = view === 'settings'
  const win95 = look.pixel
  const name = chat.name
  const status = statusLine(chat, settings)
  const router = useRouter()
  const navigate = useNavigate()
  // Back to the page before, when Musimo has one. Opened from a bookmark or after a reload there
  // is none, and the browser's Back would leave the app, so it goes to Search instead.
  const back = () => {
    if (router.history.canGoBack()) router.history.back()
    else void navigate({ to: '/search' })
  }

  return (
    <div
      data-bot="panel"
      data-layout={layout}
      className="flex size-full min-h-0 flex-col bg-raised text-small text-text"
    >
      <div
        data-bot="title-bar"
        className="flex shrink-0 items-center gap-[10px] border-b border-line py-[10px] pr-[8px] pl-[12px]"
      >
        {(layout === 'page' || settings) && (
          <button
            type="button"
            className={cx(headerButton, '-ml-[6px] min-h-11 min-w-11')}
            aria-label={settings ? 'Back to chat' : 'Back'}
            onClick={() => (settings ? setView('chat') : back())}
          >
            <ChevronLeft size={20} aria-hidden="true" />
          </button>
        )}
        <span className="grid size-[36px] shrink-0 place-items-end-center" data-bot="title-pet">
          <Pet
            kind={look.settings.kind}
            state={petState}
            size={win95 ? 16 : 32}
            motion={look.motion}
            pixel={look.pixel}
            paint={look.paint}
          />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-body leading-[1.25] font-[550]" data-bot="title">
            {settings ? 'Chat settings' : win95 ? `${name} - Music bot` : name}
          </h2>
          <p
            role="status"
            data-bot="status"
            className="m-0 mt-[2px] flex items-center gap-[6px] truncate text-tiny text-muted"
          >
            <i
              className={cx('size-[6px] shrink-0 rounded-full', DOT[status.tone])}
              aria-hidden="true"
            />
            {status.text}
          </p>
        </div>
        {!settings && (
          <>
            <button
              type="button"
              className={headerButton}
              aria-label="Chat settings"
              onClick={() => setView('settings')}
            >
              <Settings size={17} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={headerButton}
              aria-label="Clear chat"
              disabled={!chat.log.length && !chat.reply}
              onClick={chat.clear}
            >
              <Trash2 size={16} aria-hidden="true" />
            </button>
          </>
        )}
        {layout !== 'page' && onClose && (
          <button
            type="button"
            className={headerButton}
            aria-label="Close chat"
            aria-keyshortcuts="Escape"
            onClick={onClose}
          >
            <X size={17} aria-hidden="true" />
          </button>
        )}
      </div>

      {!settings && !chat.locked && <ScopeBar />}

      {settings ? (
        <ChatSettings petState={petState} />
      ) : (
        <>
          <Conversation petState={petState} autoFocus={autoFocus} />
          <Composer autoFocus={autoFocus} />
        </>
      )}
      {win95 && (
        <div
          data-bot="status-bar"
          className="grid shrink-0 grid-cols-[1fr_auto_auto] gap-[2px] pt-[2px]"
        >
          <span>{chat.thinking ? 'Thinking...' : chat.locked ? status.text : 'Ready'}</span>
          <span className="whitespace-nowrap">{chat.model || 'No model'}</span>
          <span className="whitespace-nowrap">Up to 2,000 characters</span>
        </div>
      )}
    </div>
  )
}

const DOT = { accent: 'bg-accent', warn: 'bg-warn', danger: 'bg-danger' } as const

function statusLine(
  chat: ReturnType<typeof useBotChat>,
  settings: boolean,
): { text: string; tone: keyof typeof DOT } {
  const model = chat.model
  if (chat.locked === 'busy') return { text: 'Library scan in progress', tone: 'warn' }
  if (chat.locked === 'offline') return { text: 'Can’t reach the model server', tone: 'danger' }
  if (settings && chat.models.data?.models.length === 0)
    return { text: 'No installed models', tone: 'danger' }
  if (chat.locked === 'nomodel') return { text: 'No model chosen', tone: 'danger' }
  if (chat.thinking) return { text: chat.cold ? 'Waking up the model…' : 'Thinking…', tone: 'warn' }
  if (chat.applying) return { text: 'Checking the selection…', tone: 'warn' }
  return { text: `${settings ? 'Connected' : 'Ready'} · ${model}`, tone: 'accent' }
}

/** Where the next request looks. A pick wins over the model's reading, for that one request. */
function ScopeBar() {
  const chat = useBotChat()
  const player = usePlayer()
  const win95 = usePetLook().pixel
  const group = useRef<HTMLDivElement>(null)
  const available = (id: BotScope) =>
    id === 'library' ||
    (id === 'proposal' && Boolean(chat.reply?.tracks.length)) ||
    (id === 'queue' && player.queue.length > player.currentIndex + 1)
  const busy = chat.thinking || chat.applying

  if (win95)
    return (
      <div className="flex shrink-0 items-center gap-[6px] px-[4px] py-[6px]" data-bot="scope">
        <label htmlFor="bot-scope" className="whitespace-nowrap">
          Look in:
        </label>
        <FieldSelect
          id="bot-scope"
          fullWidth={false}
          value={chat.shownScope}
          disabled={busy}
          onChange={(event) => chat.setScope(event.target.value as BotScope)}
        >
          {SCOPES.map((scope) => (
            <option key={scope.id} value={scope.id} disabled={!available(scope.id)}>
              {scope.label}
            </option>
          ))}
        </FieldSelect>
      </div>
    )

  function keys(event: KeyboardEvent<HTMLDivElement>) {
    const order = SCOPES.filter((scope) => available(scope.id))
    const at = order.findIndex((scope) => scope.id === chat.shownScope)
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0
    if (!step || !order.length) return
    event.preventDefault()
    const next = order[(at + step + order.length) % order.length]
    if (!next) return
    chat.setScope(next.id)
    group.current?.querySelector<HTMLButtonElement>(`[data-scope="${next.id}"]`)?.focus()
  }

  return (
    <div
      className="flex shrink-0 items-center gap-[10px] border-b border-line px-[12px] py-[8px] text-tiny text-muted"
      data-bot="scope"
    >
      <span id="bot-scope-label" className="whitespace-nowrap">
        Look in
      </span>
      <div
        ref={group}
        role="radiogroup"
        aria-labelledby="bot-scope-label"
        onKeyDown={keys}
        className="flex min-w-0 gap-[2px] rounded-[7px] border border-line bg-sunken p-[2px]"
      >
        {SCOPES.map((scope) => {
          const on = scope.id === chat.shownScope
          return (
            <button
              key={scope.id}
              type="button"
              role="radio"
              data-scope={scope.id}
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              disabled={busy || !available(scope.id)}
              onClick={() => chat.setScope(scope.id)}
              className={cx(
                'rounded-[5px] border-0 px-[9px] py-[5px] text-tiny whitespace-nowrap disabled:opacity-50 coarse:min-h-10',
                on
                  ? 'bg-active font-medium text-text'
                  : 'bg-transparent text-muted hover:text-text',
              )}
            >
              {scope.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function Conversation({ petState, autoFocus }: { petState: PetState; autoFocus: boolean }) {
  const chat = useBotChat()
  const look = usePetLook()
  const player = usePlayer()
  const logRef = useRef<HTMLDivElement>(null)
  const latest = chat.log.at(-1)
  const first = !chat.log.length && !chat.thinking

  // A chat opens on, and follows, its newest message.
  useLayoutEffect(() => {
    const element = logRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [chat.log.length, chat.thinking, chat.applied, chat.cardId])

  // Opening on a question moves focus to its first quick reply, which answers it in one tap.
  useEffect(() => {
    if (!autoFocus || latest?.kind !== 'reply' || !latest.suggestions.length) return
    logRef.current?.querySelector<HTMLButtonElement>('[data-bot="quick-reply"]')?.focus()
    // Only on opening.
  }, [])

  const small = (state: PetState) => (
    <Pet
      kind={look.settings.kind}
      state={state}
      size={22}
      motion="off"
      pixel={look.pixel}
      paint={look.paint}
    />
  )

  return (
    <div
      ref={logRef}
      role="log"
      aria-label="Conversation"
      aria-live="polite"
      data-bot="log"
      className="flex min-h-0 flex-1 flex-col gap-[14px] overflow-y-auto px-[14px] pt-[14px] pb-[18px] [overflow-wrap:anywhere]"
    >
      {chat.locked ? (
        <Locked petState={petState} />
      ) : first ? (
        <Centered
          pet={
            <Pet
              kind={look.settings.kind}
              state="idle"
              size={72}
              motion={look.motion}
              pixel={look.pixel}
              paint={look.paint}
            />
          }
          title={`Hi, I’m ${chat.name}.`}
        >
          <p className="m-0 max-w-[320px] text-small leading-[1.55] text-pretty text-muted">
            Tell me what you&rsquo;re after and I&rsquo;ll dig it out of your library. I go by tags:
            artist, genre, year, length, favourites and what you&rsquo;ve played. I can&rsquo;t hear
            the songs, so moods and tempos are off the menu for now.
          </p>
          <div className="mt-[4px] grid w-full max-w-[320px] gap-[8px]">
            {STARTERS.map((starter) => {
              const like = starter === 'Something like this song'
              if (like && !player.libraryTrack) return null
              return (
                <button
                  key={starter}
                  type="button"
                  className={cx(softButton, 'justify-between rounded-[6px] text-left')}
                  onClick={() => {
                    if (like && player.libraryTrack)
                      chat.setReference({
                        id: player.libraryTrack.id,
                        label: `${player.libraryTrack.title} · ${player.libraryTrack.artist}`,
                      })
                    void chat.send(starter)
                  }}
                >
                  {starter}
                  {like && player.libraryTrack && (
                    <small className="truncate text-tiny font-normal text-muted">
                      {player.libraryTrack.title} &middot; {player.libraryTrack.artist}
                    </small>
                  )}
                </button>
              )
            })}
          </div>
        </Centered>
      ) : (
        chat.log.map((entry) => (
          <Entry key={entry.id} entry={entry} latest={entry === latest} small={small} />
        ))
      )}
      {!chat.locked && chat.thinking && <Waiting small={small} />}
    </div>
  )
}

function Entry({
  entry,
  latest,
  small,
}: {
  entry: LogEntry
  latest: boolean
  small: (state: PetState) => ReactNode
}) {
  const chat = useBotChat()
  const win95 = usePetLook().pixel
  const busy = chat.thinking || chat.applying

  if (win95 && (entry.kind === 'user' || entry.kind === 'reply'))
    return (
      <div className="grid gap-[6px]" data-bot={entry.kind === 'user' ? 'you' : 'bot'}>
        <p className={cx('m-0', entry.kind === 'reply' && 'text-muted')}>
          <strong className="font-bold">{entry.kind === 'user' ? 'You:' : `${chat.name}:`}</strong>{' '}
          {entry.text}
        </p>
        {entry.kind === 'reply' && <ReplyExtras entry={entry} latest={latest} busy={busy} />}
      </div>
    )

  if (entry.kind === 'user')
    return (
      <div className="grid w-fit max-w-[82%] shrink-0 justify-items-end gap-[6px] self-end">
        {entry.about && <span className="text-micro text-muted">About {entry.about}</span>}
        <div
          data-bot="you"
          className="rounded-[14px_14px_4px_14px] bg-active px-[12px] py-[9px] leading-[1.45]"
        >
          {entry.text}
        </div>
      </div>
    )
  if (entry.kind === 'reply')
    return (
      <div className="grid shrink-0 grid-cols-[24px_minmax(0,1fr)] items-start gap-[8px]">
        {small(entry.mood === 'talking' ? 'idle' : entry.mood)}
        <div className="grid min-w-0 gap-[10px]" data-bot="bot">
          <p className="m-0 leading-[1.5]">{entry.text}</p>
          <ReplyExtras entry={entry} latest={latest} busy={busy} />
        </div>
      </div>
    )
  if (entry.kind === 'command' || entry.kind === 'note') {
    const Icon =
      entry.kind === 'command' ? { pause: Pause, play: Play, skip: SkipForward }[entry.icon] : null
    return (
      <div
        className="inline-flex max-w-full shrink-0 items-center gap-[7px] self-center rounded-pill border border-line px-[10px] py-[4px] text-tiny text-muted"
        data-bot="note"
      >
        {Icon && <Icon size={13} aria-hidden="true" />}
        {entry.text}
      </div>
    )
  }
  return (
    <div className="grid shrink-0 grid-cols-[24px_minmax(0,1fr)] items-start gap-[8px]">
      {small('sorry')}
      <div className="grid min-w-0 gap-[10px]">
        <p className="m-0 leading-[1.5]">{entry.aside}</p>
        <div
          role="alert"
          className={cx(
            'grid gap-[10px] rounded-[5px] px-[13px] py-[12px] text-small leading-[1.6]',
            entry.tone === 'warn' ? 'bg-warn-bg text-warn' : 'bg-danger-bg text-danger',
          )}
        >
          <span>{entry.text}</span>
          {latest && entry.next && (entry.next === 'replace' || entry.prompt) && (
            <div className="flex flex-wrap gap-[8px]">
              <Button
                className="min-h-[36px] py-0"
                disabled={busy || chat.locked !== null}
                onClick={() => chat.retry(entry)}
              >
                {entry.next === 'replace'
                  ? 'Replace upcoming instead'
                  : entry.next === 'retry'
                    ? 'Try again'
                    : 'Send again'}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** A result's card, or the line it leaves once replaced; and a question's quick replies. */
function ReplyExtras({
  entry,
  latest,
  busy,
}: {
  entry: Extract<LogEntry, { kind: 'reply' }>
  latest: boolean
  busy: boolean
}) {
  const chat = useBotChat()
  return (
    <>
      {entry.card &&
        (entry.id === chat.cardId && chat.reply ? (
          <ResultCard reply={chat.reply} />
        ) : (
          <div className="flex items-center gap-[10px] rounded-[10px] border border-dashed border-line-strong px-[11px] py-[8px] text-tiny text-muted">
            <ListMusic size={14} aria-hidden="true" className="shrink-0" />
            <span className="flex-1">{entry.card}</span>
            <span className="whitespace-nowrap text-faint">Replaced</span>
          </div>
        ))}
      {entry.note && <p className="m-0 text-small leading-[1.5] text-muted">{entry.note}</p>}
      {latest && entry.suggestions.length > 0 && (
        <div role="group" aria-label="Quick replies" className="flex flex-wrap gap-[8px]">
          {entry.suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              data-bot="quick-reply"
              disabled={busy || chat.locked !== null}
              onClick={() => void chat.send(suggestion)}
              className="inline-flex min-h-[36px] items-center rounded-pill border border-accent bg-transparent px-[13px] text-small font-medium whitespace-nowrap text-accent hover:bg-hover disabled:opacity-50 coarse:min-h-11"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </>
  )
}

/** While a request is out: dots when warm, a progress line when the model has to load first. */
function Waiting({ small }: { small: (state: PetState) => ReactNode }) {
  const chat = useBotChat()
  const look = usePetLook()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const seconds = chat.startedAt ? Math.max(0, Math.round((now - chat.startedAt) / 1000)) : 0
  const moving = look.motion !== 'off'

  if (chat.cold)
    return (
      <div className="grid shrink-0 grid-cols-[24px_minmax(0,1fr)] items-start gap-[8px]">
        {small('thinking')}
        <div className="grid gap-[10px] rounded-[12px] border border-line bg-sunken p-[12px]">
          <p className="m-0 leading-[1.5]">
            Waking up the model. The first reply takes 10 to 15 seconds while it loads; after that
            I&rsquo;m much quicker.
          </p>
          <div className="h-[4px] overflow-hidden rounded-pill bg-line" aria-hidden="true">
            <div
              className="h-full w-[35%] rounded-pill bg-accent"
              style={moving ? { animation: 'chat-slide 1.6s ease-in-out infinite' } : undefined}
            />
          </div>
          {/* The seconds tick visibly but are not announced, so a long wait is said once. */}
          <span className="text-tiny text-muted tabular-nums" aria-hidden="true">
            {seconds} s &middot; You can keep browsing; I&rsquo;ll tap the player when it&rsquo;s
            ready.
          </span>
        </div>
      </div>
    )
  return (
    <div className="grid shrink-0 grid-cols-[24px_minmax(0,1fr)] items-center gap-[8px]">
      {small('thinking')}
      <div className="flex items-center gap-[10px] text-small text-muted">
        <span
          className="inline-flex gap-[4px] rounded-[14px_14px_14px_4px] border border-line bg-sunken px-[12px] py-[9px]"
          aria-hidden="true"
        >
          {[0, 1, 2].map((i) => (
            <i
              key={i}
              className="size-[5px] rounded-full bg-muted"
              style={
                moving ? { animation: `pet-dot 1.2s ease-in-out ${i * 0.2}s infinite` } : undefined
              }
            />
          ))}
        </span>
        Finding music&hellip;
      </div>
    </div>
  )
}
