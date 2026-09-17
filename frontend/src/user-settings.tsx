import { useEffect, useId, useRef, useState } from 'react'

import { Link } from '@tanstack/react-router'
import { AlertTriangle, Check, Copy, Download, Pencil, Trash2 } from 'lucide-react'

import { cx } from './cx'
import { PageTitle } from './page-title'
import { MIN_CONTRAST, themeContrast } from './theme/contrast'
import { HEX_COLOR, MAX_THEME_NAME } from './theme/schema'
import {
  cancelPreview,
  deleteTheme,
  draftTheme,
  exportTheme,
  importTheme,
  previewTheme,
  saveTheme,
  setActiveTheme,
  useTheme,
  useThemes,
} from './theme/store'
import { BUILT_IN_THEMES, DEFAULT_THEME, DEFAULT_THEME_ID } from './theme/themes'
import type { Theme } from './theme/themes'
import { COLOR_TOKENS, TOKEN_GROUPS } from './theme/tokens'
import type { ColorToken } from './theme/tokens'
import { Button, Field, FieldSelect, InlineError, Panel } from './ui'

const isBuiltIn = (theme: Theme): boolean => BUILT_IN_THEMES.some((built) => built.id === theme.id)

/** The four colours that tell two themes apart at a glance, in the order the strip shows them. */
const SWATCH_TOKENS: readonly ColorToken[] = [
  '--color-canvas',
  '--color-raised',
  '--color-text',
  '--color-accent',
]

const switchLinkClassName =
  'inline-flex items-center justify-center rounded-pill px-[16px] py-[8px] text-small text-muted coarse:min-h-11'

/**
 * Server settings and personal ones are two pages under one Settings entry, so the switch is what
 * says which of the two you are on. Both halves are routed links, which is also what keeps the
 * Settings page's unsaved-changes blocker in front of a person leaving a dirty draft behind.
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
        activeProps={{ 'className': 'bg-active text-text', 'aria-current': 'page' }}
      >
        Server
      </Link>
      <Link
        to="/settings/user"
        className={switchLinkClassName}
        activeProps={{ 'className': 'bg-active text-text', 'aria-current': 'page' }}
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
  onDuplicate,
  onEdit,
  onExport,
  onDelete,
}: {
  theme: Theme
  active: boolean
  onDuplicate: () => void
  onEdit: () => void
  onExport: () => void
  onDelete: () => void
}) {
  const custom = !isBuiltIn(theme)

  return (
    <div
      className={cx(
        'grid content-start gap-[14px] rounded-lg border bg-raised p-[14px]',
        active ? 'border-accent' : 'border-line',
      )}
    >
      <label className="flex cursor-pointer items-center gap-[12px]">
        <input
          type="radio"
          name="theme"
          value={theme.id}
          checked={active}
          className="h-[18px] w-[18px] shrink-0 accent-accent"
          onChange={() => setActiveTheme(theme.id)}
        />
        <Swatches theme={theme} />
        <span className="min-w-0 flex-1 text-lead [overflow-wrap:anywhere]">{theme.name}</span>
        {/* A tick and the word, so the active card is not marked by its border colour alone. */}
        {active && (
          <span className="inline-flex shrink-0 items-center gap-[4px] text-tiny text-accent">
            <Check size={14} />
            Active
          </span>
        )}
      </label>
      <div className="flex flex-wrap gap-[8px]">
        <Button aria-label={`Duplicate and edit ${theme.name}`} onClick={onDuplicate}>
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

function ContrastReport({ colors }: { colors: Theme['colors'] }) {
  const readings = themeContrast(colors)
  const low = readings.filter((reading) => reading.ratio !== null && reading.ratio < MIN_CONTRAST)

  return (
    <section className="grid gap-[10px]" aria-labelledby="contrast-heading">
      <h3 id="contrast-heading">Readability</h3>
      <dl className="grid gap-[6px]">
        {readings.map((reading) => (
          <div key={reading.label} className="flex flex-wrap justify-between gap-x-[16px]">
            <dt className="text-small text-muted">{reading.label}</dt>
            <dd
              className={cx(
                'text-small tabular-nums',
                reading.ratio !== null && reading.ratio < MIN_CONTRAST ? 'text-warn' : 'text-text',
              )}
            >
              {reading.ratio === null ? 'not a colour yet' : `${reading.ratio.toFixed(1)}:1`}
            </dd>
          </div>
        ))}
      </dl>
      {low.length > 0 && (
        <p className="flex items-start gap-[8px] text-small text-warn" role="status">
          <AlertTriangle size={15} className="mt-[2px] shrink-0" />
          {low.length === 1 ? 'One pair is' : `${low.length} pairs are`} under {MIN_CONTRAST}:1, so
          that text will be hard to read. You can still save this theme.
        </p>
      )}
    </section>
  )
}

function ColorRow({
  label,
  value,
  fallback,
  onChange,
}: {
  label: string
  value: string
  fallback: string
  onChange: (next: string) => void
}) {
  const id = useId()
  const valid = HEX_COLOR.test(value)
  // A native colour input only understands `#rrggbb`, and it cannot show a half-typed hex at all,
  // so it falls back to the value this edit started from rather than to some arbitrary colour.
  const swatch = (valid ? value : fallback).slice(0, 7)

  return (
    <div className="grid gap-[8px] border-b border-line py-[12px]">
      <label htmlFor={id} className="text-small">
        {label}
      </label>
      <div className="flex items-center gap-[10px]">
        <input
          id={id}
          type="color"
          value={swatch}
          className="h-11 w-11 shrink-0 rounded-sm"
          onChange={(event) => onChange(event.target.value)}
        />
        {/* `Field` is full width by default, so the cap is what keeps the pair on one row. */}
        <Field
          aria-label={`${label} hex value`}
          aria-invalid={!valid}
          value={value}
          maxLength={9}
          spellCheck={false}
          autoComplete="off"
          className={cx('max-w-[130px] font-mono', !valid && 'border-danger-line text-danger')}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </div>
  )
}

function ThemeEditor({
  draft,
  base,
  onChange,
  onSave,
  onCancel,
  error,
}: {
  draft: Theme
  base: Theme
  onChange: (next: Theme) => void
  onSave: () => void
  onCancel: () => void
  error: string
}) {
  const invalid =
    draft.name.trim().length === 0 ||
    COLOR_TOKENS.some((token) => !HEX_COLOR.test(draft.colors[token.name]))

  return (
    <form
      className="grid max-w-[720px] gap-[24px]"
      onSubmit={(event) => {
        event.preventDefault()
        onSave()
      }}
    >
      <h3>Editing {draft.name || 'this theme'}</h3>
      <p className="text-small">
        The whole app is the preview. Nothing is kept until you save, and Cancel puts your saved
        theme back.
      </p>
      <div className="flex flex-wrap gap-[16px]">
        <div className="grid flex-1 gap-[6px]">
          <label htmlFor="theme-name" className="text-small">
            Name
          </label>
          <Field
            id="theme-name"
            value={draft.name}
            required
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
            className="w-[150px]"
            onChange={(event) =>
              onChange({ ...draft, scheme: event.target.value === 'light' ? 'light' : 'dark' })
            }
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </FieldSelect>
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
                fallback={base.colors[token.name]}
                onChange={(next) =>
                  onChange({ ...draft, colors: { ...draft.colors, [token.name]: next } })
                }
              />
            ))}
          </div>
        </section>
      ))}
      <ContrastReport colors={draft.colors} />
      {error && <InlineError role="alert">{error}</InlineError>}
      <div className="flex flex-wrap gap-[10px]">
        <Button variant="primary" type="submit" disabled={invalid}>
          Save
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  )
}

/** Hands the theme to the browser as a file. Nothing here leaves this machine. */
function download(theme: Theme) {
  const url = URL.createObjectURL(new Blob([exportTheme(theme)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${theme.name}.musimo-theme.json`
  link.click()
  // Some engines have not started reading the blob when click() returns, so the URL outlives the
  // call by a tick.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function UserSettingsPage() {
  const themes = useThemes()
  const active = useTheme()
  const [draft, setDraft] = useState<Theme | null>(null)
  const [base, setBase] = useState<Theme>(DEFAULT_THEME)
  const [error, setError] = useState('')
  const file = useRef<HTMLInputElement>(null)
  // Read in the effect below, which must not re-run when an edit changes the draft.
  const editing = useRef(false)
  editing.current = draft !== null

  // Walking away mid-edit is a cancel: the saved theme comes back rather than a preview outliving
  // the page that owns it.
  useEffect(
    () => () => {
      if (editing.current) cancelPreview()
    },
    [],
  )

  const startEdit = (theme: Theme, copy: boolean) => {
    const next = copy ? draftTheme(theme) : { ...theme, colors: { ...theme.colors } }
    setBase(theme)
    setDraft(next)
    setError('')
    previewTheme(next)
  }

  const change = (next: Theme) => {
    setDraft(next)
    previewTheme(next)
  }

  const save = () => {
    if (!draft) return
    const result = saveTheme(draft)
    if (!result.ok) {
      setError(result.message)

      return
    }
    setDraft(null)
    setError('')
    setActiveTheme(result.theme.id)
  }

  const cancel = () => {
    setDraft(null)
    setError('')
    cancelPreview()
  }

  const remove = (theme: Theme) => {
    if (!window.confirm(`Delete “${theme.name}”? This cannot be undone.`)) return
    deleteTheme(theme.id)
    setError('')
  }

  const load = async (chosen: File) => {
    const result = importTheme(await chosen.text())
    if (!result.ok) {
      setError(result.message)

      return
    }
    setError('')
    setActiveTheme(result.theme.id)
  }

  return (
    <>
      <PageTitle eyebrow="MAKE IT YOURS" title="Your settings" />
      <SettingsSwitch />
      <p className="page-intro">
        These are yours alone. They live in this browser, not on the server, so another browser or
        another device starts from the default until you bring a theme over.
      </p>
      <section aria-labelledby="appearance" className="grid gap-[20px]">
        <h2 id="appearance" className="border-b border-line pb-[17px] text-section">
          Appearance
        </h2>
        {draft ? (
          <ThemeEditor
            draft={draft}
            base={base}
            onChange={change}
            onSave={save}
            onCancel={cancel}
            error={error}
          />
        ) : (
          <>
            <fieldset className="m-0 grid gap-[14px] border-0 p-0">
              <legend className="mb-[8px] text-small text-muted">
                Pick a theme. It applies and is remembered straight away.
              </legend>
              <div className="grid gap-[14px] [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))] max-phone:grid-cols-1">
                {themes.map((theme) => (
                  <ThemeCard
                    key={theme.id}
                    theme={theme}
                    active={theme.id === active.id}
                    onDuplicate={() => startEdit(theme, true)}
                    onEdit={() => startEdit(theme, false)}
                    onExport={() => download(theme)}
                    onDelete={() => remove(theme)}
                  />
                ))}
              </div>
            </fieldset>
            {error && <InlineError role="alert">{error}</InlineError>}
            <Panel className="grid max-w-[520px] gap-[10px]">
              <h3>Move a theme between browsers</h3>
              <p className="text-small">
                Export writes a JSON file you can keep or send. Import reads one back in and turns
                it on.
              </p>
              <label htmlFor="theme-import" className="text-small">
                Import a theme file
              </label>
              <Field
                id="theme-import"
                ref={file}
                type="file"
                accept="application/json,.json"
                onChange={(event) => {
                  const chosen = event.target.files?.[0]
                  // Clearing the input is what lets the same file be picked twice in a row.
                  event.target.value = ''
                  if (chosen) void load(chosen)
                }}
              />
              <div>
                <Button
                  disabled={active.id === DEFAULT_THEME_ID}
                  onClick={() => {
                    setActiveTheme(DEFAULT_THEME_ID)
                    setError('')
                  }}
                >
                  Reset to default
                </Button>
              </div>
            </Panel>
          </>
        )}
      </section>
    </>
  )
}
