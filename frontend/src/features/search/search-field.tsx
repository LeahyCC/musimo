import { useEffect, useRef, useState } from 'react'

import { useNavigate, useRouterState } from '@tanstack/react-router'
import { Search } from 'lucide-react'

import { isLinkText, useLinkSheet } from '../links/links'
import { validateSearch } from './search-params'

/**
 * The search box that sits in the Listening room's Search page. The room has no search in its top
 * bar, so the page carries one. Classic's search is its top bar's box at every width, so Classic
 * does not render this.
 *
 * It does what the top bar's box does: the query goes to the URL after a short pause, and a pasted
 * link opens the link sheet instead of being searched.
 */
export function SearchField() {
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
        className="mb-[14px] flex h-[52px] items-center gap-[12px] rounded-[14px] border border-line-strong bg-sunken px-[14px] text-faint"
        onSubmit={(event) => {
          event.preventDefault()
          clearTimeout(debounce.current)
          if (links.submit(text)) return
          go(text)
        }}
      >
        <Search size={19} aria-hidden="true" />
        <input
          type="search"
          className="min-w-0 flex-1 border-0 bg-transparent text-[17px] text-text outline-0 placeholder:text-faint"
          aria-label="Search the catalog"
          placeholder="Search the catalog or paste a link"
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
        <span className="font-mono text-tiny whitespace-nowrap text-faint max-phone:hidden">
          DEEZER · LIBRARY-AWARE
        </span>
      </form>
      {links.sheet}
    </>
  )
}
