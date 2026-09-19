import type { KeyboardEvent } from 'react'

import { cx } from '../cx'

export type TabItem<Id extends string> = { id: Id; label: string }

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
  className,
}: TabListProps<Id>) {
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
      className={cx('flex gap-[22px] border-b border-line', className)}
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
              '-mb-px border-0 border-b-2 bg-transparent px-[2px] py-[10px] text-body font-medium coarse:min-h-11',
              selected
                ? 'border-accent text-text'
                : 'border-transparent text-muted hover:text-text',
            )}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
