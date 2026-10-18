import { useId } from 'react'
import type { ReactNode } from 'react'

import { ChartColumn, Check, CirclePlay, Disc3, History, Repeat, Sparkles } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { cx } from '../../lib/cx'
import {
  HOME_SECTIONS,
  resetHomeSections,
  setHomeSection,
  setLayout,
  useHomeSections,
  useLayout,
} from '../../lib/layout'
import type { HomeSection, Layout } from '../../lib/layout'
import { sectionCaptionClassName, Switch } from '../../ui'

/* Layout and the Home page, the first two sections of Settings › Yours. Both are kept in this
   browser through `lib/layout.ts`, so a change lands at once, here and in any other open tab. */

const cardClassName = 'rounded-[16px] border border-line bg-sunken'

/** The heading block a card opens with: a title, a line about it, and something on the right. */
function CardHeading({
  id,
  title,
  description,
  children,
}: {
  id: string
  title: string
  description: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-[12px] gap-y-[6px]">
      <div>
        <h2 id={id} className="text-strong">
          {title}
        </h2>
        <p className="mt-[4px] text-small text-muted">{description}</p>
      </div>
      {children}
    </div>
  )
}

/** A few boxes in the shape of a layout, in theme colors, so each card shows what it will look like. */
function LayoutPreview({ layout }: { layout: Layout }) {
  const tile = 'aspect-square rounded-[3px] bg-active'

  if (layout === 'classic') {
    return (
      <div
        aria-hidden="true"
        className="flex aspect-video gap-[5px] overflow-hidden rounded-[9px] bg-sidebar p-[6px]"
      >
        <div className="flex w-[22%] flex-col gap-[4px] rounded-[4px] bg-raised p-[5px]">
          <i className="h-[5px] w-[60%] rounded-[2px] bg-accent" />
          <i className="h-[4px] rounded-[2px] bg-line-strong" />
          <i className="h-[4px] rounded-[2px] bg-line-strong" />
          <i className="h-[4px] rounded-[2px] bg-line-strong" />
        </div>
        <div className="flex flex-1 flex-col gap-[5px]">
          <i className="h-[9px] rounded-[3px] bg-raised" />
          <div className="grid flex-1 grid-cols-4 content-start gap-[4px]">
            <i className={tile} />
            <i className={tile} />
            <i className={tile} />
            <i className={tile} />
          </div>
          <i className="h-[12px] rounded-[3px] border-t-2 border-accent bg-hover" />
        </div>
      </div>
    )
  }

  return (
    <div
      aria-hidden="true"
      className="flex aspect-video gap-[5px] overflow-hidden rounded-[9px] bg-sidebar p-[6px]"
    >
      <div className="flex w-[9%] flex-col items-center gap-[4px] pt-[4px]">
        <i className="size-[8px] rounded-[3px] bg-accent" />
        <i className="size-[8px] rounded-[3px] bg-line-strong" />
        <i className="size-[8px] rounded-[3px] bg-line-strong" />
      </div>
      <div className="grid flex-1 grid-cols-3 content-start gap-[4px] rounded-[5px] bg-raised p-[5px]">
        <i className={tile} />
        <i className={tile} />
        <i className={tile} />
      </div>
      <div className="flex w-[28%] flex-col gap-[4px] rounded-[5px] bg-raised p-[5px]">
        <i className="aspect-square rounded-[3px] bg-[color-mix(in_oklab,var(--color-accent)_40%,var(--color-canvas))]" />
        <i className="h-[3px] w-[70%] rounded-[2px] bg-accent" />
        <i className="h-[3px] rounded-[2px] bg-line-strong" />
        <i className="h-[3px] rounded-[2px] bg-line-strong" />
      </div>
    </div>
  )
}

const LAYOUT_CARDS: readonly { value: Layout; name: string; description: string }[] = [
  {
    value: 'classic',
    name: 'Classic',
    description:
      'Sidebar with your library sections and pinned playlists. Player across the bottom.',
  },
  {
    value: 'room',
    name: 'Listening room',
    description: 'Slim icon rail. The player and Up next stay docked on the right.',
  },
]

/** Two cards, one radio each. Choosing one switches the app at once and keeps the page you are on. */
export function LayoutSection() {
  const layout = useLayout()
  const prefix = useId()

  return (
    <section
      aria-labelledby="layout"
      data-ui="card"
      className={cx(cardClassName, 'px-[20px] py-[18px]')}
    >
      <CardHeading
        id="layout"
        title="Layout"
        description="Changes how the app is arranged. Every screen and control is the same in both."
      >
        <span className={cx(sectionCaptionClassName, 'font-mono')}>SAVED IN THIS BROWSER</span>
      </CardHeading>
      <div className="mt-[16px] grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] gap-[12px]">
        {LAYOUT_CARDS.map(({ value, name, description }) => {
          const chosen = layout === value
          return (
            <label
              key={value}
              className={cx(
                'relative flex cursor-pointer flex-col gap-[12px] rounded-[14px] border-2 bg-canvas p-[12px] text-text',
                chosen ? 'border-accent' : 'border-line hover:border-good-line',
                'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-solid',
              )}
            >
              <input
                type="radio"
                name="layout"
                value={value}
                aria-label={name}
                aria-describedby={`${prefix}-${value}`}
                className="absolute inset-0 m-0 size-full cursor-pointer appearance-none opacity-0"
                checked={chosen}
                onChange={() => setLayout(value)}
              />
              <LayoutPreview layout={value} />
              <span className="flex items-start gap-[10px]">
                <span className="min-w-0 flex-1">
                  <span className="block text-lead font-semibold">{name}</span>
                  <span
                    id={`${prefix}-${value}`}
                    className="mt-[3px] block text-small leading-[1.5] text-muted"
                  >
                    {description}
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  className={cx(
                    'grid size-[20px] flex-none place-items-center rounded-full border-2 text-accent-ink',
                    chosen ? 'border-accent bg-accent' : 'border-line',
                  )}
                >
                  {chosen && <Check size={12} />}
                </span>
              </span>
            </label>
          )
        })}
      </div>
    </section>
  )
}

const HOME_ROWS: Record<HomeSection, { label: string; description: string; Icon: LucideIcon }> = {
  continue: {
    label: 'Continue listening',
    description: 'The track you left off on, with resume.',
    Icon: CirclePlay,
  },
  stats: {
    label: 'This week',
    description: 'Time listened, plays and top genre.',
    Icon: ChartColumn,
  },
  jump: {
    label: 'Jump back in',
    description: 'Recent albums, artists and playlists.',
    Icon: History,
  },
  fresh: {
    label: 'Recently added',
    description: 'The newest albums in your folders.',
    Icon: Disc3,
  },
  mostPlayed: {
    label: 'On repeat',
    description: 'Your most played songs this month.',
    Icon: Repeat,
  },
  octive: {
    label: 'Ask Octive',
    description: 'Prompts that build a queue from your library.',
    Icon: Sparkles,
  },
}

/** One switch per Home section. Hidden sections are still in the Library; this only tidies Home. */
export function HomeSectionsSection() {
  const shown = useHomeSections()
  const prefix = useId()
  const allShown = HOME_SECTIONS.every((key) => shown[key])

  return (
    <section
      aria-labelledby="home-page"
      data-ui="card"
      className={cx(cardClassName, 'overflow-hidden')}
    >
      <div className="px-[20px] pt-[18px] pb-[12px]">
        <CardHeading
          id="home-page"
          title="Home page"
          description="Choose what Home shows. Hidden sections are still in the Library."
        >
          <button
            type="button"
            className="text-small text-muted underline disabled:no-underline disabled:opacity-50 coarse:min-h-11 coarse:px-[8px]"
            disabled={allShown}
            onClick={resetHomeSections}
          >
            Show all
          </button>
        </CardHeading>
      </div>
      {HOME_SECTIONS.map((key) => {
        const { label, description, Icon } = HOME_ROWS[key]
        const on = shown[key]
        return (
          <label
            key={key}
            className="flex cursor-pointer items-center gap-[14px] border-t border-line px-[20px] py-[12px] hover:bg-raised"
          >
            <span
              className={cx(
                'grid size-[34px] flex-none place-items-center rounded-[9px] bg-hover',
                on ? 'text-accent' : 'text-faint',
              )}
            >
              <Icon size={16} aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span
                id={`${prefix}-${key}`}
                className={cx('block text-body font-medium', !on && 'text-muted')}
              >
                {label}
              </span>
              <span id={`${prefix}-${key}-note`} className="mt-[2px] block text-small text-muted">
                {description}
              </span>
            </span>
            <Switch
              checked={on}
              aria-labelledby={`${prefix}-${key}`}
              aria-describedby={`${prefix}-${key}-note`}
              onChange={(event) => setHomeSection(key, event.target.checked)}
            />
          </label>
        )
      })}
    </section>
  )
}
