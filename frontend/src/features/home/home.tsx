import { Link, useNavigate } from '@tanstack/react-router'
import { Activity, Settings2 } from 'lucide-react'

import { PageTitle } from '../../components/page-title'
import { iconButtonClassName } from '../../ui'
import { HomeShelves } from '../search/home-shelves'

/**
 * The Home dashboard at `/`. For now it holds the shelves the search page already shows, so the
 * page is not empty; the Home dashboard card replaces it with the sections from Settings › Yours.
 */
export function HomePage() {
  const navigate = useNavigate()

  return (
    <>
      <PageTitle eyebrow="YOUR MUSIC, AT HOME" title="Home">
        {/* The phone's tab bar has no room for Settings and Diagnostics, so Home carries them. */}
        <div className="hidden gap-[4px] max-phone:flex">
          <Link
            to="/settings"
            data-ui="icon-button"
            aria-label="Settings"
            className={iconButtonClassName(false, undefined, 'compact', 'outlined')}
          >
            <Settings2 size={18} />
          </Link>
          <Link
            to="/diagnostics"
            data-ui="icon-button"
            aria-label="Diagnostics"
            className={iconButtonClassName(false, undefined, 'compact', 'outlined')}
          >
            <Activity size={18} />
          </Link>
        </div>
      </PageTitle>
      <HomeShelves onSearch={(q) => void navigate({ to: '/search', search: { q } })} />
    </>
  )
}
