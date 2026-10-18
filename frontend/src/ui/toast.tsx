import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react'

import { cx } from '../lib/cx'

export type ToastTone = 'info' | 'good' | 'warn' | 'danger'

export type ToastAction = { label: string; run: () => void }

export type ToastInput = {
  tone: ToastTone
  text: string
  /** A toast with an action, such as Retry, stays until it is used or dismissed. */
  action?: ToastAction
}

type Toast = ToastInput & { id: number }

type ToastApi = {
  /** Shows a toast and returns a function that takes it away again. */
  show: (toast: ToastInput) => () => void
}

/** How long a toast without an action stays, unless a pointer or focus is on it. */
const HIDE_AFTER_MS = 6000
/** More than this and the oldest goes, so a burst of failures cannot fill the screen. */
const MAX_TOASTS = 3

const ToastContext = createContext<ToastApi | null>(null)

const toneClassNames: Record<ToastTone, string> = {
  info: 'border-line-strong bg-raised text-muted',
  good: 'border-good-line bg-good-bg text-good',
  warn: 'border-warn-line bg-warn-bg text-warn',
  danger: 'border-danger-line bg-danger-bg text-danger',
}

const toneIcons = { info: Info, good: CircleCheck, warn: TriangleAlert, danger: CircleAlert }

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [held, setHeld] = useState(false)
  const Icon = toneIcons[toast.tone]

  useEffect(() => {
    if (toast.action || held) return
    const timer = setTimeout(() => onDismiss(toast.id), HIDE_AFTER_MS)
    return () => clearTimeout(timer)
  }, [toast.id, toast.action, held, onDismiss])

  return (
    <div
      data-ui="toast"
      data-tone={toast.tone}
      className={cx(
        'pointer-events-auto flex items-center gap-[12px] rounded-lg border py-[10px] pr-[10px] pl-[14px] shadow-[0_14px_36px_color-mix(in_oklab,var(--color-shadow)_50%,transparent)]',
        toneClassNames[toast.tone],
      )}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <Icon aria-hidden="true" size={16} className="shrink-0" />
      <span className="flex-1 text-body text-text">{toast.text}</span>
      {toast.action && (
        <button
          type="button"
          className="h-[30px] shrink-0 rounded-[7px] border border-current bg-transparent px-[10px] text-small font-medium coarse:min-h-11"
          onClick={() => {
            toast.action?.run()
            onDismiss(toast.id)
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        className="grid size-[28px] shrink-0 place-items-center border-0 bg-transparent text-muted hover:text-text coarse:size-11"
        onClick={() => onDismiss(toast.id)}
      >
        <X aria-hidden="true" size={14} />
      </button>
    </div>
  )
}

/**
 * Short messages that are not tied to a spot on the page, such as a queue that could not be saved.
 * There is one `role="status"` region, always in the page so a screen reader is already listening
 * when the first toast arrives. It sits bottom right on a wide window and above the mini player on
 * a phone. Its edges are `--toast-right` and `--toast-bottom` in style.css. Each layout sets its own,
 * and Classic's follow `--player-height`, so it drops to the edge when the footer is hidden.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(0)

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const show = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++
      setToasts((current) => [...current, { ...input, id }].slice(-MAX_TOASTS))
      return () => dismiss(id)
    },
    [dismiss],
  )

  const api = useMemo(() => ({ show }), [show])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="status"
        data-ui="toast-region"
        className={cx(
          'pointer-events-none fixed right-[var(--toast-right)] bottom-[var(--toast-bottom)] z-toast grid w-[min(420px,calc(100%-40px))] gap-[8px]',
          'max-phone:right-[calc(12px+var(--safe-right))] max-phone:left-[calc(12px+var(--safe-left))] max-phone:w-auto',
        )}
      >
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (!api) throw new Error('useToast needs a ToastProvider above it')
  return api
}
