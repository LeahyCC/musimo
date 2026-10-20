import { cx } from '../../lib/cx'
import { useListenerUi } from './sheet'

/**
 * The phone's way to the name sheet: the name's first letter in a circle, where a desktop prints the
 * whole name. The circle is 32px to look at and 44px to tap. Nothing shows before a name is chosen.
 */
export function ListenerAvatar({ className }: { className?: string }) {
  const listener = useListenerUi()
  if (!listener.name) return null
  // The first character as a person sees it: a flag, an accented letter written as two code
  // points, or a family emoji is one character, not its first piece.
  const first = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    .segment(listener.name.trim())
    [Symbol.iterator]()
    .next().value?.segment
  const initial = first?.toLocaleUpperCase() ?? '?'
  return (
    <button
      type="button"
      className={cx('-ml-[6px] grid size-[44px] shrink-0 place-items-center', className)}
      aria-label={`Listening as ${listener.name}`}
      onClick={listener.open}
    >
      <span
        aria-hidden="true"
        className="grid size-[32px] place-items-center rounded-full bg-accent text-lead font-semibold text-accent-ink"
      >
        {initial}
      </span>
    </button>
  )
}
