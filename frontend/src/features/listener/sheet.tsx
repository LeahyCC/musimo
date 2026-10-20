import { createContext, useContext, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'

import { useNavigate, useRouterState } from '@tanstack/react-router'
import { Check } from 'lucide-react'
import { z } from 'zod'

import { api, ApiError } from '../../api'
import { overlayDialogClassName, sheetPaddingClassName } from '../../components/review-sheet'
import { cx } from '../../lib/cx'
import { Button, Field } from '../../ui'
import {
  commitListener,
  dropListener,
  LISTENER_CHANGED,
  listenerId,
  listenerName,
  nowPlayingLeftBehind,
  playlistLeftBehind,
  rememberListenerName,
} from './identity'
import { nameError } from './names'

const listenerSchema = z.object({ id: z.string(), name: z.string() })
const listenersSchema = z.object({ items: z.array(listenerSchema) })
type Listener = z.infer<typeof listenerSchema>

type ListenerUi = { name: string; open: () => void }

const ListenerUiContext = createContext<ListenerUi>({ name: '', open: () => undefined })

export function useListenerUi() {
  return useContext(ListenerUiContext)
}

/**
 * The name sheet. It sits in front of the shell until a name is chosen, and opens again from the
 * name in the sidebar or the top bar. One sheet for Classic, the phone, and the Listening room.
 */
export function ListenerGate({ children }: { children: ReactNode }) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [nameId, setNameId] = useState(listenerId)
  const [name, setName] = useState(listenerName)
  const [open, setOpen] = useState(() => listenerId() === '')
  const [items, setItems] = useState<Listener[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const pathRef = useRef(pathname)
  pathRef.current = pathname
  const navigate = useNavigate()
  const blocking = nameId === ''
  const showForm = creating || items?.length === 0

  useEffect(() => {
    const onChange = (event: Event) => {
      const loaded = event instanceof CustomEvent && event.detail?.loaded === true
      const path = pathRef.current
      setNameId(listenerId())
      setName(listenerName())
      setOpen(listenerId() === '')
      setCreating(false)
      setDraft('')
      setReason('')
      if (playlistLeftBehind(path)) void navigate({ to: '/library/playlists' })
      else if (nowPlayingLeftBehind(path, loaded)) void navigate({ to: '/' })
    }
    window.addEventListener(LISTENER_CHANGED, onChange)
    return () => window.removeEventListener(LISTENER_CHANGED, onChange)
  }, [navigate])

  useEffect(() => {
    let gone = false
    void api('listeners', listenersSchema)
      .then((data) => {
        if (gone) return
        setItems(data.items)
        const id = listenerId()
        const found = data.items.find((item) => item.id === id)
        if (id && !found) {
          void dropListener().then(() => {
            if (gone) return
            setNameId('')
            setName('')
            setOpen(true)
          })

          return
        }

        if (found && found.name !== listenerName()) {
          rememberListenerName(found.name)
          setName(found.name)
        }
      })
      .catch(() => {
        if (gone) return
        setItems((current) => {
          if (current) return current
          const id = listenerId()
          const known = listenerName()
          return id && known ? [{ id, name: known }] : []
        })
      })

    return () => {
      gone = true
    }
  }, [])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  function closeIfAllowed() {
    if (!blocking) setOpen(false)
  }

  async function pick(item: Listener) {
    if (item.id === listenerId()) {
      setOpen(false)
      return
    }
    setBusy(true)
    setReason('')
    try {
      await commitListener(item.id, item.name)
    } catch (error) {
      setReason(error instanceof Error ? error.message : 'That name could not be opened.')
    } finally {
      setBusy(false)
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault()
    const problem = nameError(
      draft,
      (items ?? []).map((item) => item.name),
    )
    if (problem) {
      setReason(problem)
      return
    }
    setBusy(true)
    setReason('')
    try {
      const made = await api('listeners', listenerSchema, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: draft.trim() }),
      })
      setItems((current) =>
        current?.some((item) => item.id === made.id) ? current : [...(current ?? []), made],
      )
      await commitListener(made.id, made.name)
    } catch (error) {
      setReason(error instanceof ApiError ? error.message : 'That name could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  const title = name && !blocking ? `Listening as ${name}` : 'Who is listening?'

  return (
    <ListenerUiContext.Provider
      value={{
        name,
        open: () => {
          setOpen(true)
        },
      }}
    >
      <div inert={blocking ? true : undefined}>{children}</div>
      <dialog
        ref={dialogRef}
        className={overlayDialogClassName('sheet')}
        aria-labelledby={titleId}
        onCancel={(event) => {
          if (blocking) event.preventDefault()
        }}
        onClose={closeIfAllowed}
        onClick={(event) => {
          if (event.target === dialogRef.current && !blocking) dialogRef.current?.close()
        }}
      >
        <header className={cx('border-b border-line py-[14px]', sheetPaddingClassName)}>
          <h2 id={titleId} className="text-section font-semibold">
            {title}
          </h2>
        </header>
        <div
          className={cx(
            'flex min-h-0 flex-col gap-[12px] overflow-y-auto py-[16px]',
            'max-phone:pb-[calc(16px+var(--safe-bottom))]',
            sheetPaddingClassName,
          )}
        >
          {items === null ? (
            <p className="text-body text-muted">Loading names…</p>
          ) : (
            items.length > 0 && (
              <ul className="flex flex-col gap-[4px]">
                {items.map((item) => {
                  const current = item.id === nameId
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-[10px] rounded-[8px] px-[10px] py-[8px] text-left text-body hover:bg-hover"
                        aria-current={current ? 'true' : undefined}
                        disabled={busy}
                        onClick={() => void pick(item)}
                      >
                        <span className="min-w-0 flex-1 truncate">{item.name}</span>
                        {current && (
                          <>
                            <span className="sr-only">Current</span>
                            <Check size={16} aria-hidden="true" />
                          </>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )
          )}
          {showForm ? (
            <form className="flex flex-col gap-[10px]" onSubmit={(event) => void create(event)}>
              <label className="flex flex-col gap-[6px] text-small text-muted">
                Name
                <Field
                  value={draft}
                  invalid={Boolean(reason)}
                  aria-describedby={reason ? `${titleId}-reason` : undefined}
                  disabled={busy}
                  autoComplete="nickname"
                  onChange={(event) => {
                    setDraft(event.target.value)
                    setReason('')
                  }}
                />
              </label>
              {reason && (
                <p id={`${titleId}-reason`} role="alert" className="text-small text-danger">
                  {reason}
                </p>
              )}
              <Button type="submit" variant="primary" disabled={busy}>
                Create
              </Button>
            </form>
          ) : (
            items !== null && (
              <Button type="button" disabled={busy} onClick={() => setCreating(true)}>
                Create a new name
              </Button>
            )
          )}
          {!showForm && reason && (
            <p role="alert" className="text-small text-danger">
              {reason}
            </p>
          )}
        </div>
      </dialog>
    </ListenerUiContext.Provider>
  )
}
