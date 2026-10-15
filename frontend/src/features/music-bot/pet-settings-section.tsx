import { useState } from 'react'
import type { CSSProperties } from 'react'

import { Link } from '@tanstack/react-router'
import { Pause, Play, Volume2 } from 'lucide-react'

import { cx } from '../../lib/cx'
import { useTheme } from '../../theme/store'
import { Button, Field, FieldSelect } from '../../ui'
import { Pet } from './pet'
import type { PetState } from './pet-mood'
import {
  DEFAULT_PET_NAME,
  MAX_PET_NAME,
  PET_COLOUR_LABELS,
  PET_COLOURS,
  PET_KINDS,
  petMotion,
  petPaint,
  resetPetSettings,
  setPetSettings,
  usePetSettings,
} from './pet-settings'
import type { PetChattiness, PetMotionSetting, PetPosition, PetSize } from './pet-settings'
import { useDeviceReducedMotion } from './use-pet'

const KIND_LABELS = { cat: 'Cat', bird: 'Bird', robot: 'Robot', blob: 'Blob' } as const

/** The preview's reaction buttons: what each one stands for, and what the pet does. */
const REACTIONS: readonly { id: string; label: string; state: PetState; note: string }[] = [
  {
    id: 'play',
    label: 'Play',
    state: 'listening',
    note: 'Listening. It knows a song started; it can’t hear it, so no dancing to the beat.',
  },
  {
    id: 'pause',
    label: 'Pause a while',
    state: 'sleeping',
    note: 'Sleeping after a few minutes paused, or while the sleep timer runs.',
  },
  {
    id: 'skip',
    label: 'Skip',
    state: 'happy',
    note: 'A quick perk-up on skip or track change, then back to listening.',
  },
  {
    id: 'reply',
    label: 'New reply',
    state: 'talking',
    note: 'A reply came in with the chat closed: a dot, and in Normal or Chatty a short bubble.',
  },
  {
    id: 'thinking',
    label: 'Thinking',
    state: 'thinking',
    note: 'Waiting on the model. The first reply after a while can take 10 to 15 seconds.',
  },
  {
    id: 'sorry',
    label: 'Something failed',
    state: 'sorry',
    note: 'Apologetic, with the reason in the chat.',
  },
]

const CHATTY_NOTES: Record<PetChattiness, string> = {
  quiet: 'Only replies when you ask. New replies show as a dot.',
  normal: 'Replies, plus a short bubble when a reply is waiting.',
  chatty:
    'Also small asides on track changes, like “New one: Teardrop, from Mezzanine.” Facts only; it never rates a song.',
}

type Segment<T extends string> = { value: T; label: string }

function Segmented<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
  note,
}: {
  id: string
  label: string
  value: T
  options: readonly Segment<T>[]
  onChange: (value: T) => void
  note: string
}) {
  return (
    <div className="grid gap-[6px]">
      <span id={id} className="text-small">
        {label}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={id}
        className="inline-flex gap-[3px] justify-self-start rounded-pill border border-line bg-sunken p-[3px]"
      >
        {options.map((option) => {
          const on = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(option.value)}
              className={cx(
                'inline-flex items-center justify-center rounded-pill border-0 px-[16px] py-[8px] text-small whitespace-nowrap coarse:min-h-11',
                on ? 'bg-active text-text' : 'bg-transparent text-muted hover:text-text',
              )}
            >
              {option.label}
            </button>
          )
        })}
      </div>
      <p className="m-0 text-tiny leading-[1.6] text-muted">{note}</p>
    </div>
  )
}

/**
 * Settings › Yours › Music bot pet. Every control applies as it is chosen, to the pet on the
 * player too, and the preview beside them shows the result on a mock player.
 */
export function PetSettingsSection() {
  const settings = usePetSettings()
  const theme = useTheme()
  const reduced = useDeviceReducedMotion()
  const [draftName, setDraftName] = useState<string | null>(null)
  const [reaction, setReaction] = useState(REACTIONS[0]?.id ?? 'play')
  const [kept, setKept] = useState(true)
  const react = REACTIONS.find((entry) => entry.id === reaction) ?? REACTIONS[0]
  const motion = petMotion(settings.motion, reduced)
  const paint = petPaint(settings.colour, theme.scheme)
  const pixel = theme.skin === 'win95'
  const name = settings.name
  const save = (patch: Parameters<typeof setPetSettings>[0]) => setKept(setPetSettings(patch))
  const previewSize = { small: 32, medium: 44, large: 56 }[settings.size]
  const left: Record<PetPosition, string> = {
    left: '40px',
    centre: '50%',
    right: 'calc(100% - 40px)',
  }
  const bubble =
    react?.id === 'reply' && settings.chattiness !== 'quiet'
      ? '15 songs ready when you are.'
      : react?.id === 'skip' && settings.chattiness === 'chatty'
        ? 'New one: Inertia Creeps, from Mezzanine.'
        : ''

  return (
    <section
      id="music-bot-pet"
      aria-labelledby="pet-heading"
      className="grid scroll-mt-[100px] gap-[20px]"
    >
      <h2 id="pet-heading" className="border-b border-line pb-[17px] text-section">
        Music bot pet
      </h2>
      <p className="m-0 max-w-[640px] text-small leading-[1.6] text-muted">
        How {name} looks and behaves in this browser. Changes apply straight away, including on the
        player that is open now. Which model it talks to is under{' '}
        <Link to="/settings" hash="music-bot" className="text-accent underline">
          Server › Music bot
        </Link>
        .
      </p>
      {!kept && (
        <p role="status" className="m-0 text-small text-warn">
          This browser would not save the change, so it lasts until the page closes.
        </p>
      )}
      <div className="grid grid-cols-[minmax(0,560px)_minmax(0,1fr)] items-start gap-[40px] max-tablet:grid-cols-1">
        <div className="grid gap-[26px]">
          <fieldset className="m-0 grid gap-[10px] border-0 p-0">
            <legend className="mb-[8px] text-small">Character</legend>
            <div
              role="radiogroup"
              aria-label="Character"
              className="grid grid-cols-4 gap-[10px] max-phone:grid-cols-2"
            >
              {PET_KINDS.map((kind) => {
                const on = settings.kind === kind
                return (
                  <button
                    key={kind}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => save({ kind })}
                    className={cx(
                      'grid justify-items-center gap-[10px] rounded-[8px] border px-[6px] pt-[14px] pb-[10px] text-text',
                      on ? 'border-accent bg-active' : 'border-line bg-raised hover:bg-hover',
                    )}
                  >
                    <span className="flex h-[40px] items-end gap-[9px]">
                      <Pet
                        kind={kind}
                        state="idle"
                        size={34}
                        motion="off"
                        pixel={pixel}
                        paint={paint}
                      />
                      <Pet
                        kind={kind}
                        state="listening"
                        size={22}
                        motion="off"
                        pixel={pixel}
                        paint={paint}
                      />
                      <Pet
                        kind={kind}
                        state="happy"
                        size={22}
                        motion="off"
                        pixel={pixel}
                        paint={paint}
                      />
                    </span>
                    <span className="text-small font-medium">{KIND_LABELS[kind]}</span>
                  </button>
                )
              })}
            </div>
          </fieldset>

          <div className="grid gap-[6px]">
            <label htmlFor="pet-name" className="text-small">
              Name
            </label>
            <Field
              id="pet-name"
              value={draftName ?? name}
              maxLength={MAX_PET_NAME}
              fullWidth={false}
              className="w-[240px]"
              aria-describedby="pet-name-note"
              invalid={draftName !== null && !draftName.trim()}
              onChange={(event) => {
                const typed = event.target.value
                setDraftName(typed)
                if (typed.trim()) save({ name: typed.trim() })
              }}
              onBlur={() => setDraftName(null)}
            />
            <p id="pet-name-note" className="m-0 text-tiny leading-[1.6] text-muted">
              {draftName !== null && !draftName.trim()
                ? `A name needs at least one letter. Leave it empty and ${name} stays.`
                : `Shown in the chat: “Ask ${name} for music”. Up to ${MAX_PET_NAME} characters. Screen readers hear “${name}, music bot”.`}
            </p>
          </div>

          <fieldset className="m-0 grid gap-[8px] border-0 p-0">
            <legend className="mb-[6px] text-small">Colour</legend>
            <div
              role="radiogroup"
              aria-label="Colour"
              className="flex flex-wrap items-center gap-[10px]"
            >
              {PET_COLOURS.map((colour) => {
                const on = settings.colour === colour
                const swatch = petPaint(colour, theme.scheme)
                const dot: CSSProperties = { background: swatch?.body ?? 'var(--color-accent)' }
                return (
                  <button
                    key={colour}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={PET_COLOUR_LABELS[colour]}
                    title={PET_COLOUR_LABELS[colour]}
                    onClick={() => save({ colour })}
                    className={cx(
                      'inline-flex h-[36px] items-center gap-[8px] rounded-pill border py-0 pl-[4px] text-small text-text coarse:h-11',
                      colour === 'theme' ? 'pr-[12px]' : 'pr-[4px]',
                      on
                        ? 'border-accent bg-active shadow-[0_0_0_1px_var(--color-accent)]'
                        : 'border-line bg-raised',
                    )}
                  >
                    <i
                      aria-hidden="true"
                      className="size-[26px] rounded-full shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-text)_18%,transparent)]"
                      style={dot}
                    />
                    {colour === 'theme' && 'Theme accent'}
                  </button>
                )
              })}
            </div>
            <p className="m-0 text-tiny leading-[1.6] text-muted">
              Following the theme keeps {name} in your accent on any theme, custom ones included. A
              picked colour uses that family&rsquo;s light or dark accent to match your theme; where
              its face would fall below AA contrast, the theme accent stands in.
            </p>
          </fieldset>

          <Segmented<PetSize>
            id="pet-size"
            label="Size"
            value={settings.size}
            options={[
              { value: 'small', label: 'Small' },
              { value: 'medium', label: 'Medium' },
              { value: 'large', label: 'Large' },
            ]}
            onChange={(size) => save({ size })}
            note="Phones use Small or Medium, whichever is smaller."
          />
          <Segmented<PetPosition>
            id="pet-position"
            label="Sits on the player"
            value={settings.position}
            options={[
              { value: 'left', label: 'Left' },
              { value: 'centre', label: 'Centre' },
              { value: 'right', label: 'Right' },
            ]}
            onChange={(position) => save({ position })}
            note="It perches above the bar’s top edge, so the controls, seek bar and volume stay clear. Phones keep it on the left. On Now Playing it sits beside the title."
          />
          <Segmented<PetChattiness>
            id="pet-chattiness"
            label="Chattiness"
            value={settings.chattiness}
            options={[
              { value: 'quiet', label: 'Quiet' },
              { value: 'normal', label: 'Normal' },
              { value: 'chatty', label: 'Chatty' },
            ]}
            onChange={(chattiness) => save({ chattiness })}
            note={CHATTY_NOTES[settings.chattiness]}
          />

          <div className="grid gap-[6px]">
            <label htmlFor="pet-motion" className="text-small">
              Animation
            </label>
            <FieldSelect
              id="pet-motion"
              value={settings.motion}
              fullWidth={false}
              className="w-[240px]"
              aria-describedby="pet-motion-note"
              onChange={(event) => save({ motion: event.target.value as PetMotionSetting })}
            >
              <option value="system">Follow this device ({reduced ? 'reduced' : 'full'})</option>
              <option value="full">Full</option>
              <option value="reduced">Reduced</option>
              <option value="off">Off</option>
            </FieldSelect>
            <p id="pet-motion-note" className="m-0 text-tiny leading-[1.6] text-muted">
              Reduced keeps blinks and fades but drops hops, sways and travel. Off holds each pose
              still. With reduced motion set on this device, Follow starts at Reduced, and the
              device setting holds every animation still whatever is chosen here.
            </p>
          </div>

          <div className="grid gap-[6px]">
            <label className="flex items-center gap-[10px] text-small">
              <input
                type="checkbox"
                checked={settings.sounds}
                onChange={(event) => save({ sounds: event.target.checked })}
                className="m-0 size-[16px] accent-[var(--color-accent)]"
              />
              Sounds
            </label>
            <p className="m-0 text-tiny leading-[1.6] text-muted">
              Off by default. A soft chirp for a new reply, only while nothing is playing: {name}{' '}
              never plays over your music or lowers its volume.
            </p>
          </div>

          <div className="grid gap-[6px]">
            <label className="flex items-center gap-[10px] text-small">
              <input
                type="checkbox"
                checked={settings.hidden}
                onChange={(event) => save({ hidden: event.target.checked })}
                className="m-0 size-[16px] accent-[var(--color-accent)]"
              />
              Hide {name}
            </label>
            <p className="m-0 text-tiny leading-[1.6] text-muted">
              Takes the pet off the player. The chat stays under Music bot in the sidebar, and a dot
              there says when a reply is waiting.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-[12px]">
            <Button
              onClick={() => {
                setDraftName(null)
                setKept(resetPetSettings())
              }}
            >
              Reset pet to default
            </Button>
            <p className="m-0 text-small text-muted">
              Cat, named {DEFAULT_PET_NAME}, theme accent, medium, on the left.
            </p>
          </div>
        </div>

        <section
          aria-labelledby="pet-preview-heading"
          className="sticky top-[calc(var(--topbar-height)+20px)] grid gap-[14px] rounded-[8px] border border-line p-[23px] max-tablet:static"
        >
          <h3 id="pet-preview-heading" className="m-0 text-body font-[550]">
            Preview
          </h3>
          <div
            aria-hidden="true"
            data-pet="preview"
            className="relative h-[210px] overflow-hidden rounded-[8px] border border-line bg-canvas"
          >
            <div className="absolute top-[18px] left-[16px] grid gap-[8px]">
              <i className="h-[8px] w-[140px] rounded-[4px] bg-line" />
              <i className="h-[8px] w-[90px] rounded-[4px] bg-line" />
            </div>
            {!settings.hidden && (
              <>
                <div
                  className="absolute bottom-[62px] flex -translate-x-1/2 items-end justify-center transition-[left] duration-300 motion-reduce:transition-none"
                  style={{ left: left[settings.position] }}
                >
                  <Pet
                    kind={settings.kind}
                    state={react?.state ?? 'listening'}
                    size={previewSize}
                    motion={motion}
                    pixel={pixel}
                    paint={paint}
                  />
                </div>
                {bubble && (
                  <div className="absolute bottom-[128px] left-1/2 -translate-x-1/2 rounded-[12px] border border-line-strong bg-raised px-[10px] py-[6px] text-tiny whitespace-nowrap">
                    {bubble}
                  </div>
                )}
              </>
            )}
            <div className="absolute inset-x-0 bottom-0 flex h-[62px] items-center gap-[12px] border-t border-line-strong bg-raised px-[16px]">
              <span className="size-[38px] shrink-0 rounded-[6px] bg-active" />
              <span className="grid min-w-0 flex-1 gap-[4px]">
                <strong className="text-small font-medium">Teardrop</strong>
                <small className="text-micro text-muted">Massive Attack</small>
              </span>
              <span className="grid size-[32px] place-items-center rounded-pill bg-accent text-accent-ink">
                {react?.id === 'pause' ? <Play size={16} /> : <Pause size={16} />}
              </span>
              <i className="h-[4px] w-[90px] rounded-[4px] bg-[linear-gradient(to_right,var(--color-accent)_40%,var(--color-line-strong)_40%)] max-phone:hidden" />
              <Volume2 size={16} className="text-muted" />
            </div>
          </div>
          <div className="grid gap-[8px]">
            <span className="text-small text-muted">See it react</span>
            <div role="group" aria-label="Preview reactions" className="flex flex-wrap gap-[8px]">
              {REACTIONS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  aria-pressed={entry.id === reaction}
                  onClick={() => setReaction(entry.id)}
                  className={cx(
                    'inline-flex min-h-[34px] items-center rounded-[6px] border px-[11px] text-small font-medium whitespace-nowrap text-text coarse:min-h-11',
                    entry.id === reaction
                      ? 'border-accent bg-active'
                      : 'border-line-strong bg-hover',
                  )}
                >
                  {entry.label}
                </button>
              ))}
            </div>
            <p role="status" className="m-0 text-tiny leading-[1.6] text-muted">
              {react?.note}
            </p>
          </div>
        </section>
      </div>
    </section>
  )
}
