import { useEffect, useRef, useState } from 'react'

import { useNavigate, useRouterState } from '@tanstack/react-router'
import { Search } from 'lucide-react'

import { useNowPlayingPopout } from './now-playing-popout'
import { usePlayer } from './player'

const pages = [
  { label: 'Search music', to: '/search' },
  { label: 'Library', to: '/library' },
  { label: 'Now Playing', to: '/now-playing' },
  { label: 'Downloads', to: '/downloads' },
  { label: 'Settings', to: '/settings' },
  { label: 'Change theme', to: '/settings/user' },
  { label: 'Diagnostics', to: '/diagnostics' },
] as const

type Command = { label: string; run: () => void }

const commandClassName =
  'rounded-md border-0 bg-transparent p-[10px] text-left text-inherit hover:bg-active focus-visible:bg-active'

export function CommandPalette() {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const navigate = useNavigate()
  const onStage = useRouterState({ select: (state) => state.location.pathname === '/now-playing' })
  const popout = useNowPlayingPopout()
  const { libraryTrack } = usePlayer()

  const showStage = () => {
    if (!onStage) void navigate({ to: '/now-playing' })
  }

  // Presets are only visible on the visualizer, so the commands that act on
  // it switch the stage to it first. Everything goes through the provider's
  // state; it owns what the browser remembers.
  const showVisualizer = () => {
    showStage()
    if (popout.view !== 'visualizer') popout.toggleView()
  }

  const cycle = (delta: number) => {
    showVisualizer()
    popout.cyclePreset(delta)
  }

  const fullscreenVisualizer = () => {
    showVisualizer()
    const stage = popout.dockedStage.current
    if (stage) {
      // Already mounted, so ask now, while the click still counts as a gesture.
      stage
        .requestFullscreen()
        .catch(() => popout.setNotice('Press F on the player for full screen.'))

      return
    }
    // Not on screen (another route, or playing in the popout). The provider closes the popout,
    // navigates, and asks once the stage mounts. If that is refused the user is still on Now
    // Playing with a notice, which is the fallback to plain navigation.
    popout.popoutToFullscreen()
  }
  // No WebGPU means the stage only ever shows artwork, and with no library track loaded Now
  // Playing has no stage, so in both cases these would do nothing.
  const visualizerCommands: Command[] =
    popout.canVisualize && libraryTrack
      ? [
          {
            label: 'Toggle visualizer',
            // From another route the stage is out of sight, so a toggle there could land on Now
            // Playing with the visualizer just switched off. Arriving always shows it; toggling
            // is for when the stage is already in front.
            run: () => (onStage ? popout.toggleView() : showVisualizer()),
          },
          { label: 'Next visualizer preset', run: () => cycle(1) },
          { label: 'Previous visualizer preset', run: () => cycle(-1) },
          { label: 'Fullscreen visualizer', run: fullscreenVisualizer },
        ]
      : []
  const commands: Command[] = [
    ...pages.map((page) => ({ label: page.label, run: () => void navigate({ to: page.to }) })),
    ...visualizerCommands,
  ]
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
            key={command.label}
            className={commandClassName}
            onClick={() => {
              dialog.current?.close()
              command.run()
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
