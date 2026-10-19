import type { ReactNode } from 'react'

import { Link, useNavigate } from '@tanstack/react-router'
import {
  ListPlus,
  Pause,
  Play,
  Repeat,
  Shuffle,
  SkipBack,
  SkipForward,
  Sparkles,
  ThumbsUp,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'

import type { LibraryTrack } from '../../api'
import { cx } from '../../lib/cx'
import { IconButton } from '../../ui'
import { useBotChat } from '../music-bot/bot-chat'
import { PetSpot } from '../music-bot/pet-host'
import { sourceName } from '../player/account-play'
import { durationText, isPassiveNotice, usePlayer } from '../player/player'
import { TrackFormatChips } from './about-track'
import { SleepTimerControl } from './sleep-timer-control'
import { SeekBar } from './waveform-seek'

/* Under the stage on Now Playing: what is playing, and every control the footer player has. The
   footer stands down on this page, so this is the only place they are, and it stays on screen while
   the stage is popped out. Full screen and the popout have their own copy over the picture.

   Classic and the Listening room lay the same controls out differently; the pieces below are shared
   so both stay in step with the footer. */

/** The artist and the album as links, where the library sent an id for them. */
function TrackLinks({ track, separator }: { track: LibraryTrack; separator: string }) {
  return (
    <>
      {track.artistId ? (
        <Link
          className="hover:underline"
          to="/library/artists/$artistId"
          params={{ artistId: track.artistId }}
        >
          {track.artist}
        </Link>
      ) : (
        track.artist
      )}
      {track.album && (
        <>
          <span className="text-faint">{separator}</span>
          {track.albumId ? (
            <Link
              className="hover:underline"
              to="/library/albums/$albumId"
              params={{ albumId: track.albumId }}
            >
              {track.album}
            </Link>
          ) : (
            track.album
          )}
        </>
      )}
    </>
  )
}

/** The one place the title is drawn while the stage is docked. Two lines, then an ellipsis; the
    whole of it is in the tooltip. */
function Title({ track, className }: { track: LibraryTrack; className: string }) {
  return (
    <h1 className={cx('line-clamp-2 [overflow-wrap:anywhere]', className)} title={track.title}>
      {track.title}
    </h1>
  )
}

type RoundButtonProps = {
  label: string
  onClick: () => void
  disabled?: boolean
  className: string
  children: ReactNode
}

function SquareButton({ label, onClick, disabled, className, children }: RoundButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      className={cx(
        'grid shrink-0 place-items-center border-0 p-0 disabled:opacity-50 coarse:min-h-11 coarse:min-w-11',
        className,
      )}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function useLikeButton(track: LibraryTrack) {
  const { liked } = usePlayer()
  return {
    // The label already says which way the press goes, so there is no pressed state on top of it.
    label: liked.isLiked ? `Remove ${track.title} from liked` : `Add ${track.title} to liked`,
    onClick: liked.toggle,
    disabled: !liked.canToggle || liked.busy,
    on: liked.isLiked,
  }
}

/**
 * Opens Octive with this track as the reference for "more like this". It only fills in the
 * reference; asking is left to the person, since a request runs the model.
 */
function useMoreLikeThis(track: LibraryTrack) {
  const chat = useBotChat()
  const navigate = useNavigate()
  return () => {
    chat.setReference({ id: track.id, label: `${track.title} · ${track.artist}` })
    void navigate({ to: '/music-bot' })
  }
}

/** The seek bar between the two times. */
function Seek({
  track,
  tone,
  timeClassName,
}: {
  track: LibraryTrack
  tone: 'classic' | 'room'
  timeClassName: string
}) {
  const player = usePlayer()
  return (
    <div className="flex items-center gap-[10px] tabular-nums">
      <span className={cx('w-[34px] shrink-0', timeClassName)}>
        {durationText(player.position)}
      </span>
      <SeekBar
        trackId={track.id}
        position={player.position}
        length={player.length || 30}
        ready={player.ready}
        onSeek={player.seek}
        tone={tone}
        className={tone === 'room' ? 'h-[40px]' : 'h-[36px]'}
      />
      <span className={cx('w-[34px] shrink-0 text-right', timeClassName)}>
        {durationText(player.length)}
      </span>
    </div>
  )
}

/** Mute, the volume slider and close. A phone leaves the slider to the device's own buttons, as
    the footer's mini player does. Close empties the player, as the footer's does. */
function VolumeAndClose() {
  const player = usePlayer()
  return (
    <div className="flex items-center gap-[4px]">
      <IconButton
        size="compact"
        aria-label={player.muted ? 'Unmute' : 'Mute'}
        onClick={player.toggleMute}
      >
        {player.muted || player.volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
      </IconButton>
      <input
        className="w-[96px] accent-accent max-phone:hidden"
        type="range"
        aria-label="Volume"
        min="0"
        max="1"
        step="0.01"
        value={player.muted ? 0 : player.volume}
        onChange={(event) => player.setVolume(Number(event.target.value))}
      />
      <IconButton size="compact" aria-label="Close player" onClick={player.stop}>
        <X size={16} />
      </IconButton>
    </div>
  )
}

/** Errors and confirmations only. Empty, it leaves the flow, so the column keeps its room for the
    stage. The element stays so the message is announced when it arrives. */
function Notice() {
  const player = usePlayer()
  // The footer says where the sound comes from and that the queue was restored. This page says
  // both already, in its title, its Playing from line and its play button.
  const notice = isPassiveNotice(player.notice) ? '' : player.notice
  return (
    <p className="text-small text-muted empty:sr-only" role="status">
      {notice}
    </p>
  )
}

/** Shuffle, previous, play or pause, next and repeat. `play` is the class of the big disc. */
function Transport({
  className,
  play,
  side,
  skip,
}: {
  className: string
  play: string
  side: string
  skip: string
}) {
  const player = usePlayer()
  return (
    <div className={className}>
      <SquareButton
        label="Shuffle"
        className={cx(side, player.shuffle ? 'text-accent' : 'text-muted')}
        onClick={player.toggleShuffle}
      >
        <Shuffle size={18} />
      </SquareButton>
      <div className="flex items-center gap-[14px]">
        <SquareButton label="Previous track" className={skip} onClick={player.previous}>
          <SkipBack size={22} fill="currentColor" />
        </SquareButton>
        <SquareButton
          label={player.playing ? 'Pause' : 'Play'}
          className={play}
          onClick={player.toggle}
        >
          {player.playing ? (
            <Pause size={24} fill="currentColor" />
          ) : (
            <Play size={24} fill="currentColor" />
          )}
        </SquareButton>
        <SquareButton label="Next track" className={skip} onClick={player.next}>
          <SkipForward size={22} fill="currentColor" />
        </SquareButton>
      </div>
      <SquareButton
        label={`Repeat ${player.repeat}`}
        className={cx(side, 'relative', player.repeat !== 'off' ? 'text-accent' : 'text-muted')}
        onClick={player.cycleRepeat}
      >
        <Repeat size={18} />
        {player.repeat === 'one' && (
          <small className="absolute right-[6px] bottom-[6px] text-micro">1</small>
        )}
      </SquareButton>
    </div>
  )
}

/**
 * Classic: the title, the artist and album as links, the format chips, like and Add to playlist
 * at the right, the waveform, the transport with shuffle and repeat at its ends, and a row with the
 * sleep timer, More like this, volume and close.
 */
export function ClassicControls({ track }: { track: LibraryTrack }) {
  const player = usePlayer()
  const like = useLikeButton(track)
  const moreLikeThis = useMoreLikeThis(track)
  const softButton = 'size-[40px] rounded-[10px] bg-hover hover:bg-active'
  const quietButton =
    'inline-flex h-[32px] items-center gap-[6px] rounded-[8px] border-0 bg-transparent px-[10px] text-small text-muted hover:bg-hover hover:text-text coarse:min-h-11'
  return (
    <div className="grid w-full max-w-[520px] shrink-0 gap-[16px]">
      <div className="flex items-start gap-[12px]">
        <div className="grid min-w-0 flex-1 gap-[6px]">
          <Title
            track={track}
            className="text-display leading-[1.15] font-semibold tracking-[-0.6px]"
          />
          <p className="line-clamp-2 text-lead [overflow-wrap:anywhere]">
            <TrackLinks track={track} separator=" · " />
          </p>
          <p className="text-tiny text-muted">{sourceName(track, null)}</p>
          <div className="mt-[4px]">
            <TrackFormatChips track={track} />
          </div>
        </div>
        {/* The footer, and the pet on it, stand down on this page, so the pet sits here. */}
        <PetSpot />
        <SquareButton
          label={like.label}
          disabled={like.disabled}
          className={cx(softButton, like.on ? 'text-accent' : 'text-text')}
          onClick={like.onClick}
        >
          <ThumbsUp size={18} fill={like.on ? 'currentColor' : 'none'} />
        </SquareButton>
        <SquareButton
          label="Add to playlist"
          className={cx(softButton, 'text-text')}
          onClick={player.openPlaylistPicker}
        >
          <ListPlus size={18} />
        </SquareButton>
      </div>
      <Seek track={track} tone="classic" timeClassName="text-tiny text-muted" />
      <Transport
        className="flex items-center justify-between"
        side="size-[40px] rounded-[10px] bg-transparent hover:bg-hover"
        skip="size-[44px] rounded-[10px] bg-transparent text-text hover:bg-hover"
        play="size-[60px] rounded-pill bg-accent text-accent-ink"
      />
      <div className="flex flex-wrap items-center gap-[6px] text-muted">
        <SleepTimerControl labelled />
        <button type="button" className={quietButton} onClick={moreLikeThis}>
          <Sparkles size={15} /> More like this
        </button>
        <div className="flex-1" />
        <VolumeAndClose />
      </div>
      <Notice />
    </div>
  )
}

/**
 * The Listening room: a large title with the artist and album under it, the chips and round like,
 * Add to playlist and More like this at the right, a wide waveform, and the transport centred with a
 * big play disc. The sleep timer sits to its left and volume and close to its right, which the
 * prototype has no place for; on a phone they drop to a row of their own under it.
 */
export function RoomControls({ track }: { track: LibraryTrack }) {
  const player = usePlayer()
  const like = useLikeButton(track)
  const moreLikeThis = useMoreLikeThis(track)
  const round = 'size-[38px] rounded-pill bg-text/10 hover:bg-text/15'
  return (
    <div className="grid gap-[16px]">
      <div className="flex flex-wrap items-end gap-x-[20px] gap-y-[12px]">
        <div className="grid min-w-0 flex-[1_1_260px] gap-[6px]">
          <Title
            track={track}
            className="text-[clamp(22px,3.4cqi,34px)] leading-[1.1] font-semibold tracking-[-1px]"
          />
          <p className="line-clamp-2 text-strong text-muted [overflow-wrap:anywhere]">
            <TrackLinks track={track} separator=" — " />
          </p>
          <p className="text-tiny text-muted">{sourceName(track, null)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-[6px]">
          <TrackFormatChips track={track} tone="room" />
          <PetSpot />
          <SquareButton
            label={like.label}
            disabled={like.disabled}
            className={cx(round, like.on ? 'text-accent' : 'text-text')}
            onClick={like.onClick}
          >
            <ThumbsUp size={16} fill={like.on ? 'currentColor' : 'none'} />
          </SquareButton>
          <SquareButton
            label="Add to playlist"
            className={cx(round, 'text-text')}
            onClick={player.openPlaylistPicker}
          >
            <ListPlus size={16} />
          </SquareButton>
          <SquareButton
            label="More like this"
            className={cx(round, 'text-text')}
            onClick={moreLikeThis}
          >
            <Sparkles size={16} />
          </SquareButton>
        </div>
      </div>
      <Seek track={track} tone="room" timeClassName="font-mono text-tiny text-muted" />
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-[12px] max-phone:grid-cols-[1fr_auto]">
        <div className="text-muted max-phone:order-2">
          <SleepTimerControl />
        </div>
        <Transport
          className="flex items-center gap-[16px] max-phone:order-1 max-phone:col-span-2 max-phone:justify-center"
          side="size-[42px] rounded-pill bg-transparent hover:bg-text/10"
          skip="size-[46px] rounded-pill bg-transparent text-text hover:bg-text/10"
          // A disc in the text color with the canvas color on it: the prototype's white disc in a
          // dark theme, and a dark one in a light theme, where white would vanish into the card.
          play="size-[64px] rounded-pill bg-text text-canvas"
        />
        <div className="justify-self-end max-phone:order-3">
          <VolumeAndClose />
        </div>
      </div>
      <Notice />
    </div>
  )
}
