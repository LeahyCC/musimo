import type { ReactNode } from 'react'

import { LockKeyhole } from 'lucide-react'

import { cx } from '../../lib/cx'
import { useLayout } from '../../lib/layout'

/* The frame every Server setting sits in, drawn for the layout that is on. Classic is a bordered
   card with its title across the top. The Listening room puts the title and a line about it on
   the left, and the rows in a card on the right. What goes inside is the same in both. */

/** One section of the Server page. `id` is the anchor the section index and `/settings#library` use. */
export function SettingsSection({
  id,
  title,
  description,
  children,
}: {
  id: string
  title: string
  description: string
  children: ReactNode
}) {
  const room = useLayout() === 'room'
  const heading = `${id}-heading`

  if (room) {
    return (
      <section
        id={id}
        aria-labelledby={heading}
        className="flex scroll-mt-[115px] flex-wrap gap-x-[32px] gap-y-[12px]"
      >
        <div className="min-w-[180px] flex-[0_1_220px]">
          <h2 id={heading} className="text-strong">
            {title}
          </h2>
          <p className="mt-[6px] text-small leading-[1.5] text-muted">{description}</p>
        </div>
        <div
          data-ui="card"
          className="min-w-0 flex-[1_1_380px] self-start rounded-[16px] bg-raised"
        >
          {children}
        </div>
      </section>
    )
  }

  return (
    <section
      id={id}
      aria-labelledby={heading}
      data-ui="card"
      className="scroll-mt-[115px] overflow-hidden rounded-[14px] border border-line bg-sunken"
    >
      <div className="border-b border-line px-[20px] py-[16px]">
        <h2 id={heading} className="text-strong">
          {title}
        </h2>
        <p className="mt-[4px] text-small text-muted">{description}</p>
      </div>
      {children}
    </section>
  )
}

/**
 * A row's box: the padding and the line between it and the next one. Anything that belongs in a
 * section but is not one setting, such as the scan panel, uses it too so the lines stay even.
 */
export function SettingsBlock({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={cx(
        'border-b border-line px-[18px] py-[14px] last:border-b-0 max-phone:px-[14px]',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** "Set by environment": the value comes from a container variable, so this page cannot change it. */
export function LockBadge({ origin }: { origin: string }) {
  const room = useLayout() === 'room'

  return (
    <span
      title={`Set by ${origin}`}
      className={cx(
        'inline-flex items-center gap-[4px] rounded-sm bg-warn-bg px-[6px] py-[2px] text-warn',
        room ? 'font-mono text-caption' : 'text-tiny font-medium',
      )}
    >
      <LockKeyhole size={11} aria-hidden="true" />
      {room ? 'ENV' : 'Set by environment'}
      <span className="sr-only"> ({origin})</span>
    </span>
  )
}

/**
 * One setting: its label, a line of help and the control, which sits on the right and drops
 * under the text on a narrow screen. `detail` is anything that belongs with the help text, such
 * as the naming preview or a note that the value changed elsewhere.
 */
export function SettingRow({
  htmlFor,
  label,
  help,
  lockedBy = '',
  detail,
  children,
  control = 'field',
}: {
  htmlFor: string
  label: string
  help?: ReactNode
  /** The environment variable that holds this value, or "" when Settings may change it. */
  lockedBy?: string
  detail?: ReactNode
  /** The control. */
  children: ReactNode
  /** `switch` keeps the control its own size. A field takes the room it is given. */
  control?: 'field' | 'switch'
}) {
  return (
    <SettingsBlock className="flex flex-wrap items-center gap-x-[24px] gap-y-[10px]">
      <div className="min-w-0 flex-[1_1_240px]">
        <div className="flex flex-wrap items-center gap-[8px]">
          <label htmlFor={htmlFor} className="text-body font-medium">
            {label}
          </label>
          {lockedBy && <LockBadge origin={lockedBy} />}
        </div>
        {help && <p className="mt-[3px] text-small leading-[1.5] text-muted">{help}</p>}
        {detail}
      </div>
      <div
        className={cx(
          control === 'switch'
            ? 'flex-none'
            : 'min-w-[180px] flex-[0_1_280px] max-phone:flex-[1_1_100%]',
        )}
      >
        {children}
      </div>
    </SettingsBlock>
  )
}
