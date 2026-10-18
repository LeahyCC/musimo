import { Link } from '@tanstack/react-router'
import { ArrowRight, ArrowUp, Heart, Pause, Play, SkipForward } from 'lucide-react'

import { cx } from '../../lib/cx'
import { formatDuration } from '../../lib/format'
import type { HomeSections } from '../../lib/layout'
import { StatTile } from '../../ui'
import { PetFace } from '../music-bot/pet-host'
import { historyTrack } from '../player/play-history'
import { usePlayer } from '../player/player'
import { Cover, OCTIVE_PROMPTS, useAskOctive, useContinue, useNow } from './home-parts'
import { listeningTime, mostPlayedThisMonth, weekStats } from './listening-stats'
import { useFreshAlbums, usePlaylists } from './use-home-data'

const monoClassName = 'font-mono'
const cardClassName = 'min-w-0 rounded-[18px] bg-raised p-[18px]'

function Continue() {
  const current = useContinue()
  if (!current) return null
  const { track } = current
  const progress = current.length > 0 ? Math.min(100, (current.position / current.length) * 100) : 0
  return (
    <section
      aria-labelledby="home-continue"
      className="relative flex min-w-0 flex-[3_1_440px] flex-wrap gap-[22px] overflow-hidden rounded-[18px] bg-[radial-gradient(120%_140%_at_0%_0%,color-mix(in_oklab,var(--color-accent)_18%,var(--color-raised))_0%,var(--color-raised)_60%)] p-[20px]"
    >
      <Cover
        coverArt={track.coverArt}
        className="aspect-square w-[clamp(120px,22cqi,200px)] self-start rounded-[12px] shadow-[0_20px_40px_-16px_color-mix(in_oklab,var(--color-shadow)_70%,transparent)] max-phone:w-[120px]"
        iconSize={48}
      />
      <div className="flex min-w-0 flex-[1_1_220px] flex-col">
        <h2
          id="home-continue"
          className={cx(monoClassName, 'm-0 text-tiny tracking-[0.6px] text-accent')}
        >
          {current.live ? (current.playing ? '● PLAYING' : '● PAUSED') : '● LAST PLAYED'}
          {current.queueNumber !== null && ` · TRACK ${current.queueNumber} / ${current.queueSize}`}
        </h2>
        <div className="mt-[12px] truncate text-[28px] leading-[1.1] font-semibold tracking-[-0.8px]">
          {track.title}
        </div>
        <div className="mt-[6px] truncate text-lead text-muted">
          {track.artist}
          {track.album && ` — ${track.album}`}
        </div>
        <div className="min-h-[18px] flex-1" />
        <div className="flex items-center gap-[10px]">
          <button
            type="button"
            aria-label={current.playing ? 'Pause' : current.live ? 'Resume' : 'Play again'}
            onClick={current.press}
            className="grid size-[48px] place-items-center rounded-full bg-text text-canvas coarse:size-12"
          >
            {current.playing ? (
              <Pause size={20} fill="currentColor" />
            ) : (
              <Play size={20} fill="currentColor" />
            )}
          </button>
          {current.live && (
            <>
              <button
                type="button"
                aria-label="Next"
                onClick={current.next}
                className="grid size-[40px] place-items-center rounded-full bg-text/8 text-text coarse:size-11"
              >
                <SkipForward size={17} fill="currentColor" />
              </button>
              <div
                role="progressbar"
                aria-label="Track progress"
                aria-valuemin={0}
                aria-valuemax={Math.round(current.length)}
                aria-valuenow={Math.round(current.position)}
                className="ml-[8px] h-[3px] min-w-[60px] flex-1 rounded-[3px] bg-text/15"
              >
                <div className="h-full rounded-[3px] bg-text" style={{ width: `${progress}%` }} />
              </div>
              <span className={cx(monoClassName, 'text-tiny text-muted')}>
                {formatDuration(current.position)} / {formatDuration(current.length)}
              </span>
            </>
          )}
        </div>
        {current.live && (
          <Link
            to="/now-playing"
            className="mt-[12px] self-start text-small text-muted hover:text-text"
          >
            Open Now Playing
          </Link>
        )}
      </div>
    </section>
  )
}

function Stats() {
  const { history } = usePlayer()
  const now = useNow()
  if (!history.length) return null
  const week = weekStats(history, now)
  return (
    <section
      aria-label="This week"
      className="grid min-w-0 flex-[2_1_300px] grid-cols-2 gap-[12px]"
    >
      <StatTile
        label={week.clipped ? 'SONGS · LATEST 200' : 'SONGS PLAYED'}
        value={week.songs.toLocaleString()}
        delta="last 7 days"
      />
      <StatTile label="LISTENING TIME" value={listeningTime(week.seconds)} delta="last 7 days" />
      <StatTile label="ARTISTS" value={week.artists.toLocaleString()} delta="last 7 days" />
      <StatTile label="ALBUMS" value={week.albums.toLocaleString()} delta="last 7 days" />
    </section>
  )
}

function Fresh() {
  const fresh = useFreshAlbums()
  const albums = fresh.data?.items ?? []
  if (!albums.length) return null
  return (
    <section aria-labelledby="home-fresh" className="mb-[28px]">
      <div className="mb-[12px] flex items-baseline gap-[10px]">
        <h2 id="home-fresh" className="m-0 text-section font-semibold tracking-[-0.2px]">
          New in your library
        </h2>
        <div className="flex-1" />
        <Link
          to="/library/albums"
          className="inline-flex items-center gap-[4px] text-small text-muted hover:text-text"
        >
          All albums
          <ArrowRight size={13} />
        </Link>
      </div>
      <ul className="m-0 grid list-none auto-cols-[minmax(150px,180px)] grid-flow-col gap-[14px] overflow-x-auto p-0 pb-[4px] [scrollbar-width:none]">
        {albums.map((album) => (
          <li key={album.id} className="min-w-0">
            <Link
              to="/library/albums/$albumId"
              params={{ albumId: album.id }}
              className="block text-text hover:text-accent"
            >
              <span className="relative block">
                <Cover
                  coverArt={album.coverArt}
                  className="aspect-square w-full rounded-[12px]"
                  iconSize={32}
                />
                {album.year !== undefined && (
                  <span
                    className={cx(
                      monoClassName,
                      'absolute top-[8px] left-[8px] rounded-[5px] bg-sidebar/75 px-[6px] py-[2px] text-caption text-text',
                    )}
                  >
                    {album.year}
                  </span>
                )}
              </span>
              <strong className="mt-[9px] block truncate">{album.name}</strong>
              <span className="mt-[2px] block truncate text-small text-muted">{album.artist}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

function MostPlayed() {
  const { history, playLibrary } = usePlayer()
  const now = useNow()
  const songs = mostPlayedThisMonth(history, now, 5)
  if (!songs.length) return null
  const top = songs[0]?.plays ?? 1
  const month = new Date(now).toLocaleDateString(undefined, { month: 'long' })
  return (
    <section aria-labelledby="home-repeat" className={cx(cardClassName, 'flex-[1_1_320px]')}>
      <div className="mb-[12px] flex items-baseline justify-between">
        <h2 id="home-repeat" className="m-0 text-strong font-semibold">
          Most played · {month}
        </h2>
        <span className={cx(monoClassName, 'text-tiny text-faint')}>PLAYS</span>
      </div>
      <ol className="m-0 list-none p-0">
        {songs.map(({ entry, plays }, index) => (
          <li key={entry.id}>
            <button
              type="button"
              aria-label={`Play ${entry.title} by ${entry.artist}`}
              onClick={() => playLibrary([historyTrack(entry)])}
              className="grid w-full grid-cols-[20px_36px_minmax(0,1fr)_70px_28px] items-center gap-[10px] rounded-[8px] py-[6px] text-left hover:bg-hover max-phone:grid-cols-[20px_36px_minmax(0,1fr)_28px]"
            >
              <span className={cx(monoClassName, 'text-tiny text-faint')}>{index + 1}</span>
              <Cover
                coverArt={entry.coverArt}
                className="size-[36px] rounded-[6px]"
                iconSize={16}
              />
              <span className="min-w-0">
                <span className="block truncate font-medium">{entry.title}</span>
                <span className="block truncate text-small text-muted">{entry.artist}</span>
              </span>
              <span className="h-[4px] rounded-[4px] bg-line max-phone:hidden" aria-hidden="true">
                <span
                  className="block h-full rounded-[4px] bg-accent"
                  style={{ width: `${(plays / top) * 100}%` }}
                />
              </span>
              <span className={cx(monoClassName, 'text-right text-tiny text-muted')}>{plays}</span>
            </button>
          </li>
        ))}
      </ol>
      <p className="mt-[8px] mb-0 text-caption text-faint">
        Counted from what was played in this browser.
      </p>
    </section>
  )
}

function Playlists() {
  const playlists = usePlaylists()
  const likedId = playlists.data?.liked_id ?? ''
  const items = (playlists.data?.items ?? []).slice(0, 4)
  if (!items.length) return null
  return (
    <section aria-labelledby="home-jump" className={cx(cardClassName, 'flex-[1_1_280px]')}>
      <h2 id="home-jump" className="m-0 mb-[12px] text-strong font-semibold">
        Playlists
      </h2>
      <ul className="m-0 grid list-none grid-cols-2 gap-[10px] p-0 max-phone:grid-cols-1">
        {items.map((playlist) => (
          <li key={playlist.id} className="min-w-0">
            <Link
              to="/library/playlists/$playlistId"
              params={{ playlistId: playlist.id }}
              className="flex min-w-0 items-center gap-[10px] rounded-[12px] bg-hover p-[6px] text-text hover:bg-active"
            >
              {playlist.id === likedId ? (
                <span className="grid size-[40px] shrink-0 place-items-center rounded-[8px] bg-accent text-accent-ink">
                  <Heart size={16} fill="currentColor" />
                </span>
              ) : (
                <Cover
                  coverArt={playlist.coverArt}
                  className="size-[40px] rounded-[8px]"
                  iconSize={16}
                />
              )}
              <span className="min-w-0">
                <span className="block truncate text-small font-semibold">{playlist.name}</span>
                {playlist.songCount !== undefined && (
                  <span className={cx(monoClassName, 'mt-[2px] block text-micro text-muted')}>
                    {playlist.songCount} SONGS
                  </span>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Octive() {
  const ask = useAskOctive()
  return (
    <section
      aria-labelledby="home-octive"
      className="flex min-w-0 flex-[1_1_280px] flex-col gap-[12px] rounded-[18px] bg-hover p-[18px]"
    >
      <div className="flex items-center gap-[10px]">
        <PetFace size={34} />
        <h2 id="home-octive" className="m-0 text-strong font-semibold">
          Ask Octive
        </h2>
      </div>
      <button
        type="button"
        onClick={() => ask()}
        className="flex min-h-[42px] items-center gap-[8px] rounded-[12px] border border-line-strong bg-canvas py-0 pr-[6px] pl-[12px] text-left text-body text-faint"
      >
        <span className="flex-1">Songs I haven&rsquo;t played in a year…</span>
        <span
          aria-hidden="true"
          className="grid size-[30px] place-items-center rounded-[8px] bg-accent text-accent-ink"
        >
          <ArrowUp size={15} />
        </span>
        <span className="sr-only">Open Octive</span>
      </button>
      <div className="flex flex-wrap gap-[6px]">
        {OCTIVE_PROMPTS.slice(0, 3).map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => ask(prompt)}
            className="min-h-[28px] rounded-full bg-active px-[10px] text-small text-text hover:text-accent coarse:min-h-11"
          >
            {prompt}
          </button>
        ))}
      </div>
    </section>
  )
}

/** The Listening room Home dashboard. The shell carries the page's name, so the heading is for screen readers. */
export function RoomHome({ sections }: { sections: HomeSections }) {
  return (
    <>
      <h1 className="sr-only">Home</h1>
      {(sections.continue || sections.stats) && (
        <div className="mb-[28px] flex flex-wrap gap-[12px] empty:hidden">
          {sections.continue && <Continue />}
          {sections.stats && <Stats />}
        </div>
      )}
      {sections.fresh && <Fresh />}
      {(sections.mostPlayed || sections.jump || sections.octive) && (
        <div className="flex flex-wrap gap-[12px]">
          {sections.mostPlayed && <MostPlayed />}
          {sections.jump && <Playlists />}
          {sections.octive && <Octive />}
        </div>
      )}
    </>
  )
}
