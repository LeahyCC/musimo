import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'

import { sampleCover } from './cover-color'
import { cx } from './cx'
import type { Rgb } from './theme/color'
import { useTheme } from './theme/store'
import { leavingStyle, useLeaving } from './use-leaving'
import { glowFor, washFor } from './wash'

// The cover's color once it has been read. The last one stays while the next is being read, so the
// wash and the glow do not blink off between tracks; they fade from one to the other when the new
// one lands. Any failure reads as no color, and no color is no wash and no glow.
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

// One halo the size of the stage: a solid fill the stage covers, and a soft shadow of the same color
// that spreads past its edge. The shadow reaches 24px (14px on a phone), which is less than the
// 26px the page leaves between the stage and the title under it, so it is gone before it gets to
// any text. Change one and the other has to follow.
function GlowLayer({ color, leaving }: { color: string; leaving?: boolean }) {
  return (
    <div
      className={cx(
        'absolute inset-0 rounded-[14px] bg-(color:--now-glow) shadow-[0_0_20px_4px_var(--now-glow)] max-phone:shadow-[0_0_12px_2px_var(--now-glow)]',
        leaving && 'leaving',
      )}
      style={{ '--now-glow': color, ...(leaving ? leavingStyle : {}) } as CSSProperties}
    />
  )
}

/**
 * A glow of the cover's color behind and around the docked stage, drawn where the page sets no text
 * on the canvas, so it is a good deal stronger than the wash (`glowFor`, a fixed mix). It is
 * placed by its parent, which sizes it to the stage through `className` and draws it before the
 * stage so the stage sits on top. It cross-fades on a track change like the wash, is a cut under
 * `prefers-reduced-motion`, and is not drawn at all while the cover's color is unknown.
 */
export function NowPlayingGlow({ art, className }: { art: string; className?: string }) {
  const theme = useTheme()
  const cover = useCoverColor(art)
  const glow = useMemo(() => (cover ? glowFor(cover, theme.colors) : null), [cover, theme])
  const leaving = useLeaving(glow)

  return (
    <div
      aria-hidden="true"
      data-now-playing-glow={glow ?? ''}
      className={cx('pointer-events-none absolute top-0 left-0 aspect-square', className)}
    >
      {glow && <GlowLayer color={glow} />}
      {leaving?.value && <GlowLayer color={leaving.value} leaving />}
    </div>
  )
}
