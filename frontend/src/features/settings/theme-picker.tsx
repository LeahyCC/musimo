import { Check, Download, Moon, Pencil, Sun, Trash2 } from 'lucide-react'

import { cx } from '../../lib/cx'
import type { ThemeFamily } from '../../theme/follow-system'
import type { ColorScheme, Theme } from '../../theme/themes'
import { Button } from '../../ui'

/* The theme cards. A built-in family is one card with its dark and light halves side by side and
   a moon and a sun to choose between them. A theme of the person's own is a card of its own, with
   Edit, Export and Delete. Every theme is still one radio in one group, so the arrow keys walk
   them and a screen reader hears "Slate light" rather than "sun". */

const cardClassName = (active: boolean) =>
  cx(
    'flex flex-col gap-[10px] rounded-[14px] border-2 bg-canvas p-[8px] text-text',
    active ? 'border-accent' : 'border-line hover:border-good-line',
  )

const focusRingClassName =
  'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-solid'

/** The tick and the word, so the active card is not marked by its border color alone. */
function ActiveMark() {
  return (
    <>
      <Check size={13} className="shrink-0 text-accent" aria-hidden="true" />
      <span className="sr-only">Active</span>
    </>
  )
}

/** One half of a family's picture: its page, a card on it and its accent. */
function Half({ theme, grow }: { theme: Theme; grow: boolean }) {
  return (
    <span
      className={cx(
        'flex items-end gap-[5px] p-[7px] transition-[flex-grow] motion-reduce:transition-none',
        grow ? 'grow-3' : 'grow',
      )}
      style={{ background: theme.colors['--color-canvas'], flexBasis: 0 }}
    >
      <i
        className="h-[55%] flex-1 rounded-sm"
        style={{ background: theme.colors['--color-raised'] }}
      />
      <i
        className="size-[14px] flex-none rounded-full"
        style={{ background: theme.colors['--color-accent'] }}
      />
    </span>
  )
}

export function ThemeFamilyCard({
  family,
  active,
  mode,
  following,
  onPick,
}: {
  family: ThemeFamily
  /** This family is the one on screen. */
  active: boolean
  /** The half the card leans towards: the one on screen, or the last one chosen for this family. */
  mode: ColorScheme
  /** Follow system is on, so the device picks the half and the moon and sun are for show. */
  following: boolean
  onPick: (theme: Theme, scheme: ColorScheme) => void
}) {
  const halves = [
    { theme: family.dark, Icon: Moon },
    { theme: family.light, Icon: Sun },
  ] as const

  return (
    <div className={cardClassName(active)}>
      <button
        type="button"
        aria-label={`Use ${family[mode].name}`}
        aria-pressed={active}
        className="block rounded-[9px] p-0 text-left"
        onClick={() => onPick(family[mode], mode)}
      >
        <span className="flex h-[64px] overflow-hidden rounded-[9px]">
          <Half theme={family.dark} grow={mode === 'dark'} />
          <Half theme={family.light} grow={mode === 'light'} />
        </span>
      </button>
      <div className="flex items-center gap-[8px]">
        <span className="flex min-w-0 flex-1 items-center gap-[6px] text-body font-semibold [overflow-wrap:anywhere]">
          {family.name}
          {active && <ActiveMark />}
        </span>
        <div className={cx('flex rounded-lg bg-hover p-[2px]', following && 'opacity-40')}>
          {halves.map(({ theme, Icon }) => {
            const chosen = active && mode === theme.scheme
            return (
              <label
                key={theme.id}
                className={cx(
                  'relative grid h-[24px] w-[28px] cursor-pointer place-items-center rounded-md coarse:size-11',
                  chosen ? 'bg-line-strong text-text' : 'text-faint hover:text-text',
                  following && 'cursor-not-allowed',
                  focusRingClassName,
                )}
              >
                <input
                  type="radio"
                  name="theme"
                  value={theme.id}
                  aria-label={theme.name}
                  className="absolute inset-0 m-0 size-full cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed"
                  checked={chosen}
                  disabled={following}
                  onChange={() => onPick(theme, theme.scheme)}
                />
                <Icon size={13} aria-hidden="true" />
              </label>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export function CustomThemeCard({
  theme,
  active,
  onPick,
  onEdit,
  onExport,
  onDelete,
}: {
  theme: Theme
  active: boolean
  onPick: () => void
  onEdit: () => void
  onExport: () => void
  onDelete: () => void
}) {
  return (
    <div className={cardClassName(active)}>
      <label
        className={cx(
          'relative flex cursor-pointer flex-col gap-[10px] rounded-[9px]',
          focusRingClassName,
        )}
      >
        <input
          type="radio"
          name="theme"
          value={theme.id}
          aria-label={theme.name}
          className="absolute inset-0 m-0 size-full cursor-pointer appearance-none opacity-0"
          checked={active}
          onChange={onPick}
        />
        <span
          aria-hidden="true"
          className="flex h-[64px] items-end gap-[5px] rounded-[9px] p-[7px]"
          style={{ background: theme.colors['--color-canvas'] }}
        >
          <i
            className="h-[55%] flex-1 rounded-sm"
            style={{ background: theme.colors['--color-raised'] }}
          />
          <i
            className="size-[14px] flex-none rounded-full"
            style={{ background: theme.colors['--color-accent'] }}
          />
        </span>
        <span className="flex items-center gap-[6px] text-body font-semibold [overflow-wrap:anywhere]">
          {theme.name}
          {active && <ActiveMark />}
        </span>
      </label>
      <div className="flex flex-wrap gap-[8px]">
        <Button aria-label={`Edit ${theme.name}`} onClick={onEdit}>
          <Pencil size={14} />
          Edit
        </Button>
        <Button aria-label={`Export ${theme.name}`} onClick={onExport}>
          <Download size={14} />
          Export
        </Button>
        <Button variant="danger" aria-label={`Delete ${theme.name}`} onClick={onDelete}>
          <Trash2 size={14} />
          Delete
        </Button>
      </div>
    </div>
  )
}
