import type { ReactNode } from 'react'

import { ArrowDownWideNarrow, Plus, Search, X } from 'lucide-react'

import { cx } from '../../lib/cx'
import type { Layout } from '../../lib/layout'
import { FilterChip, SelectChip, textLinkClassName } from '../../ui'
import { FacetChip, LayoutToggle, type ViewMode } from './collection-items'
import type { useLibraryBrowse } from './library-browse'
import type { LibraryTab } from './library-params'
import { defaultLibrarySort } from './library-params'

export type BrowseTab = Exclude<LibraryTab, 'home'>
export const browseTabs: readonly BrowseTab[] = ['albums', 'artists', 'tracks', 'playlists']

const tabLabels: Record<BrowseTab, string> = {
  albums: 'Albums',
  artists: 'Artists',
  tracks: 'Tracks',
  playlists: 'Playlists',
}

/** What each view's count is called when it is printed on its own. */
const countNouns: Record<BrowseTab, string> = {
  albums: 'albums',
  artists: 'artists',
  tracks: 'songs',
  playlists: 'playlists',
}

export type TabCounts = Partial<Record<BrowseTab, number>>
type Browse = ReturnType<typeof useLibraryBrowse>
type Option = { value: string; label: string }

const showOptions: Option[] = [
  { value: '', label: 'All artists' },
  { value: 'favourites', label: 'Favourites' },
  { value: 'played', label: 'Played' },
  { value: 'unplayed', label: 'Never played' },
]
const visibilityOptions: Option[] = [
  { value: 'all', label: 'All' },
  { value: 'public', label: 'Public' },
  { value: 'private', label: 'Private' },
]

/**
 * What opens a library page. Classic prints the view's name with its count and the page's main
 * actions, and on a phone adds a row of chips to switch view (the sidebar does that on a wide
 * screen). The Listening room has one Library page with a strip of views, each with its count.
 */
export function LibraryHeading({
  shell,
  tab,
  counts,
  onOpen,
  actions,
}: {
  shell: Layout
  tab: BrowseTab
  counts: TabCounts
  onOpen: (tab: BrowseTab) => void
  actions?: ReactNode
}) {
  const count = counts[tab]
  const countText =
    count === undefined
      ? ''
      : tab === 'playlists'
        ? `${count.toLocaleString()} ${count === 1 ? 'playlist' : 'playlists'} · Liked always comes first`
        : `${count.toLocaleString()} ${countNouns[tab]}`

  if (shell === 'room')
    return (
      <>
        <h1 className="sr-only">Library</h1>
        <nav
          aria-label="Library views"
          className="mb-[16px] flex gap-[4px] overflow-x-auto rounded-[14px] bg-sunken p-[4px]"
        >
          {browseTabs.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={tab === item}
              onClick={() => onOpen(item)}
              className={cx(
                'flex h-[38px] flex-[1_0_auto] items-center justify-center gap-[8px] rounded-[10px] border-0 px-[14px] text-body font-semibold coarse:min-h-11',
                tab === item ? 'bg-active text-text' : 'bg-transparent text-muted hover:text-text',
              )}
            >
              {tabLabels[item]}
              {counts[item] !== undefined && (
                <span className="font-mono text-tiny font-normal text-faint">
                  {counts[item]?.toLocaleString()}
                </span>
              )}
            </button>
          ))}
        </nav>
        {actions && <div className="library-list-actions mb-[16px] flex gap-[8px]">{actions}</div>}
      </>
    )

  return (
    <>
      <div className="mb-[18px] flex flex-wrap items-end justify-between gap-[16px] max-phone:mb-[12px]">
        <div className="min-w-0">
          <h1 className="m-0 text-display font-semibold tracking-[-0.7px] max-phone:text-heading">
            {tabLabels[tab]}
          </h1>
          {countText && <p className="mt-[6px] mb-0 text-body text-muted">{countText}</p>}
        </div>
        {actions && <div className="library-list-actions flex gap-[8px]">{actions}</div>}
      </div>
      <nav
        aria-label="Library views"
        className="mb-[14px] -mx-[16px] hidden gap-[6px] overflow-x-auto px-[16px] [scrollbar-width:none] max-phone:flex"
      >
        {browseTabs.map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={tab === item}
            onClick={() => onOpen(item)}
            className={cx(
              'h-[36px] flex-none rounded-pill border px-[14px] text-body font-medium coarse:min-h-11',
              tab === item
                ? 'border-good-line bg-active text-text'
                : 'border-line bg-transparent text-muted',
            )}
          >
            {tabLabels[item]}
          </button>
        ))}
      </nav>
    </>
  )
}

export function SearchField({
  browse,
  noun,
  room,
  className,
}: {
  browse: Browse
  noun: string
  room: boolean
  className?: string
}) {
  return (
    <label
      className={cx(
        'flex h-[36px] items-center gap-[8px] px-[11px] text-faint coarse:min-h-11',
        room ? 'rounded-[10px] bg-sunken' : 'rounded-[8px] border border-line bg-sunken',
        className,
      )}
    >
      <Search size={15} className="flex-none" />
      <input
        className="w-full min-w-0 flex-1 border-0 bg-transparent p-0 text-body text-text outline-0 coarse:text-base"
        aria-label={`Search ${noun}`}
        value={browse.query}
        onChange={(event) => browse.setQuery(event.target.value)}
        placeholder={room ? 'Filter' : `Search ${noun}`}
      />
      {browse.query && (
        <button
          type="button"
          className="grid place-items-center border-0 bg-none p-[4px] text-muted coarse:min-h-11 coarse:min-w-11"
          aria-label="Clear search"
          onClick={() => browse.setQuery('')}
        >
          <X size={15} />
        </button>
      )}
    </label>
  )
}

/** The Listening room's sort button: icon and current order, with the platform's own picker underneath. */
function SortButton({
  value,
  options,
  onChange,
}: {
  value: string
  options: Option[]
  onChange: (value: string) => void
}) {
  return (
    <span className="relative inline-flex h-[36px] shrink-0 items-center gap-[6px] rounded-[10px] px-[10px] text-body whitespace-nowrap text-text has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-solid coarse:min-h-11">
      <ArrowDownWideNarrow aria-hidden="true" size={15} />
      <span aria-hidden="true">{options.find((option) => option.value === value)?.label}</span>
      <select
        aria-label="Sort"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="absolute inset-0 cursor-pointer appearance-none opacity-0 coarse:text-base"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  )
}

/** A dashed "+ Show" pill that picks one value from a native list, for a filter that is not on yet. */
function AddSelect({
  label,
  options,
  onChange,
}: {
  label: string
  options: Option[]
  onChange: (value: string) => void
}) {
  return (
    <span className="relative inline-flex shrink-0 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-solid rounded-pill">
      <span
        data-ui="add-chip"
        aria-hidden="true"
        className="inline-flex h-[32px] items-center gap-[6px] rounded-pill border border-dashed border-line-strong px-[11px] text-small whitespace-nowrap text-muted coarse:min-h-11"
      >
        <Plus size={13} />
        {label}
      </span>
      <select
        aria-label={label}
        value=""
        onChange={(event) => onChange(event.target.value)}
        className="absolute inset-0 cursor-pointer appearance-none opacity-0 coarse:text-base"
      >
        <option value="" disabled>
          {label}
        </option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  )
}

/**
 * The wide-screen toolbar for the browse views. Classic lays out 36px select chips. The Listening
 * room shows the filters that are on as removable chips, the ones that are off as dashed "+" pills,
 * then a sort button and the grid or list switch. Both write to the address through `browse`.
 */
export function LibraryToolbar({
  shell,
  tab,
  browse,
  sorts,
  genres,
  years,
  facetsShown,
  view,
  onView,
  loadedText,
}: {
  shell: Layout
  tab: BrowseTab
  browse: Browse
  sorts: Option[]
  genres: string[]
  years: string[]
  facetsShown: boolean
  view: ViewMode
  onView: (view: ViewMode) => void
  loadedText: string
}) {
  const room = shell === 'room'
  const filtering =
    browse.genres.length > 0 ||
    browse.years.length > 0 ||
    Boolean(browse.show) ||
    browse.visibility !== 'all'
  const noun = tab
  const showArtists = tab === 'artists'
  const showPlaylists = tab === 'playlists'
  const sortDefault = defaultLibrarySort(tab)
  const count = (
    <span className="library-count text-small whitespace-nowrap text-muted">{loadedText}</span>
  )

  if (!room)
    return (
      <div className="mb-[22px] flex flex-wrap items-center gap-[8px]">
        <SearchField
          browse={browse}
          noun={noun}
          room={false}
          className="max-w-[340px] flex-[1_1_220px]"
        />
        <SelectChip
          label="Sort"
          value={browse.sort}
          defaultValue={sortDefault}
          options={sorts}
          onChange={browse.setSort}
        />
        {showArtists && (
          <SelectChip
            label="Show"
            value={browse.show}
            defaultValue=""
            options={showOptions}
            onChange={browse.setShow}
          />
        )}
        {showPlaylists && (
          <SelectChip
            label="Show"
            value={browse.visibility}
            defaultValue="all"
            options={visibilityOptions}
            onChange={browse.setVisibility}
          />
        )}
        {facetsShown && (
          <>
            <FacetChip
              room={false}
              label="Genre"
              options={genres}
              selected={browse.genres}
              onToggle={browse.toggleGenre}
            />
            <FacetChip
              room={false}
              label="Year"
              options={years}
              selected={browse.years}
              onToggle={browse.toggleYear}
            />
          </>
        )}
        {filtering && (
          <button
            type="button"
            data-ui="text-link"
            className={textLinkClassName('px-[5px] py-[9px]')}
            onClick={browse.clearFilters}
          >
            Clear filters
          </button>
        )}
        <div className="ml-auto flex items-center gap-[10px]">
          {count}
          {tab !== 'tracks' && <LayoutToggle layout={view} onChange={onView} />}
        </div>
      </div>
    )

  const activeShow = showOptions.find((option) => option.value === browse.show && option.value)
  const activeVisibility = visibilityOptions.find(
    (option) => option.value === browse.visibility && option.value !== 'all',
  )
  return (
    <div className="mb-[20px] flex flex-wrap items-center gap-[8px]">
      <SearchField browse={browse} noun={noun} room className="max-w-[300px] flex-[1_1_200px]" />
      {browse.genres.map((value) => (
        <FilterChip
          key={`genre-${value}`}
          label="Genre"
          value={value}
          onRemove={() => browse.toggleGenre(value)}
        />
      ))}
      {browse.years.map((value) => (
        <FilterChip
          key={`year-${value}`}
          label="Year"
          value={value}
          onRemove={() => browse.toggleYear(value)}
        />
      ))}
      {activeShow && (
        <FilterChip label="Show" value={activeShow.label} onRemove={() => browse.setShow('')} />
      )}
      {activeVisibility && (
        <FilterChip
          label="Show"
          value={activeVisibility.label}
          onRemove={() => browse.setVisibility('all')}
        />
      )}
      {facetsShown && (
        <>
          <FacetChip
            room
            label="Genre"
            options={genres}
            selected={browse.genres}
            onToggle={browse.toggleGenre}
          />
          <FacetChip
            room
            label="Year"
            options={years}
            selected={browse.years}
            onToggle={browse.toggleYear}
          />
        </>
      )}
      {showArtists && !activeShow && (
        <AddSelect label="Show" options={showOptions.slice(1)} onChange={browse.setShow} />
      )}
      {showPlaylists && !activeVisibility && (
        <AddSelect
          label="Show"
          options={visibilityOptions.slice(1)}
          onChange={browse.setVisibility}
        />
      )}
      <div className="ml-auto flex items-center gap-[10px]">
        {count}
        <SortButton value={browse.sort} options={sorts} onChange={browse.setSort} />
        {tab !== 'tracks' && <LayoutToggle layout={view} onChange={onView} />}
      </div>
    </div>
  )
}
