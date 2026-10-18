import { useState } from 'react'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import {
  ArrowDownToLine,
  Check,
  CircleDashed,
  Clock,
  Podcast as PodcastIcon,
  RotateCcw,
} from 'lucide-react'

import { api, jobSchema, podcastDetailSchema, podcastsSchema } from '../../api'
import type { DownloadJob, Episode, Podcast } from '../../api'
import { cx } from '../../lib/cx'
import { useLayout } from '../../lib/layout'
import { Button, ErrorBanner, Field, IconButton, Ownership } from '../../ui'
import { DownloadTarget } from '../downloads/download-target'
import { activeJob, failureMessage, updateJob, useJobs } from '../downloads/jobs'
import { CatalogHero, HeroDestination } from '../search/catalog-hero'
import { BackToSearch } from '../search/results'

/** "58 min" or "4 h 1 min": episodes run long enough that m:ss reads badly. */
export function episodeLength(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const rest = minutes % 60
  return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${minutes / 60} h`
}

function episodeDate(date: string): string {
  // Noon keeps the calendar day the same in every time zone.
  const parsed = new Date(`${date}T12:00:00`)
  return Number.isNaN(parsed.getTime())
    ? ''
    : parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function Cover({
  src,
  className,
  rounded = 'rounded-[7px]',
}: {
  src: string
  className?: string
  rounded?: string
}) {
  return (
    <div
      className={cx(
        'flex shrink-0 items-center justify-center overflow-hidden bg-active',
        rounded,
        className,
      )}
    >
      {src ? (
        <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" />
      ) : (
        <PodcastIcon />
      )}
    </div>
  )
}

function PodcastCard({ podcast }: { podcast: Podcast }) {
  return (
    <article className="group relative isolate flex min-w-0 flex-col gap-[9px] rounded-lg border border-transparent bg-raised p-[12px] hover:border-line hover:bg-hover focus-within:border-line focus-within:bg-hover">
      <Cover src={podcast.art} className="aspect-square" />
      <Link
        className="card-primary-link block text-lead font-semibold"
        to="/podcasts/$podcastId"
        params={{ podcastId: String(podcast.id) }}
      >
        <span className="block overflow-hidden text-ellipsis whitespace-nowrap">
          {podcast.title}
        </span>
      </Link>
      <small className="block overflow-hidden text-ellipsis whitespace-nowrap text-body text-muted">
        {podcast.author || podcast.genre}
      </small>
    </article>
  )
}

/** The Podcasts search tab. Apple's directory, so it never shares the music tabs' filters. */
export function PodcastResults({ q }: { q: string }) {
  const query = useQuery({
    queryKey: ['podcasts', q],
    queryFn: ({ signal }) =>
      api(`podcasts?${new URLSearchParams({ q })}`, podcastsSchema, { signal }),
    staleTime: 60_000,
    retry: false,
  })
  return (
    <section className="mb-[36px]" aria-label="Podcasts">
      <div className="mb-[17px] flex items-center justify-between gap-[12px]">
        <h2 className="mb-[12px] text-base">Podcasts</h2>
        {query.data && <small>{query.data.length} shows</small>}
      </div>
      {query.isError && (
        <ErrorBanner role="alert">
          {query.error.message}
          <button onClick={() => void query.refetch()}>Retry</button>
        </ErrorBanner>
      )}
      {query.isPending && <p role="status">Searching podcasts…</p>}
      {query.data && query.data.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(145px,1fr))] gap-[20px] max-phone:grid-cols-2 max-phone:gap-[12px]">
          {query.data.map((podcast) => (
            <PodcastCard key={podcast.id} podcast={podcast} />
          ))}
        </div>
      )}
      {query.data?.length === 0 && <p className="py-[30px]">No podcasts match this search.</p>}
    </section>
  )
}

function jobLabel(job: DownloadJob): string {
  return job.stage === 'done'
    ? 'Downloaded'
    : job.stage === 'failed'
      ? 'Download failed'
      : job.stage.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase())
}

/** How many of the newest episodes the hero's "Download latest" queues at once. */
const LATEST_COUNT = 5

function EpisodeStatus({ job }: { job?: DownloadJob }) {
  const room = useLayout() === 'room'
  const failed = job?.stage === 'failed' ? job : undefined
  const done = job?.stage === 'done'
  const variant = failed ? 'failed' : done ? 'owned' : 'missing'
  const label = job ? jobLabel(job) : 'Not in library'
  const title = failed ? failed.error_hint || failureMessage(failed) : job?.final_path
  const Icon = done ? Check : failed ? null : job ? Clock : CircleDashed
  if (room)
    return (
      <span
        data-ui="ownership"
        data-variant={variant}
        title={title}
        className={cx(
          'inline-flex items-center gap-[6px] text-small whitespace-nowrap',
          failed ? 'text-danger' : done ? 'text-accent' : 'text-muted',
        )}
      >
        <i
          aria-hidden="true"
          className={cx(
            'size-[7px] rounded-pill',
            failed ? 'bg-danger' : done ? 'bg-accent' : 'bg-faint',
          )}
        />
        {label}
      </span>
    )
  return (
    <Ownership variant={variant} title={title}>
      {Icon && <Icon size={12} />}
      {label}
    </Ownership>
  )
}

function EpisodeRow({
  episode,
  job,
  number,
}: {
  episode: Episode
  job?: DownloadJob
  number: number
}) {
  const client = useQueryClient()
  const room = useLayout() === 'room'
  const failed = job?.stage === 'failed' ? job : undefined
  const busy = job ? activeJob(job) : false
  const done = job?.stage === 'done'
  const mutation = useMutation({
    mutationFn: () =>
      failed
        ? api(`jobs/${failed.id}/retry`, jobSchema, { method: 'POST' })
        : api('podcast-episodes', jobSchema, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ podcast_id: episode.podcast_id, episode_id: episode.id }),
          }),
    onSuccess: (saved) => updateJob(client, saved),
  })
  return (
    <li
      className={cx(
        'grid grid-cols-[34px_minmax(0,1fr)_auto_40px] items-center gap-[14px] px-[10px] py-[6px] text-small',
        'max-phone:grid-cols-[minmax(0,1fr)_auto_40px] max-phone:gap-[10px] max-phone:px-0',
        room
          ? 'rounded-[10px] hover:bg-raised'
          : 'border-t border-line first:border-t-0 hover:bg-sunken',
      )}
    >
      <span className="text-right font-mono text-tiny text-faint max-phone:hidden">{number}</span>
      <div className="min-w-0">
        <strong className="block overflow-hidden text-ellipsis whitespace-nowrap text-lead font-medium">
          {episode.title}
        </strong>
        <span className="mt-[3px] block text-body text-muted">
          {[episodeDate(episode.date), episode.duration ? episodeLength(episode.duration) : '']
            .filter(Boolean)
            .join(' · ')}
        </span>
        {episode.description && (
          <p className="mt-[3px] line-clamp-1 text-small text-faint max-phone:hidden">
            {episode.description}
          </p>
        )}
        {mutation.isError && (
          <p role="alert" className="mt-[5px] text-small text-danger">
            {mutation.error.message}
          </p>
        )}
      </div>
      <EpisodeStatus job={job} />
      <IconButton
        aria-label={
          busy
            ? `${episode.title} is ${job?.stage.replaceAll('_', ' ')}`
            : done
              ? `${episode.title} is downloaded`
              : failed
                ? `Retry ${episode.title}. ${failureMessage(failed)}`
                : `Download ${episode.title}`
        }
        title={failed ? failureMessage(failed) : undefined}
        disabled={busy || done || mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        {done ? (
          <Check size={17} />
        ) : busy ? (
          <Clock size={17} />
        ) : failed ? (
          <RotateCcw size={17} />
        ) : (
          <ArrowDownToLine size={17} />
        )}
      </IconButton>
    </li>
  )
}

export function PodcastPage() {
  const { podcastId } = useParams({ from: '/podcasts/$podcastId' })
  const client = useQueryClient()
  const room = useLayout() === 'room'
  const [filter, setFilter] = useState('')
  const query = useQuery({
    queryKey: ['podcast', podcastId],
    queryFn: ({ signal }) => api(`podcasts/${podcastId}`, podcastDetailSchema, { signal }),
    staleTime: 600_000,
  })
  // Newest job per episode, so a retry replaces the failure it came from.
  const jobs = useJobs((data) => {
    const latest = new Map<number, DownloadJob>()
    for (const job of data.jobs) {
      if (job.catalog !== 'podcast' || job.hidden) continue
      const current = latest.get(job.track_id)
      if (!current || current.updated_at < job.updated_at) latest.set(job.track_id, job)
    }
    return latest
  })
  const latest = useMutation({
    mutationFn: (batch: Episode[]) =>
      Promise.all(
        batch.map((episode) =>
          api('podcast-episodes', jobSchema, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ podcast_id: episode.podcast_id, episode_id: episode.id }),
          }),
        ),
      ),
    onSuccess: (saved) => {
      for (const job of saved) updateJob(client, job)
    },
  })
  if (query.isError)
    return (
      <ErrorBanner role="alert">
        {query.error.message}
        <button onClick={() => void query.refetch()}>Retry</button>
      </ErrorBanner>
    )
  if (!query.data) return <p role="status">Loading podcast…</p>
  const { podcast } = query.data
  // Newest first, whatever order the directory sent them in. Dates are ISO days, so they sort as text.
  const episodes = [...query.data.episodes].sort((a, b) => b.date.localeCompare(a.date))
  const needle = filter.trim().toLocaleLowerCase()
  const shown = needle
    ? episodes.filter((episode) => episode.title.toLocaleLowerCase().includes(needle))
    : episodes
  const total = Math.max(podcast.episode_count, episodes.length)
  const states = episodes.map((episode) => jobs.data?.get(episode.id))
  const done = states.filter((job) => job?.stage === 'done').length
  const queued = states.filter((job) => job && activeJob(job)).length
  // Only an episode with no job at all is offered again; a failed one has its own Retry.
  const fresh = episodes.filter((episode) => !jobs.data?.get(episode.id)).slice(0, LATEST_COUNT)
  return (
    <div className="[container-type:inline-size]">
      <BackToSearch fallback={{ q: podcast.title, tab: 'podcast' }} />
      <CatalogHero
        cover={
          <Cover
            src={podcast.art}
            rounded="rounded-[14px]"
            className="aspect-square w-full shadow-[0_24px_50px_-24px_color-mix(in_oklab,var(--color-shadow)_80%,transparent)]"
          />
        }
        eyebrow={`Podcast${podcast.genre ? ` · ${podcast.genre}` : ''}`}
        source="Apple Podcasts"
        title={podcast.title}
        byline={podcast.author ? <span>{podcast.author}</span> : undefined}
        meta={`${episodes.length} episode${episodes.length === 1 ? '' : 's'} listed${podcast.episode_count > episodes.length ? ` (latest of ${podcast.episode_count})` : ''}`}
        coverage={
          episodes.length
            ? {
                owned: done,
                otherEdition: 0,
                queued,
                missing: Math.max(0, episodes.length - done - queued),
              }
            : undefined
        }
        actions={
          <>
            <Button
              variant="primary"
              disabled={fresh.length === 0 || latest.isPending}
              onClick={() => latest.mutate(fresh)}
            >
              <ArrowDownToLine size={16} />
              {fresh.length > 0 ? `Download latest ${fresh.length}` : 'Download latest'}
            </Button>
            <HeroDestination>
              <DownloadTarget format="original" />
            </HeroDestination>
            {latest.isError && (
              <span role="alert" className="w-full text-small text-danger">
                {latest.error.message}
              </span>
            )}
          </>
        }
      />
      <label className="mb-[16px] flex max-w-[420px] flex-col gap-[5px] text-small text-muted">
        Find an episode
        <Field
          tone="sunken"
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </label>
      {shown.length ? (
        <>
          <div
            aria-hidden="true"
            className={cx(
              'grid grid-cols-[34px_minmax(0,1fr)_auto_40px] gap-[14px] border-b border-line px-[10px] pb-[8px] text-caption tracking-[0.6px] text-faint max-phone:hidden',
              room && 'font-mono',
            )}
          >
            <span className="text-right">#</span>
            <span>EPISODE</span>
            <span>STATUS</span>
            <span />
          </div>
          <ul aria-label="Episodes" className="m-0 list-none p-0 pt-[6px]">
            {shown.map((episode) => (
              <EpisodeRow
                key={episode.id}
                episode={episode}
                job={jobs.data?.get(episode.id)}
                number={total - episodes.indexOf(episode)}
              />
            ))}
          </ul>
        </>
      ) : (
        <p className="py-[30px]">
          {episodes.length ? 'No episodes match that title.' : 'No downloadable episodes listed.'}
        </p>
      )}
      <p className="mt-[18px] border-t border-line pt-[14px] text-small text-faint">
        Episodes save to Podcasts/show name/date - title in the chosen folder, in the file format
        the show publishes. Counts cover the episodes listed here and the ones you have downloaded.
      </p>
    </div>
  )
}
