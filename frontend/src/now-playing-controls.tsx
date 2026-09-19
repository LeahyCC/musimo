import { Link } from '@tanstack/react-router'
import {
  Moon,
  Pause,
  Play,
  Plus,
  Repeat,
  Shuffle,
  SkipBack,
  SkipForward,
  ThumbsUp,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'

import { TrackFormatLine } from './about-track'
import type { LibraryTrack } from './api'
import { durationText, isPassiveNotice, usePlayer } from './player'
import { parseSleepChoice, SLEEP_MINUTES, sleepChoiceValue } from './sleep-timer'
import { Button, FieldSelect, IconButton } from './ui'

// A native select keeps this reachable by keyboard, screen reader and phone picker with no menu
// code. Picking Off cancels; the cancel button beside a running timer does the same in one press.
function SleepTimerControl() {
  const { sleep, setSleep, shuffle, repeat } = usePlayer()
  // Shuffle and repeat never come to the last track, so the timer that waits for it is not offered.
  const noQueueEnd = shuffle || repeat !== 'off'
  return (
    <div className="flex items-center gap-[4px]">
      <Moon size={16} aria-hidden="true" className="shrink-0" />
      <FieldSelect
        tone="sunken"
        fullWidth={false}
        className="max-w-[210px] coarse:min-h-11"
        aria-label="Sleep timer"
        value={sleep ? sleepChoiceValue(sleep.choice) : 'off'}
        onChange={(event) => setSleep(parseSleepChoice(event.target.value))}
      >
        <option value="off">Sleep timer off</option>
        <option value="track">End of track</option>
        <option value="queue" disabled={noQueueEnd}>
          {noQueueEnd
            ? 'End of album or queue (not with shuffle or repeat)'
            : 'End of album or queue'}
        </option>
        {SLEEP_MINUTES.map((minutes) => (
          <option key={minutes} value={minutes}>
            {minutes} minutes
          </option>
        ))}
      </FieldSelect>
      {sleep && (
        <>
          <span className="text-tiny tabular-nums">{durationText(sleep.remaining)} left</span>
          <IconButton size="compact" aria-label="Cancel sleep timer" onClick={() => setSleep(null)}>
            <X size={14} />
          </IconButton>
        </>
      )}
    </div>
  )
}

// Under the stage on Now Playing: what is playing, and every control the footer player has. The
// footer stands down on this page, so this is the only place they are, and it stays on screen
// while the stage is popped out. Full screen and the popout have their own copy over the picture.
export function NowPlayingControls({ track }: { track: LibraryTrack }) {
  const player = usePlayer()
  const length = player.length || 30
  // The footer says where the sound comes from and that the queue was restored. This page says
  // both already, in its title, its Playing from line and its play button.
  const notice = isPassiveNotice(player.notice) ? '' : player.notice
  return (
    <div className="grid shrink-0 gap-[12px]">
      <div className="flex flex-wrap items-start justify-between gap-x-[16px] gap-y-[10px]">
        <div className="min-w-0 flex-[1_1_220px]">
          {/* The one place the title is drawn while the stage is docked. Two lines, then an
              ellipsis; the whole of it is in the tooltip. */}
          <h1
            className="line-clamp-2 text-subtitle leading-[1.2] [overflow-wrap:anywhere]"
            title={track.title}
          >
            {track.title}
          </h1>
          <p className="mt-[4px] line-clamp-2 [overflow-wrap:anywhere]">
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
                {' · '}
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
          </p>
          <TrackFormatLine trackId={track.id} />
        </div>
        <div className="flex shrink-0 items-center gap-[8px]">
          <IconButton
            active={player.liked.isLiked}
            // The label already says which way the press goes, so a pressed state on top of it
            // would be read out twice.
            aria-pressed={undefined}
            aria-label={
              player.liked.isLiked
                ? `Remove ${track.title} from liked`
                : `Add ${track.title} to liked`
            }
            disabled={!player.liked.canToggle || player.liked.busy}
            size="compact"
            onClick={player.liked.toggle}
          >
            <ThumbsUp size={16} fill={player.liked.isLiked ? 'currentColor' : 'none'} />
          </IconButton>
          <Button onClick={player.openPlaylistPicker}>
            <Plus size={16} /> Add to playlist
          </Button>
        </div>
      </div>
      <div className="flex items-center gap-[10px] text-tiny text-muted tabular-nums">
        <span>{durationText(player.position)}</span>
        <input
          className="min-w-0 flex-1 accent-accent"
          aria-label="Playback position"
          type="range"
          min="0"
          max={length}
          step="0.1"
          value={Math.min(player.position, length)}
          disabled={!player.ready}
          onChange={(event) => player.seek(Number(event.target.value))}
        />
        <span>{durationText(player.length)}</span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-[12px] gap-y-[8px]">
        <div className="flex items-center gap-[4px]">
          <IconButton
            active={player.shuffle}
            size="compact"
            aria-label="Shuffle"
            onClick={player.toggleShuffle}
          >
            <Shuffle size={17} />
          </IconButton>
          <IconButton size="compact" aria-label="Previous track" onClick={player.previous}>
            <SkipBack size={17} />
          </IconButton>
          <IconButton
            variant="play"
            aria-label={player.playing ? 'Pause' : 'Play'}
            onClick={player.toggle}
          >
            {player.playing ? <Pause size={19} /> : <Play size={19} />}
          </IconButton>
          <IconButton size="compact" aria-label="Next track" onClick={player.next}>
            <SkipForward size={17} />
          </IconButton>
          <IconButton
            active={player.repeat !== 'off'}
            size="compact"
            aria-label={`Repeat ${player.repeat}`}
            onClick={player.cycleRepeat}
          >
            <Repeat size={17} />
            {player.repeat === 'one' && <small className="-ml-[4px] text-micro">1</small>}
          </IconButton>
        </div>
        <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[4px]">
          <SleepTimerControl />
          <div className="flex items-center gap-[4px]">
            <IconButton
              size="compact"
              aria-label={player.muted ? 'Unmute' : 'Mute'}
              onClick={player.toggleMute}
            >
              {player.muted || player.volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </IconButton>
            {/* A phone leaves the volume to the device's own buttons, as the footer's mini player does. */}
            <input
              className="w-[80px] accent-accent max-phone:hidden"
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
        </div>
      </div>
      {/* Errors and confirmations only. Empty, it leaves the flow, so the column keeps its room
          for the stage. The element stays so the message is announced when it arrives. */}
      <p className="text-small text-muted empty:sr-only" role="status">
        {notice}
      </p>
    </div>
  )
}
