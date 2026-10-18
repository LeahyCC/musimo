import { Link } from '@tanstack/react-router'
import { Activity, Heart, Pause, Play, SlidersHorizontal } from 'lucide-react'

import { cx } from '../../lib/cx'
import { formatDuration } from '../../lib/format'
import type { HomeSections } from '../../lib/layout'
import { usePhone } from '../../lib/use-phone'
import { buttonClassName } from '../../ui'
import { PetFace } from '../music-bot/pet-host'
import { historyTrack } from '../player/play-history'
import { usePlayer } from '../player/player'
import { Cover, OCTIVE_PROMPTS, useAskOctive, useContinue, useNow } from './home-parts'
import {
  greeting,
  listeningTime,
  mostPlayedThisMonth,
  recentAlbums,
  recentArtists,
  weekStats,
} from './listening-stats'
import { useFreshAlbums, useLibraryCounts, usePlaylists } from './use-home-data'

const cardClassName = 'min-w-0 rounded-[14px] border border-line bg-raised p-[18px]'
const eyebrowClassName = 'font-semibold tracking-[0.6px] text-faint text-tiny'
const sectionTitleClassName = 'm-0 text-strong font-semibold'

function Header() {
  const now = useNow()
  const phone = usePhone()
  const fresh = useFreshAlbums()
  const counts = useLibraryCounts()
  const parts = [
    fresh.data && `${fresh.data.total.toLocaleString()} albums`,
    counts.tracks !== undefined && `${counts.tracks.toLocaleString()} songs`,
    counts.artists !== undefined && `${counts.artists.toLocaleString()} artists`,
  ].filter(Boolean)
  return (
    <div className="mb-[24px] flex items-end justify-between gap-[16px]">
      <div>
        <h1 className="m-0">{greeting(now)}</h1>
        {parts.length > 0 && <p className="mt-[6px] text-body text-muted">{parts.join(' · ')}</p>}
      </div>
      {phone && (
        <div className="flex gap-[4px]">
          {(
            [
              { to: '/diagnostics', label: 'Diagnostics', icon: Activity },
              { to: '/settings', label: 'Settings', icon: SlidersHorizontal },
            ] as const
          ).map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              aria-label={label}
              className="grid size-[44px] place-items-center rounded-[10px] bg-sunken text-muted hover:text-accent"
            >
              <Icon size={18} />
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

function Continue() {
  const current = useContinue()
  if (!current) return null
  const { track } = current
  const progress = current.length > 0 ? Math.min(100, (current.position / current.length) * 100) : 0
  return (
    <section
      aria-labelledby="home-continue"
      className={cx(cardClassName, 'flex flex-[2_1_420px] flex-wrap gap-[20px]')}
    >
      <Cover
        coverArt={track.coverArt}
        className="aspect-square w-[148px] self-start rounded-[10px] max-phone:w-[96px]"
        iconSize={40}
      />
      <div className="flex min-w-0 flex-[1_1_200px] flex-col">
        <h2 id="home-continue" className={eyebrowClassName}>
          {current.live ? 'CONTINUE LISTENING' : 'LAST PLAYED'}
        </h2>
        <div className="mt-[8px] truncate text-subtitle font-semibold">{track.title}</div>
        <div className="mt-[4px] truncate text-muted">
          {track.artist}
          {track.album && ` · ${track.album}`}
        </div>
        {current.queueNumber !== null && (
          <div className="mt-[6px] text-small text-faint">
            Track {current.queueNumber} of {current.queueSize} in the queue
          </div>
        )}
        <div className="min-h-[16px] flex-1" />
        {current.live && (
          <div className="flex items-center gap-[10px]">
            <span className="text-tiny text-faint">{formatDuration(current.position)}</span>
            <div
              role="progressbar"
              aria-label="Track progress"
              aria-valuemin={0}
              aria-valuemax={Math.round(current.length)}
              aria-valuenow={Math.round(current.position)}
              className="h-[4px] flex-1 rounded-[4px] bg-line-strong"
            >
              <div className="h-full rounded-[4px] bg-accent" style={{ width: `${progress}%` }} />
            </div>
            <span className="text-tiny text-faint">{formatDuration(current.length)}</span>
          </div>
        )}
        <div className="mt-[14px] flex flex-wrap gap-[8px]">
          <button type="button" className={buttonClassName('primary')} onClick={current.press}>
            {current.playing ? (
              <Pause size={15} fill="currentColor" />
            ) : (
              <Play size={15} fill="currentColor" />
            )}
            {current.live ? (current.playing ? 'Pause' : 'Resume') : 'Play again'}
          </button>
          {current.live && (
            <Link to="/now-playing" className={buttonClassName()}>
              Open Now Playing
            </Link>
          )}
        </div>
      </div>
    </section>
  )
}

function Stats() {
  const { history } = usePlayer()
  const now = useNow()
  if (!history.length) return null
  const week = weekStats(history, now)
  const peak = Math.max(1, ...week.days.map((bar) => bar.songs))
  const range = `${new Date(week.from).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${new Date(week.to).toLocaleDateString(undefined, { day: 'numeric' })}`
  const values = [
    { k: week.clipped ? 'Songs (latest 200)' : 'Songs played', v: week.songs.toLocaleString() },
    { k: 'Listening time', v: listeningTime(week.seconds) },
    { k: 'Artists', v: week.artists.toLocaleString() },
    { k: 'Albums', v: week.albums.toLocaleString() },
  ]
  return (
    <section aria-labelledby="home-stats" className={cx(cardClassName, 'flex-[1_1_280px]')}>
      <div className="flex items-baseline justify-between">
        <h2 id="home-stats" className={eyebrowClassName}>
          THIS WEEK
        </h2>
        <span className="text-tiny text-faint">{range}</span>
      </div>
      <dl className="mt-[16px] mb-0 grid grid-cols-2 gap-x-[16px] gap-y-[18px]">
        {values.map(({ k, v }) => (
          <div key={k}>
            <dd className="m-0 text-subtitle font-semibold tracking-[-0.6px]">{v}</dd>
            <dt className="mt-[2px] text-small text-muted">{k}</dt>
          </div>
        ))}
      </dl>
      <div
        className="mt-[18px] flex h-[56px] items-end gap-[5px]"
        role="img"
        aria-label={`Songs per day: ${week.days.map((bar) => `${bar.label} ${bar.songs}`).join(', ')}`}
      >
        {week.days.map((bar, index) => (
          <div
            key={bar.day}
            className="flex h-full flex-1 flex-col items-center justify-end gap-[4px]"
          >
            <div
              className={cx('w-full rounded-[3px]', index === 6 ? 'bg-accent' : 'bg-chart-idle')}
              style={{ height: `${Math.max(6, (bar.songs / peak) * 100)}%`, minHeight: 3 }}
            />
            <span className="text-caption text-faint">{bar.label}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function JumpBackIn() {
  const { history } = usePlayer()
  const playlists = usePlaylists()
  const likedId = playlists.data?.liked_id ?? ''
  const tiles = [
    ...recentAlbums(history, 3).map((album) => ({
      key: `album-${album.id}`,
      title: album.name,
      kind: `Album · ${album.artist}`,
      coverArt: album.coverArt,
      link: { to: '/library/albums/$albumId', params: { albumId: album.id } } as const,
    })),
    ...recentArtists(history, 2).map((artist) => ({
      key: `artist-${artist.id}`,
      title: artist.name,
      kind: 'Artist',
      coverArt: artist.coverArt,
      link: { to: '/library/artists/$artistId', params: { artistId: artist.id } } as const,
    })),
    ...(playlists.data?.items ?? []).slice(0, 3).map((playlist) => ({
      key: `playlist-${playlist.id}`,
      title: playlist.name,
      kind: `Playlist${playlist.songCount !== undefined ? ` · ${playlist.songCount} songs` : ''}`,
      coverArt: playlist.id === likedId ? undefined : playlist.coverArt,
      liked: playlist.id === likedId,
      link: { to: '/library/playlists/$playlistId', params: { playlistId: playlist.id } } as const,
    })),
  ].slice(0, 6)
  if (!tiles.length) return null
  return (
    <section aria-labelledby="home-jump" className="mb-[32px]">
      <h2 id="home-jump" className={cx(sectionTitleClassName, 'mb-[14px]')}>
        Jump back in
      </h2>
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-[8px] p-0 max-phone:grid-cols-1">
        {tiles.map((tile) => (
          <li key={tile.key} className="min-w-0">
            <Link
              {...tile.link}
              className="flex h-[56px] items-center gap-[12px] overflow-hidden rounded-[10px] bg-raised pr-[12px] text-text hover:bg-hover"
            >
              {'liked' in tile && tile.liked ? (
                <span className="grid size-[56px] shrink-0 place-items-center bg-accent text-accent-ink">
                  <Heart size={20} fill="currentColor" />
                </span>
              ) : (
                <Cover coverArt={tile.coverArt} className="size-[56px]" iconSize={20} />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body font-semibold">{tile.title}</span>
                <span className="mt-[2px] block truncate text-small text-muted">{tile.kind}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Fresh() {
  const fresh = useFreshAlbums()
  const albums = (fresh.data?.items ?? []).slice(0, 6)
  if (!albums.length) return null
  return (
    <section aria-labelledby="home-fresh" className="mb-[32px]">
      <div className="mb-[14px] flex items-baseline justify-between">
        <h2 id="home-fresh" className={sectionTitleClassName}>
          Fresh in your library
        </h2>
        <Link to="/library/albums" className="text-small text-muted hover:text-accent">
          See all albums
        </Link>
      </div>
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-[16px] gap-y-[20px] p-0 max-phone:grid-cols-2">
        {albums.map((album) => (
          <li key={album.id} className="min-w-0">
            <Link
              to="/library/albums/$albumId"
              params={{ albumId: album.id }}
              className="block text-text hover:text-accent"
            >
              <Cover
                coverArt={album.coverArt}
                className="aspect-square w-full rounded-[10px]"
                iconSize={32}
              />
              <strong className="mt-[9px] block truncate text-body">{album.name}</strong>
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
  return (
    <section aria-labelledby="home-repeat" className="min-w-0 flex-[3_1_420px]">
      <h2 id="home-repeat" className={cx(sectionTitleClassName, 'mb-[14px]')}>
        On repeat this month
      </h2>
      <ol className="m-0 list-none overflow-hidden rounded-[12px] border border-line p-0">
        {songs.map(({ entry, plays }, index) => (
          <li key={entry.id} className="border-t border-line first:border-t-0">
            <button
              type="button"
              aria-label={`Play ${entry.title} by ${entry.artist}`}
              onClick={() => playLibrary([historyTrack(entry)])}
              className="grid w-full grid-cols-[24px_40px_minmax(0,1fr)_auto] items-center gap-[12px] px-[14px] py-[8px] text-left hover:bg-sunken"
            >
              <span className="text-right text-small text-faint">{index + 1}</span>
              <Cover
                coverArt={entry.coverArt}
                className="size-[40px] rounded-[6px]"
                iconSize={16}
              />
              <span className="min-w-0">
                <span className="block truncate font-medium">{entry.title}</span>
                <span className="block truncate text-small text-muted">{entry.artist}</span>
              </span>
              <span className="text-small text-faint">{plays} plays</span>
            </button>
          </li>
        ))}
      </ol>
      <p className="mt-[8px] text-caption text-faint">
        Counted from what was played in this browser.
      </p>
    </section>
  )
}

function Octive() {
  const ask = useAskOctive()
  return (
    <section
      aria-labelledby="home-octive"
      className="min-w-0 flex-[2_1_300px] self-start rounded-[14px] border border-line bg-sunken p-[18px]"
    >
      <div className="flex items-center gap-[12px]">
        <PetFace size={40} />
        <div>
          <h2 id="home-octive" className="m-0 text-lead font-semibold">
            Octive can build a queue
          </h2>
          <p className="mt-[2px] text-small text-muted">From your tags, likes and play history.</p>
        </div>
      </div>
      <div className="mt-[16px] flex flex-wrap gap-[8px]">
        {OCTIVE_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => ask(prompt)}
            className="min-h-[32px] rounded-full border border-line-strong bg-raised px-[12px] text-small text-text hover:border-good-line hover:text-accent coarse:min-h-11"
          >
            {prompt}
          </button>
        ))}
      </div>
    </section>
  )
}

/** The Classic Home dashboard: a greeting, then the sections the person has left on. */
export function ClassicHome({ sections }: { sections: HomeSections }) {
  return (
    <>
      <Header />
      {(sections.continue || sections.stats) && (
        <div className="mb-[32px] flex flex-wrap gap-[16px] empty:hidden">
          {sections.continue && <Continue />}
          {sections.stats && <Stats />}
        </div>
      )}
      {sections.jump && <JumpBackIn />}
      {sections.fresh && <Fresh />}
      {(sections.mostPlayed || sections.octive) && (
        <div className="flex flex-wrap gap-[16px]">
          {sections.mostPlayed && <MostPlayed />}
          {sections.octive && <Octive />}
        </div>
      )}
    </>
  )
}
