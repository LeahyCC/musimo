import { useState } from 'react'
import type { ReactNode } from 'react'

import { Link } from '@tanstack/react-router'
import { RefreshCw } from 'lucide-react'

import { Button, FieldSelect } from '../../ui'
import { useBotChat } from './bot-chat'
import { softButton } from './chat-buttons'
import { Pet } from './pet'
import type { PetState } from './pet-mood'
import { usePetLook } from './use-pet'

export function Centered({
  pet,
  title,
  children,
}: {
  pet: ReactNode
  title: string
  children: ReactNode
}) {
  return (
    <div className="my-auto grid shrink-0 justify-items-center gap-[12px] px-[4px] py-[10px] text-center">
      {pet}
      <h3 className="m-0 mt-[4px] text-[17px] font-[550]">{title}</h3>
      {children}
    </div>
  )
}

/** Busy, offline and no model: the chat cannot work, says why, and offers the way out. */
export function Locked({ petState }: { petState: PetState }) {
  const chat = useBotChat()
  const look = usePetLook()
  const [pick, setPick] = useState('')
  const pet = (
    <Pet
      kind={look.settings.kind}
      state={petState}
      size={72}
      motion={look.motion}
      pixel={look.pixel}
      paint={look.paint}
    />
  )
  const url = chat.settings.data?.ollama_url.value ?? 'the model server'

  if (chat.locked === 'busy') {
    const scan = chat.scan
    const done = scan?.indexed ?? 0
    const total = scan?.total_files || scan?.walked || 0
    const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 0
    const left = scanMinutesLeft(done, total, scan?.elapsed ?? 0)
    return (
      <Centered pet={pet} title="Still unpacking your library">
        <p className="m-0 max-w-[320px] text-small leading-[1.55] text-muted">
          A library scan is running. I can&rsquo;t search until it finishes, and big libraries take
          a few minutes. I&rsquo;ll be right here.
        </p>
        <div className="grid w-full max-w-[300px] gap-[6px] text-left">
          <div
            role="progressbar"
            aria-label="Library scan"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-[7px] overflow-hidden rounded-pill bg-line"
          >
            <div className="h-full bg-good" style={{ width: `${percent}%` }} />
          </div>
          <span className="text-tiny text-muted tabular-nums">
            {done.toLocaleString()}
            {total ? ` of ${total.toLocaleString()}` : ''} files
            {left !== null ? ` · about ${left} ${left === 1 ? 'minute' : 'minutes'} left` : ''}
          </span>
        </div>
        <Link
          to="/diagnostics"
          className="text-small text-accent underline coarse:min-h-11 coarse:content-center"
        >
          View the scan in Diagnostics
        </Link>
      </Centered>
    )
  }
  if (chat.locked === 'offline')
    return (
      <Centered pet={pet} title={'I can’t reach the model server'}>
        <p className="m-0 max-w-[320px] text-small leading-[1.55] text-muted">
          Ollama at {url} didn&rsquo;t answer. Is it running? Nothing else in Musimo is affected.
        </p>
        <div className="flex flex-wrap justify-center gap-[8px]">
          <button
            type="button"
            className={softButton}
            disabled={chat.models.isFetching}
            onClick={() => {
              void chat.settings.refetch()
              void chat.models.refetch()
            }}
          >
            <RefreshCw size={14} aria-hidden="true" />
            Retry connection
          </button>
          <Link
            to="/settings"
            hash="music-bot"
            className="inline-flex min-h-[39px] items-center px-[8px] text-small text-accent coarse:min-h-11"
          >
            Server settings
          </Link>
        </div>
      </Centered>
    )
  const models = chat.models.data?.models ?? []
  return (
    <Centered pet={pet} title="Pick a brain for me first">
      <p className="m-0 max-w-[320px] text-small leading-[1.55] text-muted">
        {models.length
          ? 'No model is chosen yet. Choose one of the models installed in Ollama and I’m good to go.'
          : 'Ollama answered, but it has no models installed. Install a chat model, for example with ollama pull qwen2.5:7b, then retry.'}
      </p>
      {models.length > 0 ? (
        <form
          className="grid w-full max-w-[300px] gap-[8px] text-left"
          onSubmit={(event) => {
            event.preventDefault()
            if (pick) chat.chooseModel(pick)
          }}
        >
          <label htmlFor="bot-pick-model" className="text-small">
            Installed Ollama model
          </label>
          <FieldSelect
            id="bot-pick-model"
            value={pick}
            onChange={(event) => setPick(event.target.value)}
          >
            <option value="">Choose a model</option>
            {models.map((model) => (
              <option key={model}>{model}</option>
            ))}
          </FieldSelect>
          <Button
            type="submit"
            variant="primary"
            className="justify-self-start"
            disabled={!pick || chat.choosingModel || chat.settings.data?.ollama_model.locked}
          >
            Use this model
          </Button>
        </form>
      ) : (
        <button
          type="button"
          className={softButton}
          disabled={chat.models.isFetching}
          onClick={() => void chat.models.refetch()}
        >
          <RefreshCw size={14} aria-hidden="true" />
          Refresh models
        </button>
      )}
    </Centered>
  )
}

/** A rough "minutes left" from the scan's own rate, or null before there is a rate to go by. */
function scanMinutesLeft(done: number, total: number, elapsed: number): number | null {
  if (!total || done <= 0 || elapsed <= 5 || done >= total) return null
  return Math.max(1, Math.round((total - done) / (done / elapsed) / 60))
}
