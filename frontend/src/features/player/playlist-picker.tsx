import { useState } from 'react'
import type { FormEvent, RefObject } from 'react'

import { Check, ChevronDown, ListMusic, Plus, Search, X } from 'lucide-react'

import type { LibraryPlaylist, LibraryTrack } from '../../api'
import {
  eyebrowClassName,
  overlayDialogClassName,
  plural,
  sheetPaddingClassName,
} from '../../components/review-sheet'
import { cx } from '../../lib/cx'
import { Button, ErrorBanner, Field, IconButton } from '../../ui'

const noteClassName = 'mt-[6px] mb-[2px] px-[8px] text-muted'

const coverSrc = (coverArt?: string) =>
  coverArt ? `/api/player/art/${encodeURIComponent(coverArt)}` : ''

export type PickerRow = {
  playlist: LibraryPlaylist
  /** Undefined until the playlist's songs have loaded; membership cannot be known before that. */
  songs?: LibraryTrack[]
  failed: boolean
  busy: boolean
}

function PlaylistPickerRow({
  row,
  trackId,
  trackTitle,
  blocked,
  expanded,
  onExpand,
  onRetry,
  onToggleTrack,
  onRemoveSong,
}: {
  row: PickerRow
  trackId: string
  trackTitle: string
  blocked: boolean
  expanded: boolean
  onExpand: (open: boolean) => void
  onRetry: () => void
  onToggleTrack: () => void
  onRemoveSong: (index: number) => void
}) {
  const { playlist, songs, failed, busy } = row
  const known = songs !== undefined
  const member = (songs ?? []).some((item) => item.id === trackId)
  const art = coverSrc(playlist.coverArt)
  const label = busy ? 'Saving…' : !known ? 'Loading…' : member ? 'Added' : 'Add'
  return (
    <div className="playlist-picker-row rounded-[10px] px-[8px] py-[8px] hover:bg-hover">
      <div className="flex items-center gap-[12px]">
        {art ? (
          <img src={art} alt="" className="size-[36px] shrink-0 rounded-[7px] object-cover" />
        ) : (
          <span
            aria-hidden="true"
            className="grid size-[36px] shrink-0 place-items-center rounded-[7px] bg-active text-muted"
          >
            <ListMusic size={16} />
          </span>
        )}
        {/* Blocks, not grids: text-overflow only cuts text that sits directly in a block box. */}
        <span className="block min-w-0 flex-1 truncate font-medium">
          {playlist.name}
          <small className="block text-small font-normal text-muted">
            {plural((known ? songs.length : playlist.songCount) ?? 0, 'song')}
          </small>
        </span>
        <IconButton
          size="compact"
          aria-label={`${expanded ? 'Hide' : 'Show'} songs in ${playlist.name}`}
          aria-expanded={expanded}
          onClick={() => onExpand(!expanded)}
        >
          <ChevronDown
            size={16}
            className={cx(
              'transition-transform duration-[140ms] ease-[ease]',
              expanded && 'rotate-180',
            )}
          />
        </IconButton>
        {failed ? (
          <Button className="shrink-0" onClick={onRetry}>
            Retry
          </Button>
        ) : (
          <button
            type="button"
            className={cx(
              'inline-flex h-[30px] min-w-[76px] shrink-0 items-center justify-center gap-[5px] rounded-[8px] border px-[10px] text-small font-medium disabled:opacity-60 coarse:min-h-11 coarse:min-w-[88px]',
              member && known
                ? 'border-good-line bg-good-bg text-accent'
                : 'border-line-strong bg-transparent text-text hover:bg-active',
            )}
            // Membership decides the action, so the label has to wait for the song list. The
            // name starts with the visible word, so voice control can say "click Added".
            aria-label={
              !known
                ? `Loading songs in ${playlist.name}`
                : `${busy ? 'Saving, ' : ''}${
                    member
                      ? `Added, remove ${trackTitle} from ${playlist.name}`
                      : `Add ${trackTitle} to ${playlist.name}`
                  }`
            }
            disabled={busy || blocked || !known}
            onClick={onToggleTrack}
          >
            {member && known && !busy && <Check size={13} aria-hidden="true" />}
            {!member && known && !busy && <Plus size={13} aria-hidden="true" />}
            {label}
          </button>
        )}
      </div>
      {expanded && (
        <div className="playlist-picker-songs mt-[8px] grid max-h-[190px] grid-cols-[minmax(0,1fr)] gap-[4px] overflow-y-auto overscroll-contain border-t border-line pt-[8px]">
          {(songs ?? []).map((song, songIndex) => (
            <div
              key={`${song.id}-${songIndex}`}
              className="flex items-center justify-between gap-[8px] px-[2px] py-[4px] text-small"
            >
              <span className="block min-w-0 truncate">
                {song.title}
                <small className="mt-[5px] block text-tiny text-muted">{song.artist}</small>
              </span>
              <IconButton
                size="compact"
                aria-label={`Remove ${song.title} from ${playlist.name}`}
                disabled={busy}
                onClick={() => onRemoveSong(songIndex)}
              >
                <X size={14} />
              </IconButton>
            </div>
          ))}
          {known && !songs.length && <p className={noteClassName}>This playlist is empty.</p>}
          {failed && <ErrorBanner>That playlist could not be read.</ErrorBanner>}
          {!known && !failed && <p role="status">Loading songs…</p>}
        </div>
      )}
    </div>
  )
}

/**
 * The Add to playlist sheet. It only draws: the player owns what is fetched and what a click
 * does, because the footer's thumbs-up and the Now Playing page share those same writes.
 */
export function PlaylistPicker({
  dialogRef,
  onClose,
  onClosed,
  trackId,
  trackTitle,
  trackArt,
  search,
  onSearch,
  loading,
  loadError,
  rows,
  matching,
  limit,
  blocked,
  expanded,
  onExpand,
  onRetry,
  onToggleTrack,
  onRemoveSong,
  newName,
  onNewName,
  onCreate,
  createBusy,
  changeError,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>
  /** Close from inside the sheet (the X, the backdrop). */
  onClose: () => void
  /** The dialog closed, however that happened, so the player stops fetching for it. */
  onClosed: () => void
  trackId: string
  trackTitle: string
  trackArt?: string
  search: string
  onSearch: (text: string) => void
  loading: boolean
  loadError?: string
  rows: PickerRow[]
  /** How many playlists match the filter, which can be more than `rows` shows. */
  matching: number
  limit: number
  blocked: boolean
  expanded: string
  onExpand: (playlistId: string) => void
  onRetry: (playlistId: string) => void
  onToggleTrack: (playlist: LibraryPlaylist) => void
  onRemoveSong: (playlistId: string, index: number) => void
  newName: string
  onNewName: (name: string) => void
  onCreate: (event: FormEvent<HTMLFormElement>) => void
  createBusy: boolean
  changeError?: string
}) {
  const [creating, setCreating] = useState(false)
  return (
    <dialog
      ref={dialogRef}
      className={overlayDialogClassName('sheet')}
      aria-label="Add track to playlist"
      onClose={() => {
        setCreating(false)
        onClosed()
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose()
      }}
    >
      <header
        className={cx(
          'flex flex-none items-center gap-[12px] pt-[16px] pb-[12px]',
          sheetPaddingClassName,
        )}
      >
        {trackArt ? (
          <img src={trackArt} alt="" className="size-[44px] shrink-0 rounded-[7px] object-cover" />
        ) : (
          <span
            aria-hidden="true"
            className="grid size-[44px] shrink-0 place-items-center rounded-[7px] bg-active text-muted"
          >
            <ListMusic size={18} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className={eyebrowClassName}>Add to playlist</p>
          <h2 className="mt-[3px] truncate text-body font-semibold">{trackTitle}</h2>
        </div>
        <IconButton aria-label="Close playlist picker" onClick={onClose}>
          <X size={20} />
        </IconButton>
      </header>
      <div className={cx('flex-none pb-[10px]', sheetPaddingClassName)}>
        <label className="flex h-[38px] items-center gap-[8px] rounded-[9px] border border-line bg-canvas px-[11px] text-faint coarse:h-11">
          <Search size={15} aria-hidden="true" />
          <input
            className="min-w-0 flex-1 border-0 bg-transparent text-body text-text outline-none placeholder:text-faint coarse:text-base"
            aria-label="Filter playlists"
            value={search}
            placeholder="Filter playlists"
            onChange={(event) => onSearch(event.target.value)}
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-[10px] pb-[8px]">
        {creating ? (
          <form
            className="flex flex-wrap items-end gap-[10px] rounded-[10px] px-[8px] py-[8px]"
            onSubmit={onCreate}
          >
            <label className="grid min-w-[min(220px,100%)] flex-1 gap-[6px] text-small text-muted">
              New playlist
              <Field
                autoFocus
                value={newName}
                placeholder="Create and add this track"
                maxLength={200}
                onChange={(event) => onNewName(event.target.value)}
              />
            </label>
            <Button type="submit" variant="primary" disabled={createBusy || !newName.trim()}>
              {createBusy ? 'Creating…' : 'Create'}
            </Button>
          </form>
        ) : (
          <button
            type="button"
            className="flex w-full items-center gap-[12px] rounded-[10px] border-0 bg-transparent p-[8px] text-left font-semibold text-accent hover:bg-hover coarse:min-h-11"
            onClick={() => setCreating(true)}
          >
            <span
              aria-hidden="true"
              className="grid size-[36px] shrink-0 place-items-center rounded-[7px] border border-dashed border-good-line"
            >
              <Plus size={16} />
            </span>
            New playlist with this song
          </button>
        )}
        {loading && (
          <p role="status" className={noteClassName}>
            Loading playlists…
          </p>
        )}
        {loadError && <ErrorBanner>{loadError}</ErrorBanner>}
        {rows.map((row) => (
          <PlaylistPickerRow
            key={row.playlist.id}
            row={row}
            trackId={trackId}
            trackTitle={trackTitle}
            blocked={blocked}
            expanded={expanded === row.playlist.id}
            onExpand={(open) => onExpand(open ? row.playlist.id : '')}
            onRetry={() => onRetry(row.playlist.id)}
            onToggleTrack={() => onToggleTrack(row.playlist)}
            onRemoveSong={(index) => onRemoveSong(row.playlist.id, index)}
          />
        ))}
        {!loading && !rows.length && <p className={noteClassName}>No playlists yet.</p>}
        {matching > limit && (
          <p className={noteClassName}>
            Showing {limit} of {matching}. Filter above to reach the others.
          </p>
        )}
        {changeError && <ErrorBanner>{changeError}</ErrorBanner>}
      </div>
    </dialog>
  )
}
