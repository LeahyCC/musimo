import { useState } from 'react'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { ArrowDownToLine, Check, Podcast as PodcastIcon, RotateCcw } from 'lucide-react'

import { api, jobSchema, podcastDetailSchema, podcastsSchema } from './api'
import type { DownloadJob, Episode, Podcast } from './api'
import { cx } from './cx'
import { DownloadTarget } from './download-target'
import { activeJob, failureMessage, updateJob, useJobs } from './downloads'
import { ErrorBanner, Field, IconButton, Ownership, textLinkClassName } from './ui'

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

function Cover({ src, className }: { src: string; className?: string }) {
  return (
    <div
      className={cx(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-[7px] bg-active',
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

function EpisodeRow({ episode, job }: { episode: Episode; job?: DownloadJob }) {
  const client = useQueryClient()
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
    <li className="flex items-center gap-[14px] border-b border-line p-[8px] text-small hover:bg-hover max-phone:gap-[10px] max-phone:px-0">
      <div className="min-w-0 flex-1">
        <strong className="block overflow-hidden text-ellipsis whitespace-nowrap text-lead font-medium">
          {episode.title}
        </strong>
        <span className="mt-[5px] block text-body text-muted">
          {[episodeDate(episode.date), episode.duration ? episodeLength(episode.duration) : '']
            .filter(Boolean)
            .join(' · ')}
        </span>
        {episode.description && (
          <p className="mt-[5px] line-clamp-2 text-small text-muted max-phone:hidden">
            {episode.description}
          </p>
        )}
        {mutation.isError && (
          <p role="alert" className="mt-[5px] text-small text-danger">
            {mutation.error.message}
          </p>
        )}
      </div>
      {job && (
        <Ownership
          variant={failed ? 'failed' : done ? 'owned' : 'partial'}
          title={failed ? failed.error_hint || failureMessage(failed) : job.final_path}
        >
          {done && <Check size={12} />}
          {jobLabel(job)}
        </Ownership>
      )}
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
        {busy || done ? (
          <Check size={17} />
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
  if (query.isError)
    return (
      <ErrorBanner role="alert">
        {query.error.message}
        <button onClick={() => void query.refetch()}>Retry</button>
      </ErrorBanner>
    )
  if (!query.data) return <p role="status">Loading podcast…</p>
  const { podcast, episodes } = query.data
  const needle = filter.trim().toLocaleLowerCase()
  const shown = needle
    ? episodes.filter((episode) => episode.title.toLocaleLowerCase().includes(needle))
    : episodes
  return (
    <>
      <Link
        to="/search"
        search={{ q: podcast.title, tab: 'podcast' }}
        className={textLinkClassName()}
      >
        ← Podcast search
      </Link>
      <div className="mt-[24px] mb-[32px] flex items-center gap-[28px] max-phone:items-start max-phone:gap-[16px]">
        <Cover src={podcast.art} className="aspect-square w-[210px] max-phone:w-[95px]" />
        <div className="min-w-0">
          <span className="text-micro font-semibold tracking-[2px] text-faint max-phone:text-caption">
            PODCAST{podcast.genre ? ` · ${podcast.genre.toUpperCase()}` : ''}
          </span>
          <h1 className="my-[12px] max-phone:text-[24px]">{podcast.title}</h1>
          {podcast.author && <p>{podcast.author}</p>}
          <p className="my-[15px] text-body">
            {episodes.length} episode{episodes.length === 1 ? '' : 's'} listed
            {podcast.episode_count > episodes.length ? ` (latest of ${podcast.episode_count})` : ''}
          </p>
          <DownloadTarget format="original" />
        </div>
      </div>
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
        <ul aria-label="Episodes" className="m-0 list-none p-0">
          {shown.map((episode) => (
            <EpisodeRow key={episode.id} episode={episode} job={jobs.data?.get(episode.id)} />
          ))}
        </ul>
      ) : (
        <p className="py-[30px]">
          {episodes.length ? 'No episodes match that title.' : 'No downloadable episodes listed.'}
        </p>
      )}
      <p className="mt-[20px] text-small text-muted">
        Episodes save to Podcasts/show name/date - title in the chosen folder, in the file format
        the show publishes.
      </p>
    </>
  )
}
