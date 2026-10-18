import { useEffect, useId, useRef } from 'react'

import { AlertTriangle } from 'lucide-react'

import { cx } from '../../lib/cx'
import { MIN_CONTRAST, themeContrast } from '../../theme/contrast'
import { HEX_COLOR, MAX_THEME_NAME } from '../../theme/schema'
import type { Theme } from '../../theme/themes'
import { COLOR_TOKENS, TOKEN_GROUPS } from '../../theme/tokens'
import {
  Button,
  ErrorBanner,
  Field,
  FieldSelect,
  InlineError,
  Ownership,
  StatusChip,
  Tag,
} from '../../ui'

/*
 * Leaving this page ends the edit, so the page itself has to show every color being chosen. The
 * shell around it shows the surfaces, the text and the accent. This strip shows the rest: the
 * status colors, the ownership chips, the live accent and text over artwork, none of which appear
 * anywhere else on the page. It is built from the same primitives the screens use, so what it
 * shows is what they will look like.
 */
function ThemePreview() {
  return (
    <section
      aria-labelledby="preview-heading"
      className="grid gap-[12px] rounded-lg border border-line bg-raised p-[16px] shadow-[0_6px_24px_color-mix(in_oklab,var(--color-shadow)_40%,transparent)]"
    >
      <h3 id="preview-heading">Preview</h3>
      <p className="text-small">
        Secondary text looks like this. <span className="text-faint">Faint text like this.</span>
      </p>
      <div className="flex flex-wrap items-center gap-[8px]">
        <Button variant="primary" tabIndex={-1}>
          Primary
        </Button>
        <Button tabIndex={-1}>Button</Button>
        <Button variant="danger" tabIndex={-1}>
          Danger
        </Button>
        <span className="rounded-pill bg-accent-hot px-[12px] py-[6px] text-small font-bold text-accent-ink">
          Live
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-[8px]">
        <Tag>TAG</Tag>
        <StatusChip variant="good">ready</StatusChip>
        <StatusChip>part way</StatusChip>
        <Ownership variant="owned">In library</Ownership>
        <Ownership variant="partial">Another edition</Ownership>
        <Ownership variant="failed">Failed</Ownership>
        <Ownership variant="missing">Queued</Ownership>
      </div>
      <div className="grid grid-cols-2 gap-[8px] max-phone:grid-cols-1">
        <ErrorBanner>An error message.</ErrorBanner>
        <p className="rounded-[5px] bg-warn-bg px-[13px] py-[13px] text-small text-warn">
          A warning message.
        </p>
        <div className="grid gap-[2px] rounded-md bg-sunken p-[6px] text-small">
          <span className="rounded-sm px-[8px] py-[6px]">A row</span>
          <span className="rounded-sm bg-hover px-[8px] py-[6px]">A row under the pointer</span>
          <span className="rounded-sm bg-active px-[8px] py-[6px] text-accent">A selected row</span>
        </div>
        <div className="relative grid min-h-[92px] content-end overflow-hidden rounded-md bg-media">
          <span className="bg-[linear-gradient(transparent,color-mix(in_oklab,var(--color-scrim)_80%,transparent))] px-[10px] pt-[24px] pb-[8px] text-small text-on-media">
            Text over artwork
          </span>
        </div>
      </div>
    </section>
  )
}

function ContrastReport({ colors }: { colors: Theme['colors'] }) {
  const readings = themeContrast(colors)
  const low = readings.filter((reading) => reading.ratio !== null && reading.ratio < MIN_CONTRAST)

  return (
    <section className="grid gap-[10px]" aria-labelledby="contrast-heading">
      <h3 id="contrast-heading">Readability</h3>
      <p className="text-small">
        Text is easy to read at {MIN_CONTRAST}:1 or more. A low number is a warning, and you can
        still save.
      </p>
      <dl className="grid gap-[6px]">
        {readings.map((reading) => {
          const isLow = reading.ratio !== null && reading.ratio < MIN_CONTRAST

          return (
            <div key={reading.label} className="flex flex-wrap justify-between gap-x-[16px]">
              <dt className="text-small text-muted">{reading.label}</dt>
              {/* The word, not only the warning color: that color is one of the ones being edited. */}
              <dd
                className={cx(
                  'inline-flex items-center gap-[6px] text-small tabular-nums',
                  isLow ? 'text-warn' : 'text-text',
                )}
              >
                {isLow && <AlertTriangle size={13} aria-hidden="true" />}
                {reading.ratio === null
                  ? 'not a color yet'
                  : `${reading.ratio.toFixed(1)}:1${isLow ? ', low' : ''}`}
              </dd>
            </div>
          )
        })}
      </dl>
      {low.length > 0 && (
        <p className="text-small text-warn">
          Hard to read: {low.map((reading) => reading.label.toLowerCase()).join(', ')}.
        </p>
      )}
    </section>
  )
}

const HEX_HINT = 'Use a # followed by six or eight digits.'

function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (next: string) => void
}) {
  const id = useId()
  const hint = useId()
  const valid = HEX_COLOR.test(value)
  // A native color input only understands `#rrggbb`, and it cannot show a half-typed hex at all,
  // so it keeps showing the last whole color this row held.
  const lastValid = useRef(value)
  if (valid) lastValid.current = value

  return (
    <div className="grid gap-[8px] border-b border-line py-[12px]">
      <label htmlFor={id} className="text-small">
        {label}
      </label>
      <div className="flex items-center gap-[10px]">
        <input
          id={id}
          type="color"
          value={lastValid.current.slice(0, 7)}
          className="h-11 w-11 shrink-0 rounded-sm"
          onChange={(event) => onChange(event.target.value)}
        />
        <Field
          aria-label={`${label} hex value`}
          aria-describedby={valid ? undefined : hint}
          invalid={!valid}
          fullWidth={false}
          value={value}
          maxLength={9}
          spellCheck={false}
          autoComplete="off"
          className="w-[130px] font-mono"
          onChange={(event) => onChange(event.target.value.trim())}
        />
      </div>
      {!valid && (
        <p id={hint} className="text-tiny text-danger">
          {HEX_HINT}
        </p>
      )}
    </div>
  )
}

/** The first thing stopping a save, in words, or an empty string when nothing is. */
function problemWith(draft: Theme): string {
  if (draft.name.trim().length === 0) return 'Give the theme a name.'
  const bad = COLOR_TOKENS.filter((token) => !HEX_COLOR.test(draft.colors[token.name]))
  if (bad.length === 0) return ''
  const names = bad.map((token) => token.label).join(', ')

  return `${bad.length === 1 ? 'This color needs' : 'These colors need'} a full hex value: ${names}.`
}

export function ThemeEditor({
  draft,
  onChange,
  onSave,
  onCancel,
  error,
}: {
  draft: Theme
  onChange: (next: Theme) => void
  onSave: () => void
  onCancel: () => void
  error: string
}) {
  const problem = problemWith(draft)
  const name = useRef<HTMLInputElement>(null)

  // Opening the editor replaces the control that had focus, so focus goes to the first field
  // rather than back to the top of the document.
  useEffect(() => name.current?.focus(), [])

  return (
    <form
      className="grid max-w-[720px] gap-[24px]"
      onSubmit={(event) => {
        event.preventDefault()
        if (!problem) onSave()
      }}
    >
      <h3>Editing {draft.name || 'this theme'}</h3>
      <p className="text-small">
        The app around you changes as you edit. Nothing is kept until you save. Cancel, or leaving
        this page, puts your saved theme back.
      </p>
      <ThemePreview />
      <div className="flex flex-wrap gap-[16px]">
        <div className="grid flex-1 gap-[6px]">
          <label htmlFor="theme-name" className="text-small">
            Name
          </label>
          <Field
            id="theme-name"
            ref={name}
            value={draft.name}
            required
            invalid={draft.name.trim().length === 0}
            maxLength={MAX_THEME_NAME}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
          />
        </div>
        <div className="grid gap-[6px]">
          <label htmlFor="theme-scheme" className="text-small">
            Scheme
          </label>
          <FieldSelect
            id="theme-scheme"
            value={draft.scheme}
            fullWidth={false}
            className="w-[150px]"
            onChange={(event) =>
              onChange({ ...draft, scheme: event.target.value === 'light' ? 'light' : 'dark' })
            }
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </FieldSelect>
          <p className="max-w-[220px] text-tiny">
            Tells the browser which scrollbars and pickers to draw.
          </p>
        </div>
      </div>
      {TOKEN_GROUPS.map((group) => (
        <section key={group} className="grid gap-[2px]" aria-labelledby={`group-${group}`}>
          <h3 id={`group-${group}`} className="mb-[4px] border-b border-line-strong pb-[8px]">
            {group}
          </h3>
          <div className="grid grid-cols-2 gap-x-[26px] max-phone:grid-cols-1">
            {COLOR_TOKENS.filter((token) => token.group === group).map((token) => (
              <ColorRow
                key={token.name}
                label={token.label}
                value={draft.colors[token.name]}
                onChange={(next) =>
                  onChange({ ...draft, colors: { ...draft.colors, [token.name]: next } })
                }
              />
            ))}
          </div>
        </section>
      ))}
      <ContrastReport colors={draft.colors} />
      {/* Sticky for the same reason the Server page's save bar is: the form is several screens
          long, and Cancel is the way out of a draft that has made the page unreadable. The offset
          clears the footer player, and on a phone the bottom bar and the home indicator. */}
      <div className="sticky bottom-[calc(var(--player-height)+var(--nav-height)+var(--safe-bottom)+8px)] z-sticky grid gap-[10px] rounded-[7px] border border-line-strong bg-raised px-[17px] py-[13px] max-phone:p-[12px]">
        {error && <InlineError role="alert">{error}</InlineError>}
        <div className="flex flex-wrap items-center justify-between gap-[12px]">
          <p className={cx('min-w-0 flex-1 text-small', problem && 'text-danger')} role="status">
            {problem || 'Save keeps this theme and turns it on.'}
          </p>
          <div className="flex gap-[10px]">
            <Button onClick={onCancel}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={Boolean(problem)}>
              Save
            </Button>
          </div>
        </div>
      </div>
    </form>
  )
}
