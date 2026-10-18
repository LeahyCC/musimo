import { Link } from '@tanstack/react-router'

import { HOME_SECTIONS, useHomeSections, useLayout } from '../../lib/layout'
import { ClassicHome } from './classic-home'
import { RoomHome } from './room-home'
import { useLibraryState } from './use-home-data'
import { Welcome } from './welcome'

/**
 * The Home dashboard at `/`. An empty library gets the first-run steps instead; otherwise the
 * layout from Settings › Yours picks how the sections Settings › Yours leaves on are drawn.
 */
export function HomePage() {
  const layout = useLayout()
  const sections = useHomeSections()
  const library = useLibraryState()

  if (library === 'loading') return <h1 className="sr-only">Home</h1>
  if (library === 'empty') return <Welcome />

  return (
    <>
      {layout === 'room' ? <RoomHome sections={sections} /> : <ClassicHome sections={sections} />}
      {HOME_SECTIONS.every((key) => !sections[key]) && (
        <p className="text-muted">
          Every Home section is turned off.{' '}
          <Link to="/settings/user" className="text-accent">
            Turn some back on in Settings
          </Link>
          .
        </p>
      )}
    </>
  )
}
