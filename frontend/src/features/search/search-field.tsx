import { useEffect, useRef, useState } from 'react'

import { useNavigate, useRouterState } from '@tanstack/react-router'
import { Search } from 'lucide-react'

import { cx } from '../../lib/cx'
import { isLinkText, useLinkSheet } from '../links/links'
import { validateSearch } from './search-params'

/**
 * The search box that sits in the page. Classic keeps its search in the top bar on a desktop, so
 * this one shows only on a phone, where that bar is gone. The Listening room has no top bar
 * search, so there it is always shown, larger.
 *
 * It does what the top bar's box does: the query goes to the URL after a short pause, and a pasted
 * link opens the link sheet instead of being searched.
 */
export function SearchField({ room }: { room: boolean }) {
  const navigate = useNavigate()
  const searchStr = useRouterState({ select: (state) => state.location.searchStr })
  const urlQuery = new URLSearchParams(searchStr).get('q') ?? ''
  const [text, setText] = useState(urlQuery)
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // The last text this box sent to the URL. A URL change that is only that coming back must not
  // overwrite what has been typed since.
  const pushed = useRef(urlQuery)
  const links = useLinkSheet()

  useEffect(() => {
    if (urlQuery === pushed.current) return
    pushed.current = urlQuery
    clearTimeout(debounce.current)
    setText(urlQuery)
  }, [urlQuery])
  useEffect(() => () => clearTimeout(debounce.current), [])

  const go = (value: string) => {
    pushed.current = value
    void navigate({
      to: '/search',
      search: { ...validateSearch(Object.fromEntries(new URLSearchParams(searchStr))), q: value },
    })
  }

  return (
    <>
      <form
        role="search"
        data-ui="search-field"
        className={cx(
          'items-center text-faint',
          room
            ? 'mb-[14px] flex h-[52px] gap-[12px] rounded-[14px] border border-line-strong bg-sunken px-[14px]'
            : 'mb-[16px] hidden h-[44px] gap-[10px] rounded-[10px] border border-line bg-sunken px-[12px] max-phone:flex',
        )}
        onSubmit={(event) => {
          event.preventDefault()
          clearTimeout(debounce.current)
          if (links.submit(text)) return
          go(text)
        }}
      >
        <Search size={room ? 19 : 18} aria-hidden="true" />
        <input
          type="search"
          className={cx(
            'min-w-0 flex-1 border-0 bg-transparent text-text outline-0 placeholder:text-faint',
            room ? 'text-[17px]' : 'text-[16px]',
          )}
          aria-label="Search the catalog"
          placeholder={room ? 'Search the catalog or paste a link' : 'Search or paste a link'}
          value={text}
          onPaste={(event) => {
            clearTimeout(debounce.current)
            links.paste(event, setText)
          }}
          onChange={(event) => {
            const value = event.target.value
            setText(value)
            clearTimeout(debounce.current)
            // A link opens its review sheet when pasted or submitted, and is never searched.
            if (isLinkText(value)) return
            debounce.current = setTimeout(() => go(value), 200)
          }}
        />
        {room && (
          <span className="font-mono text-tiny whitespace-nowrap text-faint max-phone:hidden">
            DEEZER · LIBRARY-AWARE
          </span>
        )}
      </form>
      {links.sheet}
    </>
  )
}
