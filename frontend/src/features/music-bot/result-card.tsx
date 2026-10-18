import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

import { Link } from '@tanstack/react-router'
import {
  Check,
  Ellipsis,
  ListMusic,
  ListPlus,
  ListRestart,
  ListStart,
  Pin,
  Play,
  Plus,
  Shuffle,
  Undo2,
  X,
} from 'lucide-react'

import type { BotReply } from '../../api'
import { cx } from '../../lib/cx'
import { useTheme } from '../../theme/store'
import { Button, Field } from '../../ui'
import { durationText, usePlayer } from '../player/player'
import { useBotChat } from './bot-chat'
import { appliedText, filterChips, lengthText, loosenChips, shortMinutes } from './bot-replies'
import { MissingPanel, PreviewFacts, ProblemPanel, SavedLine } from './preview-panels'

const SCOPE_LABELS = {
  library: 'WHOLE LIBRARY',
  proposal: 'THIS SELECTION',
  queue: 'UP NEXT',
} as const
/** A card with no stored revision opens on this many songs; Show all lists the rest. */
const FIRST_SONGS = 5

const chipClassName =
  'inline-flex h-[26px] items-center gap-[2px] rounded-pill border border-line-strong bg-hover py-0 pr-[2px] pl-[10px] text-tiny whitespace-nowrap text-text coarse:h-11'

/**
 * A result stays a preview until one of its actions is pressed. Every card says so, says what it
 * is based on, and shows the filters that made it; removing a filter sends a follow-up. A stored
 * revision shows what its songs add up to and about six that stand for a long list, with the
 * whole list one press away. A short one is shown whole. Every action confirms that revision.
 */
export function ResultCard({ reply }: { reply: BotReply }) {
  const chat = useBotChat()
  const win95 = useTheme().skin === 'win95'
  const [showAll, setShowAll] = useState(false)
  const [saving, setSaving] = useState(false)
  const [playlistName, setPlaylistName] = useState('')
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const player = usePlayer()
  const applied = chat.applied && chat.applied.undo !== 'done' ? chat.applied : null
  // The player stops offering Undo once the queue moves on, so the refusal shows straight away
  // rather than after a press that cannot work.
  const refused = applied !== null && (applied.undo === 'refused' || !player.canUndoBotQueue)
  const busy =
    chat.thinking || chat.applying || chat.confirming || chat.holding || chat.locked !== null
  // Taking a song off stores a new preview, so it waits while anything else is in flight and
  // while a confirmation's outcome is unsettled.
  const changing = chat.thinking || chat.applying || chat.confirming || chat.problem !== null
  const chips = filterChips(reply.plan)
  const short = shortMinutes(reply)
  const excluded = reply.plan.exclude_artists
  const { preview, problem } = chat
  // A short stored list is shown whole. A long one opens on the sample the server picked from it.
  // With no stored revision (an empty answer), the card opens on its first few songs as before.
  const sampleIds = preview && !preview.complete ? preview.sampleIds : []
  const sample = reply.tracks.filter((track) => sampleIds.includes(track.id))
  const opening = preview ? (sample.length ? sample : []) : reply.tracks.slice(0, FIRST_SONGS)
  const foldable = opening.length > 0 && opening.length < reply.tracks.length
  const songs = showAll || !foldable ? reply.tracks : opening
  // Another set and Add a song need a library search to draw from; the server refuses them on a
  // refinement of a list, so they are not offered there. Nor on a preview that names songs the
  // library lost, which has to be refreshed first.
  const editable = preview !== null && preview.intent.scope === 'library' && !preview.missing
  const pinned = new Set(chat.pins)
  // A kept song that cannot play is named by the problem on the card, and is the one thing that
  // can still be taken off while that problem shows.
  const freed = problem?.kind === 'unavailable' ? problem.songs : []
  const pinnedHere = reply.tracks.filter((track) => pinned.has(track.id)).length
  const replaceRest = pinnedHere > 0 && pinnedHere < reply.tracks.length

  return (
    <div
      data-bot="card"
      className="relative grid min-w-0 gap-[12px] rounded-[12px] border border-line-strong bg-sunken p-[14px] text-small text-text"
    >
      <div className="flex items-center justify-between gap-[10px] text-micro tracking-[1.2px] text-faint">
        <span className="font-semibold whitespace-nowrap" data-bot="eyebrow">
          {win95
            ? applied
              ? 'In your queue'
              : 'Preview - nothing changed yet'
            : applied
              ? 'IN YOUR QUEUE'
              : 'PREVIEW, NOT APPLIED'}
        </span>
        <span className="whitespace-nowrap">
          {SCOPE_LABELS[reply.plan.scope]}
          {preview && preview.revision > 1 ? ` · REVISION ${preview.revision}` : ''}
        </span>
      </div>
      <p className="m-0 leading-[1.5] text-pretty">{reply.summary}</p>
      {chips.length > 0 && (
        <ul aria-label="Active filters" className="m-0 flex list-none flex-wrap gap-[6px] p-0">
          {chips.map((chip) => (
            <li key={`${chip.label}${chip.value}`} className={chipClassName}>
              {chip.label && <span className="text-muted">{chip.label}</span>}
              <span>{chip.value}</span>
              <button
                type="button"
                aria-label={`Remove filter ${chip.value}`}
                disabled={busy}
                onClick={() => void chat.send(chip.followUp)}
                className="grid size-[22px] place-items-center rounded-pill border-0 bg-transparent p-0 text-muted hover:bg-active hover:text-text disabled:opacity-50 coarse:size-10"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {preview && <MissingPanel preview={preview} />}
      {preview && reply.tracks.length > 0 && (
        <PreviewFacts preview={preview} approvedSeconds={reply.total_seconds} />
      )}
      {short > 0 && reply.tracks.length > 0 && (
        <p
          role="note"
          className="m-0 flex gap-[8px] rounded-[8px] bg-warn-bg px-[11px] py-[9px] leading-[1.45] text-warn"
        >
          <strong className="shrink-0 font-semibold">{short} min short.</strong>
          <span>
            Only {reply.tracks.length} {reply.tracks.length === 1 ? 'song fits' : 'songs fit'} these
            filters. No exclusions were relaxed
            {excluded.length
              ? `, so ${excluded.join(' and ')} ${excluded.length === 1 ? 'stays' : 'stay'} out`
              : ''}
            .
          </span>
        </p>
      )}
      {chat.stale && !applied && (
        <p className="m-0 text-tiny text-muted">
          Restored from earlier. Send a follow-up to check the current queue before applying.
        </p>
      )}

      {reply.tracks.length > 0 ? (
        <>
          {win95 ? (
            <SongTable
              reply={reply}
              songs={songs}
              locked={changing}
              editable={editable}
              pinned={pinned}
              freed={freed}
            />
          ) : (
            <ol aria-label="Proposed songs" className="m-0 grid list-none border-t border-line p-0">
              {songs.map((track) => (
                <li
                  key={track.id}
                  className={cx(
                    'relative grid items-center gap-[10px] border-b border-line py-[7px] pr-0 pl-[2px]',
                    editable
                      ? 'grid-cols-[minmax(0,1fr)_auto_auto_32px] coarse:grid-cols-[minmax(0,1fr)_auto_auto_44px]'
                      : 'grid-cols-[minmax(0,1fr)_auto_32px] coarse:grid-cols-[minmax(0,1fr)_auto_44px]',
                  )}
                >
                  <span className="grid min-w-0 gap-[2px]">
                    <strong className="truncate text-small font-medium">{track.title}</strong>
                    <small className="truncate text-tiny text-muted">{track.artist}</small>
                  </span>
                  {editable && (
                    <PinToggle
                      title={track.title}
                      pinned={pinned.has(track.id)}
                      disabled={changing}
                      onToggle={() => chat.togglePin(track.id)}
                    />
                  )}
                  <time className="text-tiny whitespace-nowrap text-muted tabular-nums">
                    {durationText(track.duration)}
                  </time>
                  <SongMenu
                    title={track.title}
                    open={menuFor === track.id}
                    onOpenChange={(value) => setMenuFor(value ? track.id : null)}
                    reference={chat.reference?.id === track.id}
                    disabled={busy}
                    removeDisabled={changing && !freed.includes(track.id)}
                    onReference={() =>
                      chat.setReference({ id: track.id, label: `${track.title} · ${track.artist}` })
                    }
                    onPlay={() => void chat.apply('play', track.id)}
                    onRemove={() => void chat.removeSong(track.id)}
                  />
                </li>
              ))}
            </ol>
          )}
          <div className="flex items-baseline justify-between gap-[10px] text-tiny text-muted">
            {foldable ? (
              <button
                type="button"
                className="border-0 bg-transparent p-0 text-small whitespace-nowrap text-accent underline-offset-2 hover:underline coarse:min-h-11"
                aria-expanded={showAll}
                onClick={() => setShowAll((value) => !value)}
              >
                {showAll
                  ? preview
                    ? 'Show the sample'
                    : 'Show fewer'
                  : `See all ${reply.tracks.length} songs`}
              </button>
            ) : (
              <span />
            )}
            <span className="whitespace-nowrap tabular-nums">
              Total {lengthText(reply.total_seconds)}
            </span>
          </div>
          {editable && (
            <div data-bot="edits" className="flex flex-wrap gap-[8px]">
              <Button
                disabled={changing}
                title="Pinned songs stay. The rest are drawn again from the same filters."
                onClick={() => void chat.anotherSet()}
              >
                <Shuffle size={14} aria-hidden="true" />
                {replaceRest ? 'Replace the rest' : 'Another set'}
              </Button>
              <Button disabled={changing} onClick={() => void chat.addSong()}>
                <Plus size={14} aria-hidden="true" />
                Add a song
              </Button>
            </div>
          )}
        </>
      ) : preview?.missing ? null : (
        <div className="grid gap-[10px]">
          <p className="m-0 text-small leading-[1.5] text-muted">
            None of your library matches all of these filters.
            {loosenChips(reply.plan).length > 0 && ' Loosen one filter?'}
          </p>
          <div className="flex flex-wrap gap-[8px]">
            {loosenChips(reply.plan).map((chip) => (
              <button
                key={chip.followUp}
                type="button"
                data-ui="button"
                data-variant="default"
                disabled={busy}
                onClick={() => void chat.send(chip.followUp)}
                className="inline-flex min-h-[34px] items-center rounded-pill border border-line-strong bg-hover px-[12px] text-small font-medium whitespace-nowrap text-text first-letter:uppercase disabled:opacity-50 coarse:min-h-11"
              >
                {chip.followUp}
              </button>
            ))}
          </div>
        </div>
      )}

      <ProblemPanel />
      <SavedLine />
      {!applied && !problem && !preview?.missing && reply.tracks.length > 0 && (
        <div className="grid gap-[8px]">
          <div className="flex flex-wrap gap-[8px]">
            <Button variant="primary" disabled={busy} onClick={() => void chat.apply('play')}>
              <Play size={14} aria-hidden="true" />
              Play
            </Button>
            <Button disabled={busy} onClick={() => void chat.apply('next')}>
              <ListStart size={14} aria-hidden="true" />
              Play next
            </Button>
            <Button disabled={busy} onClick={() => void chat.apply('append')}>
              <ListPlus size={14} aria-hidden="true" />
              Add to queue
            </Button>
          </div>
          <div className="flex flex-wrap gap-[8px]">
            <Button
              disabled={busy}
              title="Keeps the song that is playing now"
              onClick={() => void chat.apply('replace')}
            >
              <ListRestart size={14} aria-hidden="true" />
              Replace upcoming
            </Button>
            <Button
              disabled={busy}
              aria-expanded={saving}
              onClick={() => {
                setPlaylistName(
                  (old) => old || defaultPlaylistName(chips.map((chip) => chip.value)),
                )
                setSaving((value) => !value)
              }}
            >
              <ListMusic size={14} aria-hidden="true" />
              {win95 ? 'Save as playlist...' : 'Save as playlist'}
            </Button>
          </div>
          {saving && (
            <form
              className="flex flex-wrap items-end gap-[8px] rounded-[9px] border border-line bg-raised p-[10px]"
              onSubmit={(event) => {
                event.preventDefault()
                void chat.save(playlistName).then((done) => done && setSaving(false))
              }}
            >
              <label className="grid min-w-[160px] flex-1 gap-[6px] text-small text-muted">
                Playlist name
                <Field
                  autoFocus
                  maxLength={200}
                  value={playlistName}
                  onChange={(event) => setPlaylistName(event.target.value)}
                />
              </label>
              <Button type="submit" variant="primary" disabled={busy || !playlistName.trim()}>
                Save
              </Button>
              <Button onClick={() => setSaving(false)}>Cancel</Button>
            </form>
          )}
        </div>
      )}

      {applied && !refused && (
        <div
          role="status"
          className="flex items-center gap-[10px] rounded-[8px] border border-good-line bg-good-bg py-[8px] pr-[8px] pl-[11px] leading-[1.4] text-good"
        >
          <Check size={16} aria-hidden="true" className="shrink-0" />
          <span className="flex-1">
            {appliedText(applied.action, applied.count, player.playing)}
          </span>
          <Button
            className="min-h-[34px] shrink-0 px-[11px] py-0"
            disabled={busy}
            onClick={chat.undo}
          >
            <Undo2 size={14} aria-hidden="true" />
            Undo
          </Button>
        </div>
      )}
      {refused && (
        <div
          role="alert"
          className="grid gap-[8px] rounded-[8px] bg-warn-bg px-[11px] py-[9px] leading-[1.45] text-warn"
        >
          <span>
            <strong className="font-semibold">Can&rsquo;t undo.</strong> The queue changed after my
            edit, so undoing now would throw away your changes. Nothing was undone.
          </span>
          <div className="flex items-center gap-[8px]">
            <Button className="min-h-[34px] px-[11px] py-0" disabled>
              <Undo2 size={14} aria-hidden="true" />
              Undo
            </Button>
            <Link
              to="/now-playing"
              className="text-text underline coarse:min-h-11 coarse:content-center"
            >
              View queue
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}

function defaultPlaylistName(filters: string[]): string {
  const name = filters.slice(0, 3).join(', ')
  return (name || 'Music bot selection').slice(0, 200)
}

/** The Windows 95 list view: a table with column headers, as the skin's design draws it. */
function SongTable({
  reply,
  songs,
  locked,
  editable,
  pinned,
  freed,
}: {
  reply: BotReply
  songs: BotReply['tracks']
  /** Delete takes a song off the list, which waits while something else is in flight. */
  locked: boolean
  /** A library search, whose songs can be pinned for Another set. */
  editable: boolean
  pinned: ReadonlySet<string>
  /** Songs that can still be deleted while a problem holds the rest. */
  freed: readonly string[]
}) {
  const chat = useBotChat()
  const columns = editable
    ? 'grid-cols-[minmax(0,1fr)_110px_46px_52px]'
    : 'grid-cols-[minmax(0,1fr)_110px_46px]'
  return (
    <div role="table" aria-label="Proposed songs" data-bot="list-view" className="grid">
      <div role="row" className={cx('grid', columns)}>
        <span role="columnheader" data-bot="column">
          Title
        </span>
        <span role="columnheader" data-bot="column">
          Artist
        </span>
        <span role="columnheader" data-bot="column">
          Length
        </span>
        {editable && (
          <span role="columnheader" data-bot="column">
            Pin
          </span>
        )}
      </div>
      {songs.map((track) => {
        const picked = chat.reference?.id === track.id
        return (
          <div
            key={track.id}
            role="row"
            aria-selected={picked}
            data-bot="list-row"
            tabIndex={0}
            title="Enter uses this song as the reference. Delete removes it from the list."
            onKeyDown={(event) => {
              if (event.key === 'Enter')
                chat.setReference({ id: track.id, label: `${track.title} · ${track.artist}` })
              if (event.key === 'Delete' && (!locked || freed.includes(track.id)))
                void chat.removeSong(track.id)
            }}
            onClick={() =>
              chat.setReference({ id: track.id, label: `${track.title} · ${track.artist}` })
            }
            className={cx('grid cursor-default', columns)}
          >
            <span role="cell" className="truncate px-[5px] py-[2px]">
              {track.title}
            </span>
            <span role="cell" className="truncate px-[5px] py-[2px]">
              {track.artist}
            </span>
            <span role="cell" className="px-[5px] py-[2px]">
              {durationText(track.duration)}
            </span>
            {editable && (
              <span role="cell" className="px-[5px] py-[2px]">
                <PinToggle
                  title={track.title}
                  pinned={pinned.has(track.id)}
                  disabled={locked}
                  onToggle={() => chat.togglePin(track.id)}
                />
              </span>
            )}
          </div>
        )
      })}
      <span className="sr-only">{reply.tracks.length} songs in all</span>
    </div>
  )
}

/**
 * Keeps a song when the rest of the set is drawn again. The label stays "Pin" and the state is
 * `aria-pressed`, so a screen reader hears one button that is on or off rather than a name that
 * changes under it. Clicks bubble to a Windows 95 row, which would make the song the reference, so
 * they stop here.
 */
function PinToggle({
  title,
  pinned,
  disabled,
  onToggle,
}: {
  title: string
  pinned: boolean
  disabled: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={pinned}
      aria-label={`Pin ${title}`}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation()
        onToggle()
      }}
      className={cx(
        'inline-flex min-h-[32px] items-center gap-[4px] rounded-pill border bg-transparent px-[8px] text-tiny whitespace-nowrap hover:bg-hover disabled:opacity-50 coarse:min-h-11',
        pinned ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-text',
      )}
    >
      <Pin size={13} aria-hidden="true" fill={pinned ? 'currentColor' : 'none'} />
      Pin
    </button>
  )
}

type SongMenuProps = {
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
  reference: boolean
  disabled: boolean
  removeDisabled: boolean
  onReference: () => void
  onPlay: () => void
  onRemove: () => void
}

/** A song's More menu: Use as reference, Play this song, Remove from this list. */
function SongMenu({
  title,
  open,
  onOpenChange,
  reference,
  disabled,
  removeDisabled,
  onReference,
  onPlay,
  onRemove,
}: SongMenuProps) {
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    const close = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && event.target !== button.current)
        onOpenChange(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open, onOpenChange])

  function choose(action: () => void) {
    onOpenChange(false)
    button.current?.focus()
    action()
  }

  function keys(event: KeyboardEvent<HTMLDivElement>) {
    const items = [
      ...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
    ]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onOpenChange(false)
      button.current?.focus()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      items[(at + step + items.length) % items.length]?.focus()
    } else if (event.key === 'Tab') onOpenChange(false)
  }

  const item =
    'rounded-[6px] border-0 bg-transparent px-[12px] py-[9px] text-left text-small whitespace-nowrap text-text hover:bg-hover focus-visible:bg-hover coarse:min-h-11'
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={`More actions for ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => onOpenChange(!open)}
        className="inline-flex min-h-[32px] min-w-[32px] items-center justify-center rounded-[6px] border-0 bg-transparent p-0 text-muted hover:bg-hover hover:text-text coarse:min-h-11 coarse:min-w-11"
      >
        <Ellipsis size={17} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label={`More actions for ${title}`}
          onKeyDown={keys}
          className="absolute top-[calc(100%-2px)] right-0 z-overlay grid min-w-[190px] gap-[2px] rounded-[8px] border border-line bg-raised p-[4px] shadow-[0_14px_36px_color-mix(in_oklab,var(--color-shadow)_53%,transparent)]"
        >
          <button
            type="button"
            role="menuitem"
            className={cx(item, reference && 'text-accent')}
            onClick={() => choose(onReference)}
          >
            {reference ? 'Reference song' : 'Use as reference'}
          </button>
          <button
            type="button"
            role="menuitem"
            className={item}
            disabled={disabled}
            onClick={() => choose(onPlay)}
          >
            Play this song
          </button>
          <button
            type="button"
            role="menuitem"
            className={item}
            disabled={removeDisabled}
            onClick={() => choose(onRemove)}
          >
            Remove from this list
          </button>
        </div>
      )}
    </>
  )
}
