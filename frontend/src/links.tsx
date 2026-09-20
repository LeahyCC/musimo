import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ClipboardEvent, ReactNode } from 'react'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { LoaderCircle, Music2 } from 'lucide-react'
import { z } from 'zod'

import { api, diagnosticsSchema, jobSchema, settingsSchema } from './api'
import { DESTINATION_PROBLEM, destinationBroken, formatLabel } from './download-target'
import { updateJob } from './downloads'
import {
  FormatSelect,
  plural,
  ReviewDialog,
  ReviewOptions,
  ReviewRow,
  SelectAllNone,
  TargetSelect,
} from './review-sheet'
import { Button, ErrorBanner, Ownership } from './ui'

const entrySchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  album: z.string(),
  date: z.string(),
  duration: z.number(),
  art: z.string(),
  owned: z.boolean(),
})
const previewSchema = z.object({
  token: z.string(),
  site: z.string(),
  single: z.boolean(),
  // A person's or channel's whole catalog. Older servers do not send it.
  profile: z.boolean().default(false),
  title: z.string(),
  truncated: z.boolean(),
  // Part of the page could not be read in time. Older servers do not send it.
  partial: z.boolean().default(false),
  // What to know about the audio quality before queueing. Older servers do not send it.
  quality_note: z.string().default(''),
  entries: z.array(entrySchema),
})
type Preview = z.infer<typeof previewSchema>
type Entry = Preview['entries'][number]
const queuedSchema = z.object({
  id: z.string(),
  jobs: z.array(jobSchema),
  skipped_done: z.number(),
})

type Sheet =
  | { phase: 'idle' }
  | { phase: 'resolving'; host: string }
  | { phase: 'error'; host: string; message: string }
  | { phase: 'ready'; host: string; preview: Preview }

// Anything that starts like a link. Typing one must not search the catalog for it, even while
// it is still half written.
const LINK_START = /^https?:\/\/\S*$/i

/** True while the text is one web address, complete or not. It is never a catalog search. */
export const isLinkText = (text: string) => LINK_START.test(text.trim())

/** The address when the text is exactly one whole link, otherwise null. */
function wholeLink(text: string): { url: string; host: string } | null {
  const url = text.trim()
  if (!LINK_START.test(url)) return null
  try {
    const host = new URL(url).hostname
    return host ? { url, host } : null
  } catch {
    return null
  }
}

const clock = (seconds: number) => {
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const rest = String(total % 60).padStart(2, '0')
  const minutes = Math.floor((total % 3600) / 60)
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}

const detail = (entry: Entry) =>
  [entry.artist, entry.duration ? clock(entry.duration) : '', entry.date]
    .filter(Boolean)
    .join(' · ')

/** What is ticked before the person touches anything. */
export function initialSelection(preview: Preview): Set<string> {
  // A lone recording is what they pasted, so it is ticked even when a copy is already owned.
  if (preview.single) return new Set(preview.entries.map((entry) => entry.id))
  // A whole profile is too much to want by default. Anything else starts with what is missing.
  if (preview.profile) return new Set()
  return new Set(preview.entries.filter((entry) => !entry.owned).map((entry) => entry.id))
}

/**
 * Pasting or submitting a link in the search box. `paste` and `submit` return true when the
 * text was taken as a link, so the caller skips its catalog search. A link is looked up once,
 * when it is complete, never per keystroke, and looking up another link or closing the sheet
 * abandons the request still in flight.
 */
export function useLinkSheet() {
  const [sheet, setSheet] = useState<Sheet>({ phase: 'idle' })
  const request = useRef<AbortController | null>(null)

  const dismiss = useCallback(() => {
    request.current?.abort()
    request.current = null
    setSheet({ phase: 'idle' })
  }, [])

  const open = useCallback((text: string, partial: boolean) => {
    request.current?.abort()
    request.current = null
    const link = wholeLink(text)
    if (!link || link.url.length > 2000) {
      if (!partial) return false
      setSheet({
        phase: 'error',
        host: '',
        message: link
          ? 'That link is too long. Paste the address from the page’s share button.'
          : 'That is not a whole link. Paste the full address, starting with https://.',
      })

      return true
    }
    const controller = new AbortController()
    request.current = controller
    setSheet({ phase: 'resolving', host: link.host })
    api('links/resolve', previewSchema, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: link.url }),
      signal: controller.signal,
    }).then(
      (preview) => {
        if (request.current !== controller) return
        request.current = null
        setSheet({ phase: 'ready', host: link.host, preview })
      },
      (error: unknown) => {
        // A superseded or cancelled request is not a failure the person needs to hear about.
        if (request.current !== controller) return
        request.current = null
        setSheet({
          phase: 'error',
          host: link.host,
          message: error instanceof Error ? error.message : 'Musimo could not read this link.',
        })
      },
    )

    return true
  }, [])

  useEffect(() => () => request.current?.abort(), [])

  return {
    /** Enter in the search box. A half-typed address gets a plain message instead of a search. */
    submit: (text: string) => isLinkText(text) && open(text, true),
    /** A paste of one whole link replaces whatever was in the box. Other pastes are left alone. */
    paste: (event: ClipboardEvent<HTMLInputElement>, setText: (text: string) => void) => {
      const pasted = event.clipboardData.getData('text')
      if (!wholeLink(pasted) || !open(pasted, false)) return
      event.preventDefault()
      setText(pasted.trim())
    },
    sheet: sheet.phase === 'idle' ? null : <LinkSheet sheet={sheet} onDismiss={dismiss} />,
  }
}

function LinkSheet({
  sheet,
  onDismiss,
}: {
  sheet: Exclude<Sheet, { phase: 'idle' }>
  onDismiss: () => void
}) {
  const client = useQueryClient()
  const dialog = useRef<HTMLDialogElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const [format, setFormat] = useState('')
  const [target, setTarget] = useState('')
  // Ticks belong to one preview. Keeping the token beside them means a new link starts from its
  // own defaults without an effect to reset them.
  const [ticked, setTicked] = useState<{ token: string; ids: Set<string> } | null>(null)
  const preview = sheet.phase === 'ready' ? sheet.preview : null

  // Opens the dialog on mount, and again if a new link lands after the last one was closed but
  // before the close event reached React.
  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [sheet])

  // The content under the heading is replaced when the answer arrives. Put focus on something
  // that still exists, so a keyboard or screen reader user is not left on a removed button.
  useEffect(() => {
    if (sheet.phase === 'resolving') cancel.current?.focus()
    else title.current?.focus()
  }, [sheet.phase])

  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: ({ signal }) => api('settings', settingsSchema, { signal }),
  })
  const mounts = useQuery({
    queryKey: ['diagnostics'],
    queryFn: ({ signal }) => api('diagnostics', diagnosticsSchema, { signal }),
    enabled: Boolean(preview),
  })
  const chosenFormat = format || settings.data?.output_format.value || 'original'
  const chosenTarget = target || settings.data?.destination.value || ''
  // A read-only or missing folder would fail every song, so say so before anything is queued.
  const brokenTarget = destinationBroken(mounts.data?.disks, chosenTarget)
  const queue = useMutation({
    mutationFn: (body: { token: string; entry_ids: string[] }) =>
      api('links', queuedSchema, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, format: chosenFormat, target: chosenTarget }),
      }),
    onSuccess: (batch) => {
      for (const job of batch.jobs) updateJob(client, job)
    },
  })

  const entries = preview?.entries ?? []
  const ids = preview
    ? ticked?.token === preview.token
      ? ticked.ids
      : initialSelection(preview)
    : new Set<string>()
  const chosen = entries.filter((entry) => ids.has(entry.id))
  const seconds = chosen.reduce((total, entry) => total + entry.duration, 0)
  const owned = entries.filter((entry) => entry.owned).length
  const result = preview && queue.variables?.token === preview.token ? queue.data : undefined
  const busy = queue.isPending
  const tick = (next: Set<string>) => preview && setTicked({ token: preview.token, ids: next })

  const first = entries[0]
  const heading =
    sheet.phase === 'resolving'
      ? 'Checking link'
      : sheet.phase === 'error'
        ? 'This link can’t be used'
        : preview?.single
          ? 'Review download'
          : preview?.title || 'Choose what to download'

  let footer: ReactNode
  if (!preview) {
    footer = (
      <Button ref={cancel} onClick={() => dialog.current?.close()}>
        {sheet.phase === 'resolving' ? 'Cancel' : 'Close'}
      </Button>
    )
  } else if (result) {
    footer = (
      <p role="status">
        {result.jobs.length
          ? `${plural(result.jobs.length, 'song')} queued from ${preview.site}.`
          : 'Nothing new was queued. It is already downloaded.'}{' '}
        <Link to="/downloads" onClick={() => dialog.current?.close()}>
          Open downloads
        </Link>
      </p>
    )
  } else {
    footer = (
      <>
        <Button
          variant="primary"
          disabled={!chosen.length || busy || !chosenTarget || brokenTarget}
          onClick={() =>
            queue.mutate({ token: preview.token, entry_ids: chosen.map((entry) => entry.id) })
          }
        >
          {busy
            ? 'Adding…'
            : preview.single
              ? 'Download'
              : `Download ${plural(chosen.length, 'song')}`}
        </Button>
        {brokenTarget && <ErrorBanner role="alert">{DESTINATION_PROBLEM}</ErrorBanner>}
        {queue.isError && <ErrorBanner role="alert">{queue.error.message}</ErrorBanner>}
      </>
    )
  }

  return (
    <ReviewDialog
      dialogRef={dialog}
      titleId={titleId}
      titleRef={title}
      eyebrow={preview?.site ?? (sheet.host || 'Link')}
      title={heading}
      closeLabel="Close link review"
      closeDisabled={busy}
      // A close that arrives after the dialog was opened again belongs to the old link.
      onClose={() => {
        if (!dialog.current?.open) onDismiss()
      }}
      footer={footer}
    >
      {sheet.phase === 'resolving' && (
        <p role="status" className="flex items-center gap-[12px] py-[16px] text-body">
          <LoaderCircle
            size={22}
            className="shrink-0 animate-spin text-accent"
            aria-hidden="true"
          />
          Checking the link with {sheet.host}… This can take up to 20 seconds.
        </p>
      )}
      {sheet.phase === 'error' && <ErrorBanner role="alert">{sheet.message}</ErrorBanner>}
      {preview && (
        <>
          <div
            className="my-[16px] grid gap-[8px] rounded-[10px] bg-good-bg p-[18px] max-phone:p-[14px]"
            aria-live="polite"
          >
            {preview.single && first ? (
              <div className="flex items-start gap-[16px] max-phone:gap-[12px]">
                {first.art ? (
                  <img
                    src={first.art}
                    alt=""
                    className="h-[96px] w-[96px] shrink-0 rounded-md object-cover max-phone:h-[72px] max-phone:w-[72px]"
                  />
                ) : (
                  <Music2
                    size={40}
                    aria-hidden="true"
                    className="h-[96px] w-[96px] shrink-0 rounded-md bg-active p-[28px] text-accent max-phone:h-[72px] max-phone:w-[72px] max-phone:p-[20px]"
                  />
                )}
                <div className="grid min-w-0 gap-[6px]">
                  <strong className="text-[20px] [overflow-wrap:anywhere] max-phone:text-lead">
                    {first.title}
                  </strong>
                  <span className="text-small text-muted [overflow-wrap:anywhere]">
                    {[first.artist, first.album].filter(Boolean).join(' · ') || preview.site}
                  </span>
                  <span className="text-small text-muted">
                    {[first.duration ? clock(first.duration) : '', first.date]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  {first.owned && <Ownership variant="owned">In library</Ownership>}
                </div>
              </div>
            ) : (
              <>
                <strong className="text-[24px] max-phone:text-[20px]">
                  {chosen.length} of {plural(entries.length, 'song')} selected
                </strong>
                <span className="text-small text-muted">
                  {seconds ? `${clock(seconds)} · ` : ''}
                  {plural(owned, 'song')} already in library
                </span>
              </>
            )}
            <small className="text-small text-muted">
              to {chosenTarget || '(not set)'} · {formatLabel(chosenFormat)}
            </small>
            {preview.quality_note && (
              <p className="text-small text-muted">{preview.quality_note}</p>
            )}
          </div>
          <ReviewOptions>
            <FormatSelect value={chosenFormat} disabled={busy} onChange={setFormat} />
            <TargetSelect
              value={chosenTarget}
              disabled={busy}
              onChange={setTarget}
              disks={mounts.data?.disks.slice(1) ?? []}
            />
          </ReviewOptions>
          {!preview.single && (
            <>
              <p className="my-[12px] text-small text-muted">
                {preview.profile
                  ? 'This is a whole profile, so nothing is ticked. Tick what you want.'
                  : 'Songs already in your library are unticked.'}
                {preview.truncated ? ' Only the first 500 are listed.' : ''}
                {preview.partial
                  ? ' Some of this page could not be read in time. Paste an album or track link for the rest.'
                  : ''}
              </p>
              <SelectAllNone
                disabled={busy}
                onAll={() => tick(new Set(entries.map((entry) => entry.id)))}
                onNone={() => tick(new Set())}
              />
              <fieldset className="my-[14px] min-w-0 border-0 p-0" disabled={busy}>
                <legend className="sr-only">Songs</legend>
                {entries.map((entry) => (
                  <ReviewRow
                    key={entry.id}
                    checked={ids.has(entry.id)}
                    onChange={(checked) => {
                      const next = new Set(ids)
                      if (checked) next.add(entry.id)
                      else next.delete(entry.id)
                      tick(next)
                    }}
                    art={entry.art}
                    title={entry.title}
                    detail={detail(entry)}
                    badge={
                      entry.owned ? (
                        <Ownership variant="owned" className="shrink-0">
                          In library
                        </Ownership>
                      ) : undefined
                    }
                  />
                ))}
              </fieldset>
            </>
          )}
        </>
      )}
    </ReviewDialog>
  )
}
