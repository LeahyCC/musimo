import { SourceMark } from '../../components/source-mark'
import { Field } from '../../ui'

// A text button is shorter than a finger. On a touch screen it gets the 44px floor.
const orderButtonClassName =
  'text-muted underline disabled:opacity-40 coarse:inline-flex coarse:min-h-11 coarse:min-w-11 coarse:items-center coarse:justify-center'

const catalogOrderLabels: Record<string, string> = {
  deezer: 'Deezer account',
  youtube: 'YouTube',
  soundcloud: 'SoundCloud',
}

export function CatalogOrder({
  order,
  tries,
  triesLocked,
  triesOrigin,
  laps,
  lapsLocked,
  lapsOrigin,
  orderLocked,
  orderOrigin,
  changedElsewhere,
  deezerOn,
  hasCookie,
  disabledSources,
  paused,
  disabled,
  onOrder,
  onTries,
  onLaps,
}: {
  order: string[]
  tries: number
  triesLocked: boolean
  triesOrigin: string
  laps: number
  lapsLocked: boolean
  lapsOrigin: string
  orderLocked: boolean
  orderOrigin: string
  /** Names of this section's settings that someone saved elsewhere while this page was open. */
  changedElsewhere: string[]
  deezerOn: boolean
  hasCookie: boolean
  disabledSources: string[]
  paused: string[]
  disabled: boolean
  onOrder: (next: string[]) => void
  onTries: (next: number) => void
  onLaps: (next: number) => void
}) {
  const spare = Object.keys(catalogOrderLabels).filter((id) => !order.includes(id))
  const move = (index: number, step: number) => {
    const next = order.slice()
    const swap = index + step
    const item = next[index]
    const other = next[swap]
    if (item === undefined || other === undefined) return
    next[index] = other
    next[swap] = item
    onOrder(next)
  }
  const hardSkip = (id: string) =>
    (id === 'deezer' && !deezerOn) ||
    (id === 'deezer' && !hasCookie) ||
    disabledSources.includes(id)
  const skipReason = (id: string) => {
    if (id === 'deezer' && !deezerOn) return 'Account audio is off'
    if (disabledSources.includes(id)) return 'Turned off'
    if (id === 'deezer' && !hasCookie) return 'No cookie yet'
    if (paused.includes(id)) return 'Paused'
    return ''
  }
  const allSkipped = order.length > 0 && order.every((id) => skipReason(id))
  const waitingOnPause = allSkipped && order.some((id) => paused.includes(id) && !hardSkip(id))
  return (
    <div className="mt-[18px] border-b border-line pb-[16px]">
      <p className="text-body">
        Where a song from search is fetched
        {orderLocked ? <span className="text-warn"> · Locked by {orderOrigin}</span> : null}
      </p>
      <p className="mt-[7px] max-w-[420px] text-tiny text-muted">
        The top row goes first. A failure asks the next row. After the last row, start again. A
        search with no song moves on straight away.
      </p>
      <div className="mt-[14px] grid grid-cols-[1fr_80px] items-center gap-x-[16px] gap-y-[10px] max-phone:grid-cols-1">
        <label htmlFor="tries_per_source" className="text-small">
          Tries on one source before the next
          {triesLocked ? <span className="text-warn"> · Locked by {triesOrigin}</span> : null}
        </label>
        {/* Every keystroke is kept, as in the other number settings. A cleared box shows empty
            rather than 0, and `required` with the range stops a save outside 1 to 4. */}
        <Field
          id="tries_per_source"
          type="number"
          required
          min={1}
          max={4}
          disabled={disabled || triesLocked}
          value={tries || ''}
          onChange={(event) => onTries(Number(event.target.value))}
        />
        <label htmlFor="max_attempts" className="text-small">
          Times around the list
          {lapsLocked ? <span className="text-warn"> · Locked by {lapsOrigin}</span> : null}
        </label>
        <Field
          id="max_attempts"
          type="number"
          required
          min={1}
          max={4}
          disabled={disabled || lapsLocked}
          value={laps || ''}
          onChange={(event) => onLaps(Number(event.target.value))}
        />
      </div>
      <p className="mt-[10px] max-w-[420px] text-tiny text-muted">
        {tries >= 1 && tries <= 4 && laps >= 1 && laps <= 4
          ? `A failed download is tried ${tries} ${tries === 1 ? 'time' : 'times'} on that source, then the next one. The list is walked ${laps} ${laps === 1 ? 'time' : 'times'}. A pasted link or a podcast uses that same number as its retries.`
          : 'Both numbers run from 1 to 4.'}
      </p>
      {changedElsewhere.length > 0 && (
        <p className="mt-[10px] max-w-[420px] text-tiny text-warn">
          Changed elsewhere since you started: {changedElsewhere.join(', ')}. Saving keeps what is
          on this page.
        </p>
      )}
      {allSkipped && (
        <p className="mt-[10px] max-w-[420px] text-tiny text-warn">
          {waitingOnPause
            ? 'Every row that can run is paused. Songs wait until you resume one.'
            : 'Nothing in this list can run. A song from search fails until a row can.'}
        </p>
      )}
      <ol className="mt-[8px]">
        {order.map((id, index) => {
          const label = catalogOrderLabels[id] ?? id
          const reason = skipReason(id)
          return (
            <li key={id} className="flex items-center gap-[12px] py-[8px] text-small">
              <span className="w-[16px] text-muted">{index + 1}</span>
              <span className="min-w-0 flex-1">
                {label}
                {reason ? <span className="text-warn"> · {reason}</span> : null}
              </span>
              <button
                type="button"
                className={orderButtonClassName}
                aria-label={`Move ${label} up`}
                disabled={disabled || orderLocked || index === 0}
                onClick={() => move(index, -1)}
              >
                Up
              </button>
              <button
                type="button"
                className={orderButtonClassName}
                aria-label={`Move ${label} down`}
                disabled={disabled || orderLocked || index === order.length - 1}
                onClick={() => move(index, 1)}
              >
                Down
              </button>
              <button
                type="button"
                className={orderButtonClassName}
                aria-label={`Remove ${label}`}
                disabled={disabled || orderLocked || order.length === 1}
                onClick={() => onOrder(order.filter((item) => item !== id))}
              >
                Remove
              </button>
            </li>
          )
        })}
      </ol>
      {spare.length > 0 && (
        <div className="mt-[8px] flex flex-wrap gap-[12px]">
          {spare.map((id) => (
            <button
              key={id}
              type="button"
              className="text-small text-accent underline disabled:opacity-40 coarse:inline-flex coarse:min-h-11 coarse:items-center"
              disabled={disabled || orderLocked}
              onClick={() => onOrder([...order, id])}
            >
              Add {catalogOrderLabels[id]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function SourceRow({
  id,
  mark,
  label,
  note,
  on,
  disabled,
  lockedBy = '',
  onChange,
}: {
  id: string
  mark: string
  label: string
  note: string
  on: boolean
  disabled: boolean
  /** The environment variable that holds this switch, or "" when Settings may change it. */
  lockedBy?: string
  onChange: (on: boolean) => void
}) {
  return (
    <div className="flex items-center gap-[15px] border-b border-line py-[16px]">
      <SourceMark>{mark}</SourceMark>
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="text-body">
          {label}
          {lockedBy ? <span className="text-warn"> · Locked by {lockedBy}</span> : null}
        </label>
        <p className="mt-[4px] text-tiny text-muted">{note}</p>
      </div>
      <input
        id={id}
        type="checkbox"
        className="h-[18px] w-[18px] shrink-0 accent-accent coarse:h-[22px] coarse:w-[22px]"
        checked={on}
        disabled={disabled || lockedBy !== ''}
        onChange={(event) => onChange(event.target.checked)}
      />
    </div>
  )
}
