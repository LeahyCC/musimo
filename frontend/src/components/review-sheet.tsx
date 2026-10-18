import { useId } from 'react'
import type { ReactNode, RefObject } from 'react'

import { X } from 'lucide-react'

import { cx } from '../lib/cx'
import { IconButton, textLinkClassName } from '../ui'

export const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

/**
 * The look every overlay shares: a native modal `<dialog>` hung from the top of the screen on a
 * desktop and sat on the bottom edge as a sheet on a phone, over a blurred backdrop. Escape closes
 * it and the browser hands focus back to whatever opened it. `open:flex` rather than `flex`, so a
 * closed dialog stays hidden.
 */
export function overlayDialogClassName(width: 'palette' | 'sheet') {
  return cx(
    'fixed inset-x-0 top-[12vh] mx-auto my-0 max-h-[min(640px,calc(100dvh-120px))] overflow-hidden overscroll-contain rounded-[16px] border border-line-strong bg-raised p-0 text-text',
    'shadow-[0_30px_80px_color-mix(in_oklab,var(--color-shadow)_60%,transparent)] open:flex open:flex-col',
    'backdrop:bg-scrim/55 backdrop:backdrop-blur-[3px]',
    width === 'palette' ? 'w-[min(640px,calc(100%-32px))]' : 'w-[min(520px,calc(100%-32px))]',
    'max-phone:inset-x-0 max-phone:top-auto max-phone:bottom-0 max-phone:m-0 max-phone:w-full max-phone:max-w-none max-phone:max-h-[88dvh] max-phone:rounded-t-[20px] max-phone:rounded-b-none max-phone:border-b-0',
  )
}

/** The small mono caption above a sheet's title. */
export const eyebrowClassName =
  'font-mono text-caption font-semibold tracking-[0.06em] text-faint uppercase [overflow-wrap:anywhere]'

/** The side padding of a sheet's header, body and footer. */
export const sheetPaddingClassName = 'px-[18px] max-phone:px-[16px]'

/**
 * A native modal dialog shared by every screen that asks the person to review a download before
 * it is queued: the artist's releases and a pasted link. A header, a body that scrolls, and a
 * footer that stays in view.
 */
export function ReviewDialog({
  dialogRef,
  titleId,
  titleRef,
  eyebrow,
  title,
  closeLabel,
  closeDisabled,
  onClose,
  footer,
  children,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>
  titleId: string
  /** Lets a caller move focus to the heading when the sheet's content changes underneath it. */
  titleRef?: RefObject<HTMLHeadingElement | null>
  eyebrow: string
  title: string
  closeLabel: string
  closeDisabled?: boolean
  onClose: () => void
  footer: ReactNode
  children: ReactNode
}) {
  return (
    <dialog
      ref={dialogRef}
      className={overlayDialogClassName('sheet')}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current && !closeDisabled) dialogRef.current?.close()
      }}
    >
      <header
        className={cx(
          'flex flex-none items-center justify-between gap-[10px] border-b border-line py-[14px]',
          sheetPaddingClassName,
        )}
      >
        <div className="min-w-0">
          <p className={eyebrowClassName}>{eyebrow}</p>
          <h2
            id={titleId}
            ref={titleRef}
            tabIndex={-1}
            className="mt-[4px] text-section font-semibold outline-none [overflow-wrap:anywhere]"
          >
            {title}
          </h2>
        </div>
        <IconButton
          aria-label={closeLabel}
          disabled={closeDisabled}
          onClick={() => dialogRef.current?.close()}
        >
          <X size={20} />
        </IconButton>
      </header>
      <div
        className={cx(
          'min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain py-[16px]',
          sheetPaddingClassName,
        )}
      >
        {children}
      </div>
      <footer
        className={cx(
          'flex flex-none flex-wrap items-center justify-end gap-[10px] border-t border-line bg-sunken py-[12px] max-phone:pb-[calc(12px+var(--safe-bottom))] [&>[role=alert]]:basis-full',
          sheetPaddingClassName,
        )}
      >
        {footer}
      </footer>
    </dialog>
  )
}

/**
 * The plain facts about a download (where it lands, in what format), as a two-column list. A row
 * with a control passes `htmlFor` so its label names the control.
 */
export function ReviewFacts({ children }: { children: ReactNode }) {
  return (
    <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-[18px] gap-y-[10px] rounded-[12px] bg-canvas p-[14px] text-body">
      {children}
    </dl>
  )
}

export function Fact({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <>
      <dt className="text-faint">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="flex items-center coarse:min-h-11">
            {label}
          </label>
        ) : (
          label
        )}
      </dt>
      <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">{children}</dd>
    </>
  )
}

/** The row of format and destination choices under a sheet's summary. */
export function ReviewOptions({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-[16px] text-body max-phone:gap-[10px_16px]">
      {children}
    </div>
  )
}

const optionClassName = 'flex max-w-full min-w-0 items-center gap-[8px] coarse:min-h-11'
const selectClassName =
  'min-w-0 max-w-full rounded-md border border-line bg-canvas p-[8px] text-inherit coarse:min-h-11 coarse:text-base'

/** In a facts list the control sits on the canvas panel, so it takes the sunken fill instead. */
const factSelectClassName = selectClassName.replace('bg-canvas', 'bg-sunken')

type SelectFieldProps = {
  label: string
  /** Set to draw the select as a row of a `ReviewFacts` list, with `label` as the row's name. */
  fact?: boolean
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  children: ReactNode
}

function SelectField({ label, fact, value, onChange, disabled, children }: SelectFieldProps) {
  const id = useId()
  const select = (
    <select
      id={id}
      className={fact ? factSelectClassName : selectClassName}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {children}
    </select>
  )
  if (fact)
    return (
      <Fact label={label} htmlFor={id}>
        {select}
      </Fact>
    )

  return (
    <label className={optionClassName} htmlFor={id}>
      {label}
      {select}
    </label>
  )
}

export function FormatSelect({
  value,
  onChange,
  disabled,
  fact,
}: {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  fact?: boolean
}) {
  return (
    <SelectField label="Format" fact={fact} value={value} onChange={onChange} disabled={disabled}>
      <option value="original">Original source quality</option>
      <option value="m4a">M4A / AAC</option>
      <option value="opus">Opus</option>
      <option value="mp3">MP3 · converted</option>
    </SelectField>
  )
}

export function TargetSelect({
  value,
  onChange,
  disabled,
  disks,
  fact,
}: {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  disks: { path: string; writable: boolean }[]
  fact?: boolean
}) {
  return (
    <SelectField
      label={fact ? 'Folder' : 'Download to'}
      fact={fact}
      value={value}
      onChange={onChange}
      disabled={disabled}
    >
      {disks.map((disk) => (
        <option key={disk.path} value={disk.path} disabled={!disk.writable}>
          {disk.path}
          {disk.writable ? '' : ' (read-only)'}
        </option>
      ))}
    </SelectField>
  )
}

export function SelectAllNone({
  onAll,
  onNone,
  disabled,
}: {
  onAll: () => void
  onNone: () => void
  disabled?: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-[16px]">
      {(
        [
          ['Select all', onAll],
          ['Select none', onNone],
        ] as const
      ).map(([label, onClick]) => (
        <button
          key={label}
          type="button"
          data-ui="text-link"
          className={textLinkClassName()}
          disabled={disabled}
          onClick={onClick}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

/** One tickable line of a sheet's list: a check, artwork, a title, a detail line and a trailing slot. */
export function ReviewRow({
  checked,
  disabled,
  onChange,
  art,
  title,
  detail,
  badge,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  art?: string
  title: string
  detail: string
  badge?: ReactNode
}) {
  return (
    <label
      className={cx(
        'flex cursor-pointer items-center gap-[12px] rounded-[10px] px-[8px] py-[8px] hover:bg-hover coarse:min-h-11',
        disabled && 'opacity-45',
      )}
    >
      <input
        type="checkbox"
        className="shrink-0 accent-accent coarse:h-[20px] coarse:w-[20px]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {art && (
        <img
          src={art}
          alt=""
          loading="lazy"
          className="h-[40px] w-[40px] shrink-0 rounded-[6px] object-cover"
        />
      )}
      <span className="grid min-w-0 flex-1 gap-[2px]">
        <strong className="text-body font-medium [overflow-wrap:anywhere]">{title}</strong>
        <small className="text-small text-muted [overflow-wrap:anywhere]">{detail}</small>
      </span>
      {badge}
    </label>
  )
}
