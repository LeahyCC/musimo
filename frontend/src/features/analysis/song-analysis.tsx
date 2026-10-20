import { useEffect, useRef, useState } from 'react'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Pause, Play, Square } from 'lucide-react'

import {
  analysisListenSchema,
  analysisQueueSchema,
  analysisStatusSchema,
  api,
  settingsSchema,
} from '../../api'
import type { AnalysisSong, AnalysisStatus } from '../../api'
import { PageTitle } from '../../components/page-title'
import { cx } from '../../lib/cx'
import { Button, ErrorBanner, Segmented, Switch } from '../../ui'
import { usePlayer } from '../player/player'
import { SettingRow, SettingsBlock, SettingsSection } from '../settings/settings-layout'
import {
  clock,
  deviceName,
  GROUPS,
  percent,
  roughly,
  seenAgo,
  spoken,
  startCommand,
  tempoText,
  workerLine,
} from './analysis-format'
import type { Device, GroupId } from './analysis-format'

const SECTION_SECONDS = 10
const STATUS_KEY = ['analysis-status'] as const

/** One shared audio element plays a measured 10 s section, and stops the main player first. */
function usePreview() {
  const audio = useRef<HTMLAudioElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const player = usePlayer()

  const stop = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    audio.current?.pause()
    setPlaying(null)
  }

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      audio.current?.pause()
    },
    [],
  )

  const play = (song: AnalysisSong, start: number) => {
    const key = `${song.id}@${start}`
    if (playing === key) {
      stop()
      return
    }
    stop()
    if (player.playing) player.toggle()
    const element = audio.current ?? new Audio()
    audio.current = element
    element.preload = 'auto'
    element.src = `/api/player/stream/${encodeURIComponent(song.id)}`
    element.addEventListener(
      'loadedmetadata',
      () => {
        element.currentTime = start
        void element.play().catch(() => setPlaying(null))
      },
      { once: true },
    )
    element.load()
    setPlaying(key)
    timer.current = setTimeout(stop, SECTION_SECONDS * 1000 + 500)
  }

  return { playing, play, stop }
}

function Counts({ status }: { status: AnalysisStatus }) {
  const { counts } = status
  const items = [
    ['Done', counts.done],
    ['Unsure', counts.unsure],
    ['Skipped', counts.skipped],
    ['Failed', counts.failed],
    ['Waiting', counts.waiting + counts.leased],
  ] as const
  return (
    <dl className="grid grid-cols-5 gap-[8px] max-phone:grid-cols-3">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-[10px] bg-raised px-[10px] py-[8px]">
          <dt className="font-mono text-caption tracking-[0.6px] text-faint uppercase">{label}</dt>
          <dd className="text-strong tabular-nums">{value.toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  )
}

function ProgressBar({ label, done, total }: { label: string; done: number; total: number }) {
  const value = percent(done, total)
  return (
    <div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        className="h-[8px] overflow-hidden rounded-full bg-line"
      >
        <div className="h-full rounded-full bg-accent" style={{ width: `${value}%` }} />
      </div>
      <p className="mt-[6px] text-small text-muted tabular-nums">
        {done.toLocaleString()} of {total.toLocaleString()} measured
      </p>
    </div>
  )
}

function WorkerState({ status }: { status: AnalysisStatus }) {
  const [device, setDevice] = useState<Device>('gpu')
  const worker = status.worker
  if (worker?.running) {
    return (
      <p className="text-small" role="status">
        <span className="font-medium text-good">Worker running</span> on {workerLine(worker)}, seen{' '}
        {seenAgo(worker.seconds_ago)}.
        {worker.note && <span className="block text-muted">{worker.note}</span>}
        {status.paused && (
          <span className="block text-warn">Paused. Nothing new is handed out.</span>
        )}
      </p>
    )
  }
  return (
    <div className="grid gap-[10px]">
      <p className="text-small" role="status">
        <span className="font-medium text-warn">The worker is not running.</span>{' '}
        {worker ? `Last seen ${seenAgo(worker.seconds_ago)}. ` : ''}
        {status.token_configured
          ? 'Start it from the Musimo folder:'
          : 'Set MUSIMO_ANALYSIS_TOKEN in .env first (the same value for Musimo and the worker), restart Musimo, then start it from the Musimo folder:'}
      </p>
      <Segmented
        label="Worker device"
        value={device}
        onChange={setDevice}
        options={[
          { value: 'gpu', label: 'Graphics card' },
          { value: 'cpu', label: 'CPU' },
        ]}
      />
      <code className="block rounded-[8px] bg-raised px-[12px] py-[10px] font-mono text-small [overflow-wrap:anywhere]">
        {startCommand(device)}
      </code>
    </div>
  )
}

function SongRow({
  song,
  playing,
  onPlay,
}: {
  song: AnalysisSong
  playing: string | null
  onPlay: (song: AnalysisSong, start: number) => void
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-[16px] gap-y-[8px] border-b border-line px-[18px] py-[12px] last:border-b-0 max-phone:px-[14px]">
      <div className="min-w-0 flex-[1_1_220px]">
        <p className="truncate text-body font-medium">{song.title || 'Untitled'}</p>
        <p className="truncate text-small text-muted">{song.artist || 'Unknown artist'}</p>
      </div>
      <p className="flex-none text-small tabular-nums">
        <span className={cx(!song.sure && 'text-warn')}>{tempoText(song)}</span>
        {song.band && <span className="text-muted"> · {song.band} energy</span>}
      </p>
      <div
        className="flex flex-none gap-[6px]"
        role="group"
        aria-label={`Sections of ${song.title}`}
      >
        {song.sections.map((start) => {
          const on = playing === `${song.id}@${start}`
          return (
            <Button
              key={start}
              aria-pressed={on}
              aria-label={`${on ? 'Stop' : 'Play'} 10 seconds from ${clock(start)}`}
              className="tabular-nums"
              onClick={() => onPlay(song, start)}
            >
              {on ? <Square size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
              {clock(start)}
            </Button>
          )
        })}
      </div>
    </li>
  )
}

function Listen({ measured }: { measured: number }) {
  const [group, setGroup] = useState<GroupId>('fastest')
  const preview = usePreview()
  // Read again every 25 songs, not on every one, while a run is going.
  const listen = useQuery({
    queryKey: ['analysis-listen', Math.floor(measured / 25)],
    queryFn: ({ signal }) => api('audio-analysis/listen', analysisListenSchema, { signal }),
    placeholderData: (previous) => previous,
  })
  const songs = listen.data?.groups[group] ?? []
  return (
    <>
      <SettingsBlock>
        <p className="text-small leading-[1.6]">
          Tempo can read half or double: a song you feel at 70 BPM may show 140, and the other way
          round. Octive allows for this when the song&apos;s energy agrees. Each button plays the
          exact 10 seconds that were measured.
        </p>
        <div className="mt-[12px] flex flex-wrap gap-[6px]" role="group" aria-label="Listen group">
          {GROUPS.map(({ id, label }) => (
            <Button
              key={id}
              aria-pressed={group === id}
              variant={group === id ? 'primary' : 'default'}
              onClick={() => {
                preview.stop()
                setGroup(id)
              }}
            >
              {label}
              {id === 'ambiguous' && listen.data ? ` (${listen.data.ambiguous_total})` : ''}
            </Button>
          ))}
        </div>
      </SettingsBlock>
      {listen.isError && (
        <SettingsBlock>
          <ErrorBanner role="alert">{listen.error.message}</ErrorBanner>
        </SettingsBlock>
      )}
      {listen.data && songs.length === 0 ? (
        <SettingsBlock>
          <p className="text-small text-muted">
            {listen.data.measured === 0
              ? 'Nothing measured yet. Measure 100 songs first.'
              : group === 'ambiguous'
                ? 'No songs to check: every reading is sure and fits its energy.'
                : 'No songs with a sure tempo yet.'}
          </p>
        </SettingsBlock>
      ) : (
        <ul aria-label={GROUPS.find((item) => item.id === group)?.label}>
          {songs.map((song) => (
            <SongRow key={song.id} song={song} playing={preview.playing} onPlay={preview.play} />
          ))}
        </ul>
      )}
    </>
  )
}

export function SongAnalysisPage() {
  const client = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  // What the switch was last set to, until the server's status agrees.
  const [wanted, setWanted] = useState<boolean | null>(null)
  const status = useQuery({
    queryKey: STATUS_KEY,
    queryFn: ({ signal }) => api('audio-analysis/status', analysisStatusSchema, { signal }),
    refetchInterval: 5000,
  })
  const refresh = () => client.invalidateQueries({ queryKey: STATUS_KEY })
  const turn = useMutation({
    mutationFn: (on: boolean) =>
      api('settings', settingsSchema, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio_scalar_recipe: on ? (status.data?.recipe ?? '') : '' }),
      }),
    onSuccess: (data, on) => {
      client.setQueryData(['settings'], data)
      client.setQueryData<AnalysisStatus>(STATUS_KEY, (old) =>
        old ? { ...old, active: on, active_recipe: data.audio_scalar_recipe.value } : old,
      )
      void refresh()
    },
    onSettled: () => setWanted(null),
  })
  const sample = useMutation({
    mutationFn: () => api('audio-analysis/sample', analysisQueueSchema, { method: 'POST' }),
    onSuccess: () => void refresh(),
  })
  const all = useMutation({
    mutationFn: () =>
      api('audio-analysis/all', analysisQueueSchema, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      }),
    onSuccess: () => {
      setConfirming(false)
      void refresh()
    },
  })
  const pause = useMutation({
    mutationFn: (paused: boolean) =>
      api('audio-analysis/pause', analysisStatusSchema, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused }),
      }),
    onSuccess: (data) => client.setQueryData(STATUS_KEY, data),
  })
  const failure = [turn, sample, all, pause].find((mutation) => mutation.isError)?.error

  const data = status.data
  // The switch follows the click straight away, not after the status is read again.
  const on = wanted ?? data?.active ?? false
  const setOn = (value: boolean) => {
    setWanted(value)
    turn.mutate(value)
  }
  const busy = turn.isPending || sample.isPending || all.isPending || pause.isPending
  const left = data ? data.counts.waiting + data.counts.leased : 0
  const measured = data ? data.counts.done + data.counts.unsure : 0
  const batch = data?.batch

  return (
    <>
      <PageTitle eyebrow="MEASURE, LISTEN, SWITCH ON" title="Song analysis" />
      <p className="-mt-[8px] mb-[24px] max-w-[650px] text-lead">
        Musimo measures each song&apos;s tempo and energy so Octive can answer &ldquo;fast&rdquo;,
        &ldquo;calmer&rdquo; or &ldquo;120 BPM&rdquo;. Measure a sample, listen, then switch it on.{' '}
        <Link to="/settings" hash="music-bot" className="underline">
          Server settings
        </Link>
      </p>
      {status.isError && (
        <ErrorBanner role="alert">
          {status.error.message}
          <button onClick={() => void status.refetch()}>Retry</button>
        </ErrorBanner>
      )}
      {failure && <ErrorBanner role="alert">{failure.message}</ErrorBanner>}
      {!data ? (
        !status.isError && <p role="status">Loading song analysis…</p>
      ) : (
        <div className="grid max-w-[860px] gap-[20px]">
          <SettingsSection
            id="status"
            title="Status"
            description="What is measured, and whether the worker is running."
          >
            <SettingRow
              htmlFor="analysis-on"
              label="Octive uses tempo and energy"
              control="switch"
              help={
                data.active
                  ? 'On. Turning it off keeps every measurement.'
                  : data.active_recipe
                    ? `Off for this recipe. Octive is using ${data.active_recipe}.`
                    : 'Off. Octive answers from tags alone until you switch it on.'
              }
            >
              <Switch
                id="analysis-on"
                checked={on}
                disabled={busy}
                onChange={(event) => setOn(event.target.checked)}
              />
            </SettingRow>
            <SettingsBlock>
              <WorkerState status={data} />
            </SettingsBlock>
            <SettingsBlock>
              <Counts status={data} />
              {data.rate.running && data.rate.songs_per_minute !== null && (
                <p className="mt-[10px] text-small text-muted tabular-nums">
                  {data.rate.songs_per_minute} songs a minute
                  {data.eta_seconds !== null ? `, ${spoken(data.eta_seconds)} left` : ''}.
                </p>
              )}
            </SettingsBlock>
          </SettingsSection>

          <SettingsSection
            id="sample"
            title="Measure 100 songs"
            description="The newest songs, plus one podcast and one recording over 20 minutes."
          >
            <SettingsBlock className="grid gap-[12px]">
              <div>
                <Button disabled={busy} onClick={() => sample.mutate()}>
                  Measure 100 songs
                </Button>
              </div>
              {sample.data && (
                <p className="text-small text-muted" role="status">
                  Queued {sample.data.queued} songs.
                  {data.worker?.running ? '' : ' They start when the worker does.'}
                </p>
              )}
              {batch?.kind === 'sample' && (
                <ProgressBar label="Sample progress" done={batch.measured} total={batch.total} />
              )}
            </SettingsBlock>
          </SettingsSection>

          <SettingsSection
            id="listen"
            title="Listen"
            description="Hear the songs at the edges before Octive relies on them."
          >
            <Listen measured={measured} />
          </SettingsSection>

          <SettingsSection
            id="switch-on"
            title="Switch on and measure everything"
            description="The two are separate: measuring changes nothing until Octive is switched on."
          >
            <SettingsBlock className="grid gap-[10px]">
              {data.active ? (
                <p className="text-small text-good" role="status">
                  On. Octive uses {data.recipe}.
                </p>
              ) : (
                <div>
                  <Button variant="primary" disabled={busy} onClick={() => setOn(true)}>
                    Turn on for Octive
                  </Button>
                </div>
              )}
            </SettingsBlock>
            <SettingsBlock className="grid gap-[12px]">
              <p className="text-small">
                {data.estimate.lacking.toLocaleString()} songs have no measurement.{' '}
                {data.estimate.lacking > 0 &&
                  `${roughly(data.estimate.whole_library_seconds)} on the ${deviceName(data.estimate.device)}${
                    data.estimate.source === 'measured'
                      ? ", at this machine's last rate."
                      : ', at the rate measured in testing.'
                  }`}
              </p>
              {confirming ? (
                <div className="flex flex-wrap items-center gap-[10px]" role="group">
                  <span className="text-small font-medium">
                    Queue {data.estimate.lacking.toLocaleString()} songs?
                  </span>
                  <Button variant="primary" disabled={busy} onClick={() => all.mutate()}>
                    Queue them
                  </Button>
                  <Button onClick={() => setConfirming(false)}>Cancel</Button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-[10px]">
                  <Button
                    disabled={busy || data.estimate.lacking === 0}
                    onClick={() => setConfirming(true)}
                  >
                    Measure whole library
                  </Button>
                  <Button disabled={busy} onClick={() => pause.mutate(!data.paused)}>
                    {data.paused ? (
                      <Play size={14} aria-hidden="true" />
                    ) : (
                      <Pause size={14} aria-hidden="true" />
                    )}
                    {data.paused ? 'Resume' : 'Pause'}
                  </Button>
                </div>
              )}
              {batch?.kind === 'all' && (
                <ProgressBar label="Library progress" done={batch.measured} total={batch.total} />
              )}
              {left > 0 && (
                <p className="text-small text-muted tabular-nums" role="status">
                  {left.toLocaleString()} waiting
                  {data.paused
                    ? ', paused.'
                    : data.eta_seconds !== null
                      ? `, ${spoken(data.eta_seconds)} left.`
                      : '.'}
                </p>
              )}
            </SettingsBlock>
          </SettingsSection>
        </div>
      )}
    </>
  )
}
