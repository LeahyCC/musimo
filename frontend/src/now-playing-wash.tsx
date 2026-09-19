import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'

import { sampleCover } from './cover-color'
import { cx } from './cx'
import type { Rgb } from './theme/color'
import { useTheme } from './theme/store'
import { leavingStyle, useLeaving } from './use-leaving'
import { washFor } from './wash'

// The cover's color once it has been read. The last one stays while the next is being read, so the
// wash does not blink off between tracks; it fades from one to the other when the new one lands.
// Any failure reads as no color, and no color is no wash.
function useCoverColor(art: string): Rgb | null {
  const [color, setColor] = useState<Rgb | null>(null)

  useEffect(() => {
    if (!art) {
      setColor(null)

      return undefined
    }
    let current = true
    sampleCover(art)
      .then((sampled) => {
        if (current) setColor(sampled)
      })
      .catch(() => {
        if (current) setColor(null)
      })

    return () => {
      current = false
    }
  }, [art])

  return color
}

// One flat wash, strongest at the top and gone by the bottom. The color is a runtime value handed
// over as a custom property, so no color is written in this file.
function WashLayer({ color, leaving }: { color: string; leaving?: boolean }) {
  return (
    <div
      className={cx(
        'absolute inset-0 bg-linear-to-b from-(--now-wash) to-transparent',
        leaving && 'leaving',
      )}
      style={{ '--now-wash': color, ...(leaving ? leavingStyle : {}) } as CSSProperties}
    />
  )
}

/**
 * A soft wash behind the Now Playing page, taken from the cover. It covers the content area under
 * the top bar and beside the sidebar, and sits behind the page: negative stacking order, no
 * pointer events, and hidden from assistive technology. `washFor` mixes the cover into the theme's
 * canvas until the text on it still reads, so it changes with the theme as well as the cover.
 */
export function NowPlayingWash({ art }: { art: string }) {
  const theme = useTheme()
  const cover = useCoverColor(art)
  const wash = useMemo(() => (cover ? washFor(cover, theme.colors) : null), [cover, theme])
  const leaving = useLeaving(wash)

  return (
    <div
      aria-hidden="true"
      data-now-playing-wash={wash ?? ''}
      className="pointer-events-none fixed top-[calc(var(--topbar-height)+var(--safe-top))] right-0 bottom-0 left-[calc(var(--sidebar-width)+var(--safe-left))] -z-10 max-phone:left-0"
    >
      {wash && <WashLayer color={wash} />}
      {leaving?.value && <WashLayer color={leaving.value} leaving />}
    </div>
  )
}
