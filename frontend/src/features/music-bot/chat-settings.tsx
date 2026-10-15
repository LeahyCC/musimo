import { useState } from 'react'

import { Link } from '@tanstack/react-router'
import { Check, Trash2 } from 'lucide-react'

import { cx } from '../../lib/cx'
import { Button } from '../../ui'
import { useBotChat } from './bot-chat'
import { softButton } from './chat-buttons'
import { Pet } from './pet'
import type { PetState } from './pet-mood'
import { usePetLook } from './use-pet'

/** Model, connection test, the rules the bot reads the library by, and Clear chat. */
export function ChatSettings({ petState }: { petState: PetState }) {
  const chat = useBotChat()
  const look = usePetLook()
  const models = chat.models.data?.models ?? []
  const [tested, setTested] = useState<{ ok: boolean; text: string } | null>(null)
  const timezone = chat.settings.data?.music_timezone.value ?? 'UTC'
  const url = chat.settings.data?.ollama_url.value ?? ''
  const lockedModel = chat.settings.data?.ollama_model.locked

  async function test() {
    setTested(null)
    const result = await chat.models.refetch()
    if (result.data)
      setTested({
        ok: true,
        text: `Connected. ${result.data.models.length} installed ${result.data.models.length === 1 ? 'model' : 'models'} (${result.data.elapsed_ms} ms).`,
      })
    else setTested({ ok: false, text: result.error?.message ?? 'Could not reach Ollama.' })
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-[14px] overflow-y-auto p-[14px]"
      data-bot="settings"
    >
      <section aria-labelledby="bot-set-model" className="grid shrink-0 gap-[10px]">
        <h3 id="bot-set-model" className="m-0 text-small font-[550]">
          Model
        </h3>
        {models.length > 0 ? (
          <div role="radiogroup" aria-labelledby="bot-set-model" className="grid gap-[6px]">
            {models.map((model) => {
              const on = model === chat.model
              return (
                <label
                  key={model}
                  className={cx(
                    'flex min-h-11 items-center gap-[10px] rounded-[8px] border px-[11px] py-[9px] text-small',
                    on ? 'border-accent bg-active' : 'border-line bg-sunken',
                  )}
                >
                  <input
                    type="radio"
                    name="bot-model"
                    checked={on}
                    disabled={chat.choosingModel || lockedModel}
                    onChange={() => chat.chooseModel(model)}
                    className="m-0 accent-[var(--color-accent)]"
                  />
                  <span className="flex-1">{model}</span>
                </label>
              )
            })}
          </div>
        ) : (
          <p
            role="alert"
            className="m-0 rounded-[5px] bg-danger-bg p-[13px] text-small leading-[1.6] text-danger"
          >
            {chat.models.isError
              ? chat.models.error.message
              : 'No installed models. Install a chat model in Ollama, then retry. For example, run '}
            {!chat.models.isError && (
              <code className="font-mono text-tiny">ollama pull qwen2.5:7b</code>
            )}
            {!chat.models.isError && '.'}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-[8px]">
          <button
            type="button"
            className={softButton}
            disabled={chat.models.isFetching}
            onClick={() => void test()}
          >
            Test connection
          </button>
          <button
            type="button"
            className={softButton}
            disabled={chat.models.isFetching}
            onClick={() => void chat.models.refetch()}
          >
            Refresh models
          </button>
        </div>
        {tested && (
          <p
            role="status"
            className={cx(
              'm-0 flex items-center gap-[6px] text-small',
              tested.ok ? 'text-good' : 'text-danger',
            )}
          >
            {tested.ok && <Check size={14} aria-hidden="true" />}
            {tested.text}
          </p>
        )}
      </section>
      <section className="grid shrink-0 gap-[6px] border-t border-line pt-[14px]">
        <h3 className="m-0 text-small font-[550]">How I read your library</h3>
        <p className="m-0 text-small leading-[1.6] text-muted">
          Played today uses {timezone}. Favourites means your Liked playlist. The model server is{' '}
          {url || 'not set'}; change it in{' '}
          <Link to="/settings" hash="music-bot" className="text-accent underline">
            Server settings
          </Link>
          .
        </p>
      </section>
      <section className="grid shrink-0 gap-[8px] border-t border-line pt-[14px]">
        <h3 className="m-0 text-small font-[550]">Conversation</h3>
        <p className="m-0 text-small leading-[1.6] text-muted">
          I keep the last 8 messages in this tab, and forget them when it closes.
        </p>
        <Button
          variant="danger"
          className="justify-self-start"
          disabled={!chat.log.length && !chat.reply}
          onClick={chat.clear}
        >
          <Trash2 size={14} aria-hidden="true" />
          Clear chat
        </Button>
      </section>
      <section className="flex shrink-0 items-center gap-[10px] border-t border-line pt-[14px] text-small">
        <Pet
          kind={look.settings.kind}
          state={petState === 'offline' ? 'offline' : 'idle'}
          size={28}
          motion="off"
          pixel={look.pixel}
          paint={look.paint}
        />
        <span className="flex-1 text-muted">Character, name, size, sounds and more</span>
        <Link
          to="/settings/user"
          hash="music-bot-pet"
          className="text-accent underline coarse:min-h-11 coarse:content-center"
        >
          Pet settings
        </Link>
      </section>
    </div>
  )
}
