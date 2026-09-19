import type { ReactNode, RefObject } from 'react'

import { X } from 'lucide-react'

import { cx } from './cx'
import { IconButton, textLinkClassName } from './ui'

export const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

/**
 * The bottom sheet on a phone and the centred dialog on a desktop, shared by every screen that
 * asks the person to review a download before it is queued: the artist's releases and a
 * pasted link. A native modal `<dialog>`, so Escape closes it and focus stays inside.
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
      className={cx(
        'm-auto w-[min(700px,calc(100%-32px))] max-h-[85dvh] overscroll-contain rounded-[16px] border border-line bg-raised p-[24px] text-text',
        'backdrop:bg-scrim/60',
        'max-phone:inset-x-0 max-phone:top-auto max-phone:bottom-0 max-phone:m-0 max-phone:w-full max-phone:max-w-none max-phone:max-h-[calc(100dvh-24px)] max-phone:rounded-t-[18px] max-phone:rounded-b-none max-phone:border-b-0 max-phone:p-[16px] max-phone:pb-[calc(16px+var(--safe-bottom))]',
      )}
      aria-labelledby={titleId}
      onClose={onClose}
    >
      <header className="mb-[18px] flex items-start justify-between gap-[20px] max-phone:mb-[12px] max-phone:gap-[12px]">
        <div className="min-w-0">
          <p className="mb-[12px] text-micro font-semibold tracking-[2px] text-faint [overflow-wrap:anywhere] max-phone:text-caption">
            {eyebrow}
          </p>
          <h2
            id={titleId}
            ref={titleRef}
            tabIndex={-1}
            className="outline-none max-phone:text-section"
          >
            {title}
          </h2>
        </div>
        <IconButton
          aria-label={closeLabel}
          disabled={closeDisabled}
          onClick={() => dialogRef.current?.close()}
        >
          <X size={22} />
        </IconButton>
      </header>
      {children}
      <footer className="sticky bottom-[-24px] border-t border-line bg-raised py-[16px] before:pointer-events-none before:absolute before:-top-[29px] before:inset-x-0 before:h-[28px] before:bg-[linear-gradient(transparent,var(--color-raised))] before:content-[''] max-phone:bottom-[calc(-16px-var(--safe-bottom))] max-phone:pb-[calc(16px+var(--safe-bottom))]">
        {footer}
      </footer>
    </dialog>
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

export function FormatSelect({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <label className={optionClassName}>
      Format
      <select
        className={selectClassName}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="original">Original source quality</option>
        <option value="m4a">M4A / AAC</option>
        <option value="opus">Opus</option>
        <option value="mp3">MP3 · converted</option>
      </select>
    </label>
  )
}

export function TargetSelect({
  value,
  onChange,
  disabled,
  disks,
}: {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  disks: { path: string; writable: boolean }[]
}) {
  return (
    <label className={optionClassName}>
      Download to
      <select
        className={selectClassName}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {disks.map((disk) => (
          <option key={disk.path} value={disk.path} disabled={!disk.writable}>
            {disk.path}
            {disk.writable ? '' : ' (read-only)'}
          </option>
        ))}
      </select>
    </label>
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

/** One tickable line of a sheet's list: artwork, a title, a detail line and an optional badge. */
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
    <label className="flex cursor-pointer items-center gap-[12px] border-b border-line py-[12px] coarse:min-h-11">
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
          className="h-[44px] w-[44px] shrink-0 rounded-md object-cover"
        />
      )}
      <span className="grid min-w-0 flex-1 gap-[6px]">
        <strong className="text-body [overflow-wrap:anywhere]">{title}</strong>
        <small className="text-tiny text-muted [overflow-wrap:anywhere]">{detail}</small>
      </span>
      {badge}
    </label>
  )
}
