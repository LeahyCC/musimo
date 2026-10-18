import { useEffect, useRef, useState } from 'react'

import { Link, useBlocker } from '@tanstack/react-router'
import { Copy, Upload } from 'lucide-react'

import { PageTitle } from '../../components/page-title'
import { cx } from '../../lib/cx'
import { useLayout } from '../../lib/layout'
import { familyOf } from '../../theme/follow-system'
import { MAX_CUSTOM_THEMES } from '../../theme/schema'
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
  setFollowSystem,
  THEME_FAMILIES,
  themeFileName,
  useFollowSystem,
  useTheme,
  useThemes,
} from '../../theme/store'
import { DEFAULT_THEME_ID } from '../../theme/themes'
import type { ColorScheme, Theme } from '../../theme/themes'
import {
  Button,
  buttonClassName,
  FieldSelect,
  InlineError,
  Switch,
  textLinkClassName,
} from '../../ui'
import { PetSettingsSection } from '../music-bot/pet-settings-section'
import { useNowPlayingPopout } from '../now-playing/now-playing-popout'
import { CROSSFADE_OPTIONS, parseCrossfade } from '../player/crossfade'
import { setCrossfadeSeconds, useCrossfadeSeconds } from '../player/crossfade-settings'
import { parsePreamp, parseReplayGainMode, PREAMP_OPTIONS } from '../player/replay-gain'
import {
  setReplayGainMode,
  setReplayGainPreamp,
  useReplayGainSettings,
} from '../player/replay-gain-settings'
import { PRESET_NAMES, presetLabel } from '../visualizer/visualizer-presets'
import { HomeSectionsSection, LayoutSection } from './appearance-settings'
import { ThemeEditor } from './theme-editor'
import { CustomThemeCard, ThemeFamilyCard } from './theme-picker'

const switchActiveProps = { 'className': 'bg-active text-text', 'aria-current': 'page' } as const
const switchInactiveProps = { className: 'text-muted hover:text-text' } as const

/**
 * Server settings and personal ones are two pages under one Settings entry, so the switch is what
 * says which of the two you are on. Both halves are routed links, which is also what keeps each
 * page's unsaved-changes blocker in front of a person leaving a draft behind. The Listening room
 * names the second half for what is in it.
 */
export function SettingsSwitch() {
  const room = useLayout() === 'room'
  const linkClassName = cx(
    'inline-flex items-center justify-center text-small font-medium coarse:min-h-11',
    room ? 'h-[34px] rounded-[10px] px-[16px] font-semibold' : 'h-[30px] rounded-md px-[14px]',
  )

  return (
    <nav
      aria-label="Settings type"
      className={cx(
        'mb-[24px] flex w-fit gap-[3px] bg-sunken',
        room ? 'rounded-[14px] p-[4px]' : 'rounded-[9px] border border-line p-[3px]',
      )}
    >
      <Link
        to="/settings"
        activeOptions={{ exact: true }}
        className={linkClassName}
        activeProps={switchActiveProps}
        inactiveProps={switchInactiveProps}
      >
        Server
      </Link>
      <Link
        to="/settings/user"
        className={linkClassName}
        activeProps={switchActiveProps}
        inactiveProps={switchInactiveProps}
      >
        {room ? 'Appearance & you' : 'Yours'}
      </Link>
    </nav>
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
  const {
    view,
    setView,
    preset,
    setPreset,
    autoPresets,
    setAutoPresets,
    size: stageSize,
    setSize: setStageSize,
    canVisualize,
  } = useNowPlayingPopout()

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
          The visualizer needs WebGL 2, and this browser cannot provide it, so Now Playing shows the
          artwork.
        </p>
      )}
      {/* Outside the fieldset below: the stage's size applies to the artwork as much as to the
          visualizer, so it stays available where there is no WebGL 2. */}
      <div className="grid max-w-[520px] gap-[6px]">
        <label htmlFor="visualizer-size" className="text-small">
          Stage size
        </label>
        <FieldSelect
          id="visualizer-size"
          value={stageSize}
          fullWidth={false}
          className="w-[200px]"
          aria-describedby="visualizer-size-note"
          onChange={(event) => setStageSize(event.target.value === 'large' ? 'large' : 'small')}
        >
          <option value="small">Small</option>
          <option value="large">Large</option>
        </FieldSelect>
        <p id="visualizer-size-note" className="text-tiny">
          Large stretches the stage across the page and moves the tabs below it. A phone always uses
          Small. On Now Playing, S switches it.
        </p>
      </div>
      <fieldset
        disabled={!canVisualize}
        className="m-0 grid max-w-[520px] gap-[16px] border-0 p-0 disabled:opacity-60"
      >
        <div className="grid gap-[6px]">
          <label htmlFor="visualizer-view" className="text-small">
            Show on Now Playing
          </label>
          <FieldSelect
            id="visualizer-view"
            value={view}
            fullWidth={false}
            className="w-[200px]"
            aria-describedby="visualizer-view-note"
            onChange={(event) =>
              setView(event.target.value === 'artwork' ? 'artwork' : 'visualizer')
            }
          >
            <option value="artwork">Artwork</option>
            <option value="visualizer">Visualizer</option>
          </FieldSelect>
          <p id="visualizer-view-note" className="text-tiny">
            The Visualizer button on the stage changes this same setting.
          </p>
        </div>
        <div className="grid gap-[6px]">
          <label htmlFor="visualizer-preset" className="text-small">
            Preset
          </label>
          <FieldSelect
            id="visualizer-preset"
            title={preset}
            value={preset}
            fullWidth={false}
            className="w-[260px] max-w-full"
            aria-describedby="visualizer-preset-note"
            onChange={(event) => setPreset(event.target.value)}
          >
            {PRESET_NAMES.map((name) => (
              <option key={name} value={name}>
                {presetLabel(name)}
              </option>
            ))}
          </FieldSelect>
          <p id="visualizer-preset-note" className="text-tiny">
            The MilkDrop presets in the butterchurn base pack. On Now Playing, [ and ] walk through
            them.
          </p>
        </div>
        <div className="grid gap-[6px]">
          <label htmlFor="visualizer-auto" className="text-small">
            Change with the music
          </label>
          <FieldSelect
            id="visualizer-auto"
            value={autoPresets ? 'on' : 'off'}
            fullWidth={false}
            className="w-[200px]"
            aria-describedby="visualizer-auto-note"
            onChange={(event) => setAutoPresets(event.target.value === 'on')}
          >
            <option value="on">On</option>
            <option value="off">Off</option>
          </FieldSelect>
          <p id="visualizer-auto-note" className="text-tiny">
            Follows the beat. Early in a song only a big hit changes it, slowly. Later it changes
            every few beats, quicker near the end, and a quiet part gets a calmer picture. The whole
            picture can change about once a second, which flashes; with reduced motion set on this
            device it starts off, and when on it changes at most every 8 seconds, slowly.
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
 * Volume levelling and crossfade for library playback. They read and write the player's own
 * settings stores, so a change lands on a track that is already playing. Every control applies as
 * it is chosen.
 */
function PlaybackSettings() {
  const { mode, preampDb } = useReplayGainSettings()
  const crossfade = useCrossfadeSeconds()

  return (
    <section aria-labelledby="playback" className="grid gap-[20px]">
      <h2 id="playback" className="border-b border-line pb-[17px] text-section">
        Playback
      </h2>
      <p className="max-w-[640px] text-small">
        Some files carry ReplayGain tags that say how loud they are. Musimo can use them to bring
        quiet and loud tracks to a similar volume, and can crossfade one track into the next.
        Changes apply straight away.
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
            Added to the tagged gain. A track is never pushed past its tagged peak, and a track with
            no peak tag is not boosted past full volume.
          </p>
        </div>
        <div className="grid gap-[6px]">
          <label htmlFor="crossfade" className="text-small">
            Crossfade
          </label>
          <FieldSelect
            id="crossfade"
            value={String(crossfade)}
            fullWidth={false}
            className="w-[140px]"
            aria-describedby="crossfade-note"
            onChange={(event) => setCrossfadeSeconds(parseCrossfade(event.target.value))}
          >
            {CROSSFADE_OPTIONS.map((seconds) => (
              <option key={seconds} value={seconds}>
                {seconds === 0 ? 'Off' : `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`}
              </option>
            ))}
          </FieldSelect>
          <p id="crossfade-note" className="text-tiny">
            Fades the end of one track out while the start of the next fades in. Off by default. It
            is skipped between consecutive tracks of the same album, which run on without a gap, and
            for repeat one. If the next track has not loaded in time, it simply follows.
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
  const hasRoom = hasRoomForTheme()
  const following = useFollowSystem()
  // The half each family leans towards when it is not the one on screen, so a card keeps the half
  // it was last given.
  const [modes, setModes] = useState<Record<string, ColorScheme>>({})
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

  const pickFamilyTheme = (theme: Theme, scheme: ColorScheme) => {
    const family = familyOf(theme.id, THEME_FAMILIES)
    if (family) setModes((current) => ({ ...current, [family.id]: scheme }))
    pick(theme)
  }

  const toggleFollowSystem = (on: boolean) => {
    setFollowSystem(on)
    setError('')
    setStatus(on ? 'Following your device.' : 'Following your device is off.')
  }

  const activeFamily = familyOf(active.id, THEME_FAMILIES)
  const custom = themes.filter((theme) => !isBuiltInTheme(theme.id))
  const followNote = !following
    ? ''
    : activeFamily
      ? `Following your device: ${active.scheme} for now.`
      : 'A theme of your own has no other half, so it stays as it is.'

  return (
    <div className="max-w-[900px]">
      <PageTitle eyebrow="MAKE IT YOURS" title="Your settings" />
      <SettingsSwitch />
      <p className="mb-[24px] max-w-[640px] text-lead">
        These live in this browser, not on the server. Another browser or device starts from the
        default until you bring a theme over.
      </p>
      {/* Editing a theme is a mode of its own, with Save and Cancel in a bar that sticks to the
          bottom of the Theme section. Everything under it would let that bar scroll away at the
          end of the page, and everything above it is about other things, so only the editor shows. */}
      <div className="grid gap-[20px]">
        {!edit && <LayoutSection />}
        {!edit && <HomeSectionsSection />}
        <section
          aria-labelledby="theme"
          data-ui="card"
          className="rounded-[16px] border border-line bg-sunken px-[20px] py-[18px] max-phone:px-[14px]"
        >
          <div className="flex flex-wrap items-start justify-between gap-[12px]">
            <div>
              <h2 id="theme" ref={heading} tabIndex={-1} className="text-strong outline-none">
                Theme
              </h2>
              <p className="mt-[4px] text-small text-muted">
                Each theme comes in dark and light. Applies right away. To change one, make a copy
                of it: built-in themes stay as they are.
              </p>
            </div>
            {!edit && (
              <div className="flex flex-wrap gap-[8px]">
                <label
                  className={cx(
                    buttonClassName(),
                    hasRoom ? 'cursor-pointer' : 'cursor-not-allowed opacity-[0.55]',
                    'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-solid',
                  )}
                >
                  <Upload size={14} aria-hidden="true" />
                  Import
                  <input
                    type="file"
                    accept="application/json,.json"
                    aria-label="Import a theme file"
                    aria-describedby={error ? 'theme-import-error' : undefined}
                    className="sr-only"
                    disabled={!hasRoom}
                    onChange={(event) => {
                      const chosen = event.target.files?.[0]
                      // Clearing the input is what lets the same file be picked twice in a row.
                      event.target.value = ''
                      if (chosen) void load(chosen)
                    }}
                  />
                </label>
                <Button
                  aria-label={`Duplicate and edit ${active.name}`}
                  disabled={!hasRoom}
                  onClick={() => startEdit(active, true)}
                >
                  <Copy size={14} aria-hidden="true" />
                  Duplicate and edit
                </Button>
              </div>
            )}
          </div>
          {/* Always mounted, so a screen reader hears it fill rather than missing a region that
              arrived already full. */}
          <p role="status" className={cx('mt-[12px] text-small text-good', !status && 'sr-only')}>
            {status}
          </p>
          {edit ? (
            <div className="mt-[16px] grid gap-[20px]">
              <ThemeEditor
                draft={edit.draft}
                onChange={change}
                onSave={save}
                onCancel={cancel}
                error={error}
              />
            </div>
          ) : (
            <>
              <div className="mt-[14px] flex flex-wrap items-center gap-x-[10px] gap-y-[6px]">
                <label htmlFor="follow-system" className="text-small text-muted">
                  Follow system
                </label>
                <Switch
                  id="follow-system"
                  checked={following}
                  aria-describedby="follow-system-note"
                  onChange={(event) => toggleFollowSystem(event.target.checked)}
                />
                <span id="follow-system-note" className="text-small text-faint">
                  {followNote || 'Light by day, dark by night: your device decides.'}
                </span>
              </div>
              <fieldset className="m-0 mt-[14px] border-0 p-0">
                <legend className="sr-only">Themes</legend>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-[10px] max-phone:grid-cols-1">
                  {THEME_FAMILIES.map((family) => (
                    <ThemeFamilyCard
                      key={family.id}
                      family={family}
                      active={activeFamily === family}
                      mode={
                        activeFamily === family
                          ? active.scheme
                          : (modes[family.id] ?? active.scheme)
                      }
                      following={following}
                      onPick={pickFamilyTheme}
                    />
                  ))}
                  {custom.map((theme) => (
                    <CustomThemeCard
                      key={theme.id}
                      theme={theme}
                      active={theme.id === active.id}
                      onPick={() => pick(theme)}
                      onEdit={() => startEdit(theme, false)}
                      onExport={() => download(theme)}
                      onDelete={() => remove(theme)}
                    />
                  ))}
                </div>
              </fieldset>
              {!hasRoom && (
                <p className="mt-[14px] text-small text-warn">
                  You have {MAX_CUSTOM_THEMES} themes, the most Musimo keeps. Delete one to make or
                  import another.
                </p>
              )}
              {error && (
                <InlineError id="theme-import-error" role="alert" className="mt-[14px]">
                  {error}
                </InlineError>
              )}
              <div className="mt-[14px] flex flex-wrap items-center gap-[12px]">
                <Button
                  disabled={active.id === DEFAULT_THEME_ID && !following}
                  onClick={() => {
                    setFollowSystem(false)
                    setActiveTheme(DEFAULT_THEME_ID)
                    setError('')
                    setStatus('The default theme is on.')
                  }}
                >
                  Reset to default
                </Button>
                <p className="text-small text-muted">
                  Turns the default back on. Your themes are kept. Export, on a theme you made,
                  writes a file you can bring to another browser with Import.
                </p>
              </div>
            </>
          )}
        </section>
      </div>
      {!edit && (
        <>
          <div className="mt-[32px]">
            <PlaybackSettings />
          </div>
          <div className="mt-[32px]">
            <VisualizerSettings />
          </div>
          <div className="mt-[32px]">
            <PetSettingsSection />
          </div>
        </>
      )}
    </div>
  )
}
