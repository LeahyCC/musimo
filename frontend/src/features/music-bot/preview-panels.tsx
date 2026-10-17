import { Check, RefreshCw } from 'lucide-react'

import { Button } from '../../ui'
import { useBotChat } from './bot-chat'
import type { Preview } from './bot-chat'
import { overviewFacts } from './preview-text'

/* The parts of a result card that belong to the stored preview: what its songs show, and what to
   do when the last confirmation did not go through. */

/** What the songs show, and apart from it what could not be read. The filters the person asked
 *  for are the chips above; nothing here is guessed from a genre name. */
export function PreviewFacts({ preview }: { preview: Preview }) {
  const { measured, unknown } = overviewFacts(preview.overview)
  if (!measured.length && !unknown.length) return null
  return (
    <dl
      aria-label="About this preview"
      data-bot="facts"
      className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-[12px] gap-y-[4px] text-tiny leading-[1.5]"
    >
      {measured.length > 0 && (
        <>
          <dt className="text-faint">In these songs</dt>
          <dd className="m-0 text-muted">{measured.join(' · ')}</dd>
        </>
      )}
      {unknown.length > 0 && (
        <>
          <dt className="text-faint">Not known</dt>
          <dd className="m-0 text-muted">{unknown.join(' · ')}</dd>
        </>
      )}
    </dl>
  )
}

const panelClass =
  'grid gap-[8px] rounded-[8px] bg-warn-bg px-[11px] py-[9px] leading-[1.45] text-warn'

/** The one thing the card offers after a confirmation that did not go through. The usual
 *  actions are hidden meanwhile, so a second attempt cannot start before this one is settled. */
export function ProblemPanel() {
  const chat = useBotChat()
  const { problem } = chat
  if (!problem) return null
  const busy = chat.applying || chat.confirming
  if (problem.kind === 'stale')
    return (
      <div role="alert" data-bot="problem" className={panelClass}>
        <span>
          <strong className="font-semibold">This preview is out of date.</strong> Nothing was saved
          or queued, and no song was swapped. What changed:
        </span>
        <ul className="m-0 grid list-disc gap-[2px] pl-[18px]">
          {problem.changes.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <div>
          <Button disabled={busy} onClick={chat.resolveProblem}>
            <RefreshCw size={14} aria-hidden="true" />
            Refresh preview
          </Button>
        </div>
      </div>
    )
  if (problem.kind === 'unknown')
    return (
      <div role="alert" data-bot="problem" className={panelClass}>
        <span>
          <strong className="font-semibold">I can&rsquo;t tell if that went through.</strong>{' '}
          {problem.what === 'save'
            ? 'The playlist may or may not have been saved.'
            : 'Nothing has been added to your queue yet.'}{' '}
          Checking asks again with the same request, so it cannot be done twice.
        </span>
        <div>
          <Button disabled={busy} onClick={chat.resolveProblem}>
            <RefreshCw size={14} aria-hidden="true" />
            Check again
          </Button>
        </div>
      </div>
    )
  return (
    <div role="alert" data-bot="problem" className={panelClass}>
      <span>
        <strong className="font-semibold">This preview already went there.</strong>{' '}
        {problem.what === 'save'
          ? 'It was saved as a playlist before. Save another copy?'
          : 'It was added to your queue before. Add it again?'}
      </span>
      <div className="flex flex-wrap gap-[8px]">
        <Button variant="primary" disabled={busy} onClick={chat.resolveProblem}>
          Do it again
        </Button>
        <Button disabled={busy} onClick={chat.dismissProblem}>
          Not now
        </Button>
      </div>
    </div>
  )
}

/** The playlists saved from this revision, so a save is visible beside the button that made it. */
export function SavedLine() {
  const { savedAs } = useBotChat()
  if (!savedAs.length) return null
  return (
    <p
      role="status"
      className="m-0 flex items-center gap-[8px] rounded-[8px] border border-good-line bg-good-bg px-[11px] py-[8px] leading-[1.4] text-good"
    >
      <Check size={16} aria-hidden="true" className="shrink-0" />
      <span>Saved to your playlists: {savedAs.map((name) => `“${name}”`).join(', ')}</span>
    </p>
  )
}
