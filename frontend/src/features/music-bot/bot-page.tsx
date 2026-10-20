import { useState } from 'react'

import { useNavigate, useRouter } from '@tanstack/react-router'
import { ChevronLeft, Settings, Trash2 } from 'lucide-react'

import type { BotScope } from '../../api'
import { cx } from '../../lib/cx'
import { useKeyboard } from '../../lib/use-keyboard'
import { Segmented, SelectChip } from '../../ui'
import { usePlayer } from '../player/player'
import { useBotChat } from './bot-chat'
import { headerButton } from './chat-buttons'
import { Composer } from './chat-composer'
import { Conversation, DOT, ScopeBar, statusLine } from './chat-panel'
import { ChatSettings } from './chat-settings'
import { Pet } from './pet'
import { ResultCard } from './result-card'
import { usePetLook, usePetState } from './use-pet'

/* The music bot's page in the two layouts. Classic is one centred column; the Listening room puts
   the chat beside a Draft panel that holds the result. Both draw the same conversation, the same
   composer and the same result card as the popover and sheet do, so every edit works the same.
   A phone has one page for both, `PhoneBotPage`, at the foot of this file. */

const SCOPES: readonly { value: BotScope; label: string }[] = [
  { value: 'library', label: 'Whole library' },
  { value: 'proposal', label: 'This selection' },
  { value: 'queue', label: 'Up next' },
]

/** The model picker and the scope control: the two things that shape the next request. */
function Controls({ className }: { className?: string }) {
  const chat = useBotChat()
  const player = usePlayer()
  const models = chat.models.data?.models ?? []
  const busy = chat.thinking || chat.applying || chat.confirming || chat.holding
  const available = (id: BotScope) =>
    id === 'library' ||
    (id === 'proposal' && Boolean(chat.reply?.tracks.length)) ||
    (id === 'queue' && player.queue.length > player.currentIndex + 1)

  return (
    <div className={cx('flex flex-wrap items-center gap-[10px]', className)}>
      {!chat.locked && models.length > 0 && (
        <SelectChip
          label="Model"
          value={chat.model}
          options={models.map((model) => ({ value: model, label: model }))}
          disabled={busy || chat.choosingModel}
          onChange={chat.chooseModel}
        />
      )}
      {!chat.locked && (
        <Segmented
          label="Look in"
          value={chat.shownScope}
          disabled={busy}
          onChange={(scope) => chat.setScope(scope)}
          options={SCOPES.map((scope) => ({ ...scope, disabled: !available(scope.value) }))}
        />
      )}
    </div>
  )
}

function Status({ className }: { className?: string }) {
  const chat = useBotChat()
  const status = statusLine(chat, false)
  return (
    <p
      role="status"
      data-bot="status"
      className={cx('m-0 flex items-center gap-[6px] truncate text-tiny text-muted', className)}
    >
      <i className={cx('size-[6px] shrink-0 rounded-full', DOT[status.tone])} aria-hidden="true" />
      {status.text}
    </p>
  )
}

function Back() {
  const router = useRouter()
  const navigate = useNavigate()
  // Back to the page before, when Musimo has one; from a bookmark there is none, so Search.
  return (
    <button
      type="button"
      className={cx(headerButton, '-ml-[6px] min-h-11 min-w-11')}
      aria-label="Back"
      onClick={() => {
        if (router.history.canGoBack()) router.history.back()
        else void navigate({ to: '/search' })
      }}
    >
      <ChevronLeft size={20} aria-hidden="true" />
    </button>
  )
}

function ChatTools({ onSettings }: { onSettings: () => void }) {
  const chat = useBotChat()
  const tool = cx(headerButton, 'rounded-[8px] hover:bg-hover')
  return (
    <div className="flex">
      <button type="button" className={tool} aria-label="Chat settings" onClick={onSettings}>
        <Settings size={17} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={tool}
        aria-label="Clear chat"
        disabled={!chat.log.length && !chat.reply}
        onClick={chat.clear}
      >
        <Trash2 size={17} aria-hidden="true" />
      </button>
    </div>
  )
}

/** Settings take the place of the chat, with a way back, so the page keeps one column. */
function SettingsView({ onBack }: { onBack: () => void }) {
  const petState = usePetState()
  return (
    <>
      <div className="flex items-center gap-[8px] border-b border-line pb-[10px]">
        <button
          type="button"
          className={cx(headerButton, '-ml-[6px] min-h-11 min-w-11')}
          aria-label="Back to chat"
          onClick={onBack}
        >
          <ChevronLeft size={20} aria-hidden="true" />
        </button>
        <h2 className="m-0 text-body font-[550]" data-bot="title">
          Chat settings
        </h2>
      </div>
      <ChatSettings petState={petState} />
    </>
  )
}

const classicHeight =
  'h-[calc(100dvh-var(--topbar-height)-var(--player-height)-150px)] min-h-[520px]'

export function ClassicBotPage({ autoFocus }: { autoFocus: boolean }) {
  const chat = useBotChat()
  const look = usePetLook()
  const petState = usePetState()
  const [settings, setSettings] = useState(false)

  return (
    <section
      data-bot-page
      data-bot="panel"
      data-layout="page"
      aria-label={`Chat with ${chat.name}`}
      className={cx('mx-auto flex max-w-[820px] min-w-0 flex-col text-small', classicHeight)}
    >
      {settings ? (
        <SettingsView onBack={() => setSettings(false)} />
      ) : (
        <>
          <div
            data-bot="title-bar"
            className="flex shrink-0 flex-wrap items-center gap-[14px] border-b border-line pb-[16px]"
          >
            <Back />
            <span className="grid size-[44px] shrink-0 place-items-center" data-bot="title-pet">
              <Pet
                kind={look.settings.kind}
                state={petState}
                size={40}
                motion={look.motion}
                pixel={look.pixel}
                paint={look.paint}
              />
            </span>
            <div className="min-w-[160px] flex-1">
              <h2 className="m-0 text-[18px] leading-[1.25] font-semibold" data-bot="title">
                {chat.name}
              </h2>
              <Status className="mt-[3px]" />
            </div>
            <Controls />
            <ChatTools onSettings={() => setSettings(true)} />
          </div>
          <Conversation petState={petState} autoFocus={autoFocus} flush />
          <Composer autoFocus={autoFocus} look="page" />
        </>
      )}
    </section>
  )
}

export function RoomBotPage({ autoFocus }: { autoFocus: boolean }) {
  const chat = useBotChat()
  const petState = usePetState()
  const [settings, setSettings] = useState(false)

  return (
    <section
      data-bot-page
      data-bot="panel"
      data-layout="page"
      aria-label={`Chat with ${chat.name}`}
      className={cx(
        'grid min-w-0 gap-[16px] text-small',
        'grid-cols-[minmax(0,1fr)_minmax(0,1fr)] max-tablet:grid-cols-1',
        'h-[calc(100dvh-var(--topbar-height)-var(--player-height)-150px)] min-h-[520px] max-tablet:h-auto',
      )}
    >
      <div
        className={cx(
          'flex min-h-0 min-w-0 flex-col gap-[12px]',
          'max-tablet:h-[calc(100dvh-var(--topbar-height)-var(--safe-top)-var(--player-height)-var(--nav-height)-var(--safe-bottom)-72px)] max-tablet:min-h-[420px]',
        )}
      >
        {settings ? (
          <SettingsView onBack={() => setSettings(false)} />
        ) : (
          <>
            <div data-bot="title-bar" className="flex shrink-0 flex-wrap items-center gap-[8px]">
              <Back />
              <h2 className="sr-only" data-bot="title">
                {chat.name}
              </h2>
              <Status className="h-[30px] rounded-pill bg-raised px-[10px]" />
              <Controls className="order-1 w-full" />
              <div className="ml-auto">
                <ChatTools onSettings={() => setSettings(true)} />
              </div>
            </div>
            <Conversation petState={petState} autoFocus={autoFocus} card="draft" flush />
            <Composer autoFocus={autoFocus} look="room" />
          </>
        )}
      </div>

      <section
        aria-label="Draft"
        data-bot="draft"
        className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[18px] bg-raised"
      >
        <div className="min-h-0 flex-1 overflow-y-auto">
          {chat.reply ? (
            <ResultCard reply={chat.reply} variant="draft" />
          ) : (
            <div className="grid gap-[10px] p-[18px]">
              <span className="w-fit rounded-[5px] bg-partial-bg px-[7px] py-[3px] font-mono text-[10.5px] tracking-[0.6px] text-partial">
                DRAFT · NOT PLAYING
              </span>
              <p className="m-0 leading-[1.5] text-muted">
                Nothing here yet. Ask for music and the songs show up here first. Nothing plays
                until you say so.
              </p>
            </div>
          )}
        </div>
      </section>
    </section>
  )
}

/**
 * A phone's chat page, in either layout, laid out like a messaging app: one header row, where the
 * next request looks, the conversation, and the text box at the foot. It is fixed between the top
 * bar and the player, so the page never scrolls the box away, and while the on-screen keyboard is
 * up it sits on the keyboard instead (`useKeyboard`). The result card is a message in the
 * conversation, as in the pet's sheet; a Draft beside the chat has no room on a phone. The model
 * is picked in Chat settings, where the status line's model name points.
 */
export function PhoneBotPage({ autoFocus, look }: { autoFocus: boolean; look: 'page' | 'room' }) {
  const chat = useBotChat()
  const pet = usePetLook()
  const petState = usePetState()
  const [settings, setSettings] = useState(false)
  useKeyboard(true)

  return (
    <section
      data-bot-page
      data-bot="panel"
      data-layout="page"
      data-bot-phone=""
      aria-label={`Chat with ${chat.name}`}
      className="fixed inset-x-0 top-[calc(var(--topbar-height)+var(--safe-top))] bottom-[calc(var(--player-height)+var(--nav-height)+var(--safe-bottom))] z-header flex min-w-0 flex-col bg-canvas pr-[calc(16px+var(--safe-right))] pl-[calc(16px+var(--safe-left))] text-small"
    >
      {settings ? (
        <SettingsView onBack={() => setSettings(false)} />
      ) : (
        <>
          <div
            data-bot="title-bar"
            className="flex shrink-0 items-center gap-[8px] border-b border-line py-[4px]"
          >
            <Back />
            <span className="grid size-[32px] shrink-0 place-items-center" data-bot="title-pet">
              <Pet
                kind={pet.settings.kind}
                state={petState}
                size={30}
                motion={pet.motion}
                pixel={pet.pixel}
                paint={pet.paint}
              />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="m-0 truncate text-body leading-[1.25] font-[550]" data-bot="title">
                {chat.name}
              </h2>
              <Status className="mt-[1px]" />
            </div>
            <ChatTools onSettings={() => setSettings(true)} />
          </div>
          {!chat.locked && <ScopeBar flush />}
          <Conversation petState={petState} autoFocus={autoFocus} flush />
          <Composer autoFocus={autoFocus} look={look} />
        </>
      )}
    </section>
  )
}
