import { useEffect, useRef, useState } from 'react'

import { useNavigate } from '@tanstack/react-router'
import { Search } from 'lucide-react'

const commands = [
  { label: 'Search music', to: '/search' },
  { label: 'Library', to: '/library' },
  { label: 'Now Playing', to: '/now-playing' },
  { label: 'Downloads', to: '/downloads' },
  { label: 'Settings', to: '/settings' },
  { label: 'Change theme', to: '/settings/user' },
  { label: 'Diagnostics', to: '/diagnostics' },
] as const

const commandClassName =
  'rounded-md border-0 bg-transparent p-[10px] text-left text-inherit hover:bg-active focus-visible:bg-active'

export function CommandPalette() {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const navigate = useNavigate()
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setText('')
        dialog.current?.showModal()
        input.current?.focus()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  const options = commands.filter((command) =>
    command.label.toLowerCase().includes(text.toLowerCase()),
  )
  return (
    <dialog
      ref={dialog}
      // `command-palette` carries the handwritten ::backdrop rule.
      className="command-palette fixed top-[20vh] mx-auto my-0 w-[min(560px,92vw)] rounded-[14px] border border-[color:var(--line-hover)] bg-raised p-[18px] text-text shadow-[0_20px_90px_color-mix(in_oklab,var(--color-shadow)_60%,transparent)]"
      aria-label="Command palette"
      onClick={(e) => {
        if (e.target === dialog.current) dialog.current?.close()
      }}
    >
      <form
        className="flex items-center gap-[12px] border-b border-line pb-[18px]"
        onSubmit={(e) => {
          e.preventDefault()
          dialog.current?.close()
          void navigate({ to: '/search', search: { q: text } })
        }}
      >
        <Search size={20} />
        <input
          ref={input}
          className="min-w-0 flex-1 border-0 bg-transparent p-[8px] text-inherit"
          aria-label="Search commands or music"
          value={text}
          placeholder="Search commands or music…"
          onChange={(e) => setText(e.target.value)}
        />
        <button type="button" className={commandClassName} onClick={() => dialog.current?.close()}>
          Esc
        </button>
      </form>
      <div className="flex flex-col gap-[4px] py-[15px]">
        {options.map((command) => (
          <button
            key={command.to}
            className={commandClassName}
            onClick={() => {
              dialog.current?.close()
              void navigate({ to: command.to })
            }}
          >
            {command.label}
          </button>
        ))}
        {text.length >= 2 && (
          <button
            className={commandClassName}
            onClick={() => {
              dialog.current?.close()
              void navigate({ to: '/search', search: { q: text } })
            }}
          >
            Search music for “{text}”
          </button>
        )}
      </div>
      <small className="text-muted">Tab to choose · Enter to open · Esc to close</small>
    </dialog>
  )
}
