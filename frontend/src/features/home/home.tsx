import { useNavigate } from '@tanstack/react-router'

import { PageTitle } from '../../components/page-title'
import { HomeShelves } from '../search/home-shelves'

/**
 * The Home dashboard at `/`. For now it holds the shelves the search page already shows, so the
 * page is not empty; the Home dashboard card replaces it with the sections from Settings › Yours.
 */
export function HomePage() {
  const navigate = useNavigate()

  return (
    <>
      <PageTitle eyebrow="YOUR MUSIC, AT HOME" title="Home" />
      <HomeShelves onSearch={(q) => void navigate({ to: '/search', search: { q } })} />
    </>
  )
}
