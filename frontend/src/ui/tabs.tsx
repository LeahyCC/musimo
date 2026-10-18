import type { KeyboardEvent } from 'react'

import { cx } from '../lib/cx'

/**
 * `count` draws a pill after the label. A phone hides the pill to keep a row of tabs on one line,
 * and the tab's name still says it, e.g. "Queue (3)".
 */
export type TabItem<Id extends string> = { id: Id; label: string; count?: number }

/** The ids a tab and its panel point at each other with, from one shared prefix. */
export const tabId = (base: string, id: string) => `${base}-tab-${id}`
export const tabPanelId = (base: string, id: string) => `${base}-panel-${id}`

type TabListProps<Id extends string> = {
  /** Names the list for assistive tech. */
  label: string
  /** The prefix `tabId` and `tabPanelId` build from. */
  idBase: string
  tabs: readonly TabItem<Id>[]
  value: Id
  onChange: (id: Id) => void
  /** `underline` is Classic's row over a rule; `pill` is the Listening room's rounded group. */
  variant?: 'underline' | 'pill'
  className?: string
}

/**
 * The tab row of the ARIA tabs pattern. Only the selected tab is in the tab order; the arrow keys,
 * Home and End move between tabs and select as they land. The caller draws the panels, each with
 * `role="tabpanel"`, `id={tabPanelId(idBase, id)}` and `aria-labelledby={tabId(idBase, id)}`.
 */
export function TabList<Id extends string>({
  label,
  idBase,
  tabs,
  value,
  onChange,
  variant = 'underline',
  className,
}: TabListProps<Id>) {
  const pill = variant === 'pill'

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Alt and the arrows are the browser's Back and Forward.
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const current = tabs.findIndex((tab) => tab.id === value)
    const last = tabs.length - 1
    let target: number
    switch (event.key) {
      case 'ArrowRight':
        target = current >= last ? 0 : current + 1
        break
      case 'ArrowLeft':
        target = current <= 0 ? last : current - 1
        break
      case 'Home':
        target = 0
        break
      case 'End':
        target = last
        break
      default:
        return
    }
    const next = tabs[target]
    if (!next) return
    event.preventDefault()
    onChange(next.id)
    // The button is already in the document, so focus can move before the state has settled.
    event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[target]?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      data-ui="tab-list"
      data-variant={variant}
      className={cx(
        pill
          ? 'flex w-max max-w-full gap-[4px] overflow-x-auto rounded-pill bg-text/8 p-[3px]'
          : 'flex gap-[22px] border-b border-line',
        className,
      )}
      onKeyDown={onKeyDown}
    >
      {tabs.map((tab) => {
        const selected = tab.id === value
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={tabId(idBase, tab.id)}
            aria-selected={selected}
            aria-controls={tabPanelId(idBase, tab.id)}
            tabIndex={selected ? 0 : -1}
            data-ui="tab"
            className={cx(
              pill
                ? cx(
                    'h-[30px] shrink-0 rounded-pill border-0 px-[13px] text-small font-medium whitespace-nowrap coarse:min-h-11',
                    selected ? 'bg-text text-canvas' : 'bg-transparent text-muted hover:text-text',
                  )
                : cx(
                    '-mb-px border-0 border-b-2 bg-transparent px-[2px] py-[10px] text-body font-medium whitespace-nowrap coarse:min-h-11',
                    selected
                      ? 'border-accent text-text'
                      : 'border-transparent text-muted hover:text-text',
                  ),
            )}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
            {tab.count !== undefined && (
              <>
                <span
                  aria-hidden="true"
                  className={cx(
                    'ml-[7px] inline-grid h-[18px] min-w-[20px] place-items-center rounded-pill px-[6px] text-tiny max-phone:hidden',
                    selected ? 'bg-accent text-accent-ink' : 'bg-hover text-muted',
                  )}
                >
                  {tab.count}
                </span>
                <span className="sr-only"> ({tab.count})</span>
              </>
            )}
          </button>
        )
      })}
    </div>
  )
}
