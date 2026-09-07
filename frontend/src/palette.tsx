import { useEffect, useRef, useState } from 'react'

import { useNavigate } from '@tanstack/react-router'
import { Search } from 'lucide-react'

const commands = [
  { label: 'Search music', to: '/search' },
  { label: 'Library settings', to: '/settings' },
  { label: 'Downloads', to: '/downloads' },
  { label: 'Diagnostics', to: '/diagnostics' },
] as const
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
      className="command-palette"
      aria-label="Command palette"
      onClick={(e) => {
        if (e.target === dialog.current) dialog.current?.close()
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          dialog.current?.close()
          void navigate({ to: '/search', search: { q: text } })
        }}
      >
        <Search size={20} />
        <input
          ref={input}
          aria-label="Search commands or music"
          value={text}
          placeholder="Search commands or music…"
          onChange={(e) => setText(e.target.value)}
        />
        <button type="button" onClick={() => dialog.current?.close()}>
          Esc
        </button>
      </form>
      <div>
        {options.map((command) => (
          <button
            key={command.to}
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
            onClick={() => {
              dialog.current?.close()
              void navigate({ to: '/search', search: { q: text } })
            }}
          >
            Search music for “{text}”
          </button>
        )}
      </div>
      <small>Tab to choose · Enter to open · Esc to close</small>
    </dialog>
  )
}
