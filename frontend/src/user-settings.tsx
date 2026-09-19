import { useEffect, useId, useRef, useState } from 'react'

import { Link, useBlocker } from '@tanstack/react-router'
import { AlertTriangle, Check, Copy, Download, Pencil, Trash2 } from 'lucide-react'
import { FLUID_SIZES, SCENE_IDS, SCENE_LABELS } from 'visimo/catalog'
import { PRESETS } from 'visimo/presets'

import { cx } from './cx'
import { useNowPlayingPopout } from './now-playing-popout'
import { PageTitle } from './page-title'
import { parsePreamp, parseReplayGainMode, PREAMP_OPTIONS } from './replay-gain'
import {
  setReplayGainMode,
  setReplayGainPreamp,
  useReplayGainSettings,
} from './replay-gain-settings'
import { MIN_CONTRAST, themeContrast } from './theme/contrast'
import { HEX_COLOR, MAX_CUSTOM_THEMES, MAX_THEME_NAME } from './theme/schema'
import {
  cancelPreview,
  deleteTheme,
  draftTheme,
  exportTheme,
  hasRoomForTheme,
  importTheme,
  isBuiltInTheme,
  MAX_THEME_FILE_BYTES,
  previewTheme,
  saveAndActivate,
  setActiveTheme,
  themeFileName,
  useTheme,
  useThemes,
} from './theme/store'
import { DEFAULT_THEME_ID } from './theme/themes'
import type { Theme } from './theme/themes'
import { COLOR_TOKENS, TOKEN_GROUPS } from './theme/tokens'
import type { ColorToken } from './theme/tokens'
import {
  Button,
  ErrorBanner,
  Field,
  FieldSelect,
  InlineError,
  Ownership,
  Panel,
  StatusChip,
  Tag,
  textLinkClassName,
} from './ui'

/** The four colors that tell two themes apart at a glance, in the order the strip shows them. */
const SWATCH_TOKENS: readonly ColorToken[] = [
  '--color-canvas',
  '--color-raised',
  '--color-text',
  '--color-accent',
]

const switchLinkClassName =
  'inline-flex items-center justify-center rounded-pill px-[16px] py-[8px] text-small coarse:min-h-11'
const switchActiveProps = { 'className': 'bg-active text-text', 'aria-current': 'page' } as const
const switchInactiveProps = { className: 'text-muted' } as const

/**
 * Server settings and personal ones are two pages under one Settings entry, so the switch is what
 * says which of the two you are on. Both halves are routed links, which is also what keeps each
 * page's unsaved-changes blocker in front of a person leaving a draft behind.
 */
export function SettingsSwitch() {
  return (
    <nav
      aria-label="Settings type"
      className="mb-[24px] inline-flex gap-[3px] rounded-pill border border-line bg-sunken p-[3px]"
    >
      <Link
        to="/settings"
        activeOptions={{ exact: true }}
        className={switchLinkClassName}
        activeProps={switchActiveProps}
        inactiveProps={switchInactiveProps}
      >
        Server
      </Link>
      <Link
        to="/settings/user"
        className={switchLinkClassName}
        activeProps={switchActiveProps}
        inactiveProps={switchInactiveProps}
      >
        Yours
      </Link>
    </nav>
  )
}

function Swatches({ theme }: { theme: Theme }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 overflow-hidden rounded-sm border border-line"
    >
      {SWATCH_TOKENS.map((token) => (
        <span
          key={token}
          className="block h-[30px] w-[24px]"
          style={{ background: theme.colors[token] }}
        />
      ))}
    </span>
  )
}

function ThemeCard({
  theme,
  active,
  room,
  onPick,
  onDuplicate,
  onEdit,
  onExport,
  onDelete,
}: {
  theme: Theme
  active: boolean
  room: boolean
  onPick: () => void
  onDuplicate: () => void
  onEdit: () => void
  onExport: () => void
  onDelete: () => void
}) {
  const custom = !isBuiltInTheme(theme.id)

  return (
    <div
      className={cx(
        'grid content-start gap-[14px] rounded-lg border bg-raised p-[14px]',
        active ? 'border-accent' : 'border-line',
      )}
    >
      {/* The label is the touch target for the radio, so it is the one that has to reach 44px. */}
      <label className="flex cursor-pointer items-center gap-[12px] coarse:min-h-11">
        <input
          type="radio"
          name="theme"
          value={theme.id}
          checked={active}
          className="h-[18px] w-[18px] shrink-0 accent-accent"
          onChange={onPick}
        />
        <Swatches theme={theme} />
        <span className="min-w-0 flex-1 text-lead [overflow-wrap:anywhere]">{theme.name}</span>
        {/* A tick and the word, so the active card is not marked by its border color alone. */}
        {active && (
          <span className="inline-flex shrink-0 items-center gap-[4px] text-tiny text-accent">
            <Check size={14} />
            Active
          </span>
        )}
      </label>
      <div className="flex flex-wrap gap-[8px]">
        <Button
          aria-label={`Duplicate and edit ${theme.name}`}
          disabled={!room}
          onClick={onDuplicate}
        >
          <Copy size={14} />
          Duplicate and edit
        </Button>
        {custom && (
          <>
            <Button aria-label={`Edit ${theme.name}`} onClick={onEdit}>
              <Pencil size={14} />
              Edit
            </Button>
            <Button aria-label={`Export ${theme.name}`} onClick={onExport}>
              <Download size={14} />
              Export
            </Button>
            <Button variant="danger" aria-label={`Delete ${theme.name}`} onClick={onDelete}>
              <Trash2 size={14} />
              Delete
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

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

function ThemeEditor({
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

/** Hands the theme to the browser as a file. Nothing here leaves this machine. */
function download(theme: Theme) {
  const url = URL.createObjectURL(new Blob([exportTheme(theme)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = themeFileName(theme)
  // Safari only starts a download from a link that is in the document, and it reads the blob
  // some time after click() returns, so the link is attached and the URL is given a minute.
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

const same = (a: Theme, b: Theme): boolean => JSON.stringify(a) === JSON.stringify(b)

/*
 * These read and write the Now Playing stage's own state, from the provider at the app root, so
 * nothing here has its own copy of the storage keys: a change lands on an open stage at once, and
 * a change made on the stage shows up here. Every control applies as it is chosen, like themes.
 */
function VisualizerSettings() {
  const { view, setView, preset, setPreset, fluidSize, setFluidSize, canVisualize } =
    useNowPlayingPopout()

  return (
    <section aria-labelledby="visualizer" className="grid gap-[20px]">
      <h2 id="visualizer" className="border-b border-line pb-[17px] text-section">
        Visualizer
      </h2>
      <p className="max-w-[640px] text-small">
        What Now Playing shows and how the visualizer draws. Changes apply straight away, including
        on a Now Playing screen that is already open.
      </p>
      {!canVisualize && (
        <p className="text-small text-warn" role="status">
          The visualizer needs WebGPU, and this browser cannot provide it, so Now Playing shows the
          artwork.
        </p>
      )}
      <fieldset
        disabled={!canVisualize}
        className="m-0 grid max-w-[520px] gap-[16px] border-0 p-0 disabled:opacity-60"
      >
        <div className="grid gap-[6px]">
          <label htmlFor="visualizer-view" className="text-small">
            Default view
          </label>
          <FieldSelect
            id="visualizer-view"
            value={view}
            fullWidth={false}
            className="w-[200px]"
            onChange={(event) =>
              setView(event.target.value === 'artwork' ? 'artwork' : 'visualizer')
            }
          >
            <option value="artwork">Artwork</option>
            <option value="visualizer">Visualizer</option>
          </FieldSelect>
        </div>
        <div className="grid gap-[6px]">
          <label htmlFor="visualizer-preset" className="text-small">
            Preset
          </label>
          <FieldSelect
            id="visualizer-preset"
            value={preset.id}
            fullWidth={false}
            className="w-[260px] max-w-full"
            onChange={(event) => setPreset(event.target.value)}
          >
            {SCENE_IDS.map((id) => (
              <optgroup key={id} label={SCENE_LABELS[id]}>
                {PRESETS.filter((entry) => entry.scene === id).map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </FieldSelect>
        </div>
        <div className="grid gap-[6px]">
          <label htmlFor="visualizer-fluid" className="text-small">
            Fluid detail
          </label>
          <FieldSelect
            id="visualizer-fluid"
            value={fluidSize}
            fullWidth={false}
            className="w-[200px]"
            aria-describedby="visualizer-fluid-note"
            onChange={(event) => setFluidSize(Number(event.target.value))}
          >
            {FLUID_SIZES.map((size) => (
              <option key={size} value={size}>
                {size} grid
              </option>
            ))}
          </FieldSelect>
          <p id="visualizer-fluid-note" className="text-tiny">
            Only the fluid scene uses this. A larger grid is finer and asks more of the graphics
            card.
          </p>
        </div>
      </fieldset>
      <p className="text-small">
        <Link to="/now-playing" className={textLinkClassName()}>
          Open Now Playing
        </Link>
      </p>
    </section>
  )
}

const preampLabel = (decibels: number) =>
  decibels === 0 ? '0 dB' : `${decibels > 0 ? '+' : '−'}${Math.abs(decibels)} dB`

/*
 * Volume levelling for library playback. It reads and writes the player's own settings store, so a
 * change lands on a track that is already playing. Every control applies as it is chosen.
 */
function PlaybackSettings() {
  const { mode, preampDb } = useReplayGainSettings()

  return (
    <section aria-labelledby="playback" className="grid gap-[20px]">
      <h2 id="playback" className="border-b border-line pb-[17px] text-section">
        Playback
      </h2>
      <p className="max-w-[640px] text-small">
        Some files carry ReplayGain tags that say how loud they are. Musimo can use them to bring
        quiet and loud tracks to a similar volume. Changes apply straight away.
      </p>
      <div className="grid max-w-[520px] gap-[16px]">
        <div className="grid gap-[6px]">
          <label htmlFor="replay-gain-mode" className="text-small">
            Volume levelling
          </label>
          <FieldSelect
            id="replay-gain-mode"
            value={mode}
            fullWidth={false}
            className="w-[240px]"
            aria-describedby="replay-gain-note"
            onChange={(event) => setReplayGainMode(parseReplayGainMode(event.target.value))}
          >
            <option value="off">Off</option>
            <option value="track">Track</option>
            <option value="album">Album (automatic)</option>
          </FieldSelect>
          <p id="replay-gain-note" className="text-tiny">
            Track levels every song on its own. Album keeps an album’s own balance while it plays in
            order, and levels each song on its own otherwise. Tracks without tags play as they are.
            Musimo does not write ReplayGain tags to downloads yet, so only files tagged elsewhere
            are levelled.
          </p>
        </div>
        <div className="grid gap-[6px]">
          <label htmlFor="replay-gain-preamp" className="text-small">
            Pre-amp
          </label>
          <FieldSelect
            id="replay-gain-preamp"
            value={String(preampDb)}
            fullWidth={false}
            className="w-[140px]"
            disabled={mode === 'off'}
            aria-describedby="replay-gain-preamp-note"
            onChange={(event) => setReplayGainPreamp(parsePreamp(event.target.value))}
          >
            {PREAMP_OPTIONS.map((decibels) => (
              <option key={decibels} value={decibels}>
                {preampLabel(decibels)}
              </option>
            ))}
          </FieldSelect>
          <p id="replay-gain-preamp-note" className="text-tiny">
            Added to the tagged gain. A track is never pushed past its tagged peak, and the player
            cannot go above full volume, so a boost only shows while the volume slider has room.
          </p>
        </div>
      </div>
    </section>
  )
}

export function UserSettingsPage() {
  const themes = useThemes()
  const active = useTheme()
  // `start` is the draft as the edit began, which is what says whether there is anything to lose.
  const [edit, setEdit] = useState<{ draft: Theme; start: Theme } | null>(null)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const heading = useRef<HTMLHeadingElement>(null)
  const room = hasRoomForTheme()
  const dirty = edit !== null && !same(edit.draft, edit.start)

  // Read in the cleanup below, which must not re-run when an edit changes the draft.
  const editing = useRef(false)
  editing.current = edit !== null

  // Walking away mid-edit is a cancel: the saved theme comes back rather than a preview outliving
  // the page that owns it.
  useEffect(
    () => () => {
      if (editing.current) cancelPreview()
    },
    [],
  )

  // The same question the Server page asks, because a sidebar tap would otherwise throw away
  // thirty colors without a word.
  useBlocker({
    condition: dirty,
    blockerFn: () => !window.confirm('Your theme edits are not saved. Leave anyway?'),
  })

  // Every action here unmounts the control that was pressed. Focus goes to the section heading,
  // which is where the result shows up, instead of falling back to the top of the document.
  const settle = (message: string) => {
    setEdit(null)
    setError('')
    setStatus(message)
    requestAnimationFrame(() => heading.current?.focus())
  }

  const startEdit = (theme: Theme, copy: boolean) => {
    const draft = copy ? draftTheme(theme) : { ...theme, colors: { ...theme.colors } }
    setEdit({ draft, start: draft })
    setError('')
    setStatus('')
    previewTheme(draft)
  }

  const change = (draft: Theme) => {
    setEdit((current) => (current ? { ...current, draft } : current))
    previewTheme(draft)
  }

  const save = () => {
    if (!edit) return
    const result = saveAndActivate(edit.draft)
    if (result.ok) settle(`Saved “${result.theme.name}” and turned it on.`)
    else setError(result.message)
  }

  const cancel = () => {
    cancelPreview()
    settle('Edit cancelled. Your saved theme is back.')
  }

  const pick = (theme: Theme) => {
    setActiveTheme(theme.id)
    setError('')
    setStatus(`“${theme.name}” is on.`)
  }

  const remove = (theme: Theme) => {
    if (!window.confirm(`Delete “${theme.name}”? This cannot be undone.`)) return
    deleteTheme(theme.id)
    settle(`Deleted “${theme.name}”.`)
  }

  const load = async (chosen: File) => {
    setStatus('')
    if (chosen.size > MAX_THEME_FILE_BYTES) {
      setError('That file is too big to be a Musimo theme.')

      return
    }
    let text: string
    try {
      text = await chosen.text()
    } catch {
      setError('That file could not be read.')

      return
    }
    const result = importTheme(text)
    if (result.ok) settle(`Imported “${result.theme.name}” and turned it on.`)
    else setError(result.message)
  }

  return (
    <>
      <PageTitle eyebrow="MAKE IT YOURS" title="Your settings" />
      <SettingsSwitch />
      <p className="mb-[24px] max-w-[640px] text-lead">
        These live in this browser, not on the server. Another browser or device starts from the
        default until you bring a theme over.
      </p>
      <section aria-labelledby="appearance" className="grid gap-[20px]">
        <h2
          id="appearance"
          ref={heading}
          tabIndex={-1}
          className="border-b border-line pb-[17px] text-section outline-none"
        >
          Appearance
        </h2>
        {/* Always mounted, so a screen reader hears it fill rather than missing a region that
            arrived already full. */}
        <p role="status" className={cx('text-small text-good', !status && 'sr-only')}>
          {status}
        </p>
        {edit ? (
          <ThemeEditor
            draft={edit.draft}
            onChange={change}
            onSave={save}
            onCancel={cancel}
            error={error}
          />
        ) : (
          <>
            <fieldset className="m-0 grid gap-[14px] border-0 p-0">
              <legend className="mb-[8px] text-small text-muted">
                Pick a theme and it is on straight away. To change one, make a copy of it: built-in
                themes stay as they are.
              </legend>
              <div className="grid gap-[14px] [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))] max-phone:grid-cols-1">
                {themes.map((theme) => (
                  <ThemeCard
                    key={theme.id}
                    theme={theme}
                    active={theme.id === active.id}
                    room={room}
                    onPick={() => pick(theme)}
                    onDuplicate={() => startEdit(theme, true)}
                    onEdit={() => startEdit(theme, false)}
                    onExport={() => download(theme)}
                    onDelete={() => remove(theme)}
                  />
                ))}
              </div>
            </fieldset>
            {!room && (
              <p className="text-small text-warn">
                You have {MAX_CUSTOM_THEMES} themes, the most Musimo keeps. Delete one to make or
                import another.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-[12px]">
              <Button
                disabled={active.id === DEFAULT_THEME_ID}
                onClick={() => {
                  setActiveTheme(DEFAULT_THEME_ID)
                  setError('')
                  setStatus('The default theme is on.')
                }}
              >
                Reset to default
              </Button>
              <p className="text-small">Turns the default back on. Your themes are kept.</p>
            </div>
            <Panel className="grid max-w-[520px] gap-[10px]">
              <h3>Move a theme between browsers</h3>
              <p className="text-small">
                Export, on a theme you made, writes a file you can keep or send. Import reads one
                back in and turns it on.
              </p>
              <label htmlFor="theme-import" className="text-small">
                Import a theme file
              </label>
              <Field
                id="theme-import"
                type="file"
                accept="application/json,.json"
                disabled={!room}
                aria-describedby={error ? 'theme-import-error' : undefined}
                onChange={(event) => {
                  const chosen = event.target.files?.[0]
                  // Clearing the input is what lets the same file be picked twice in a row.
                  event.target.value = ''
                  if (chosen) void load(chosen)
                }}
              />
              {error && (
                <InlineError id="theme-import-error" role="alert">
                  {error}
                </InlineError>
              )}
            </Panel>
          </>
        )}
      </section>
      <div className="mt-[32px]">
        <PlaybackSettings />
      </div>
      <div className="mt-[32px]">
        <VisualizerSettings />
      </div>
    </>
  )
}
