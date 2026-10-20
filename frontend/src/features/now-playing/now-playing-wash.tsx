import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'

import { cx } from '../../lib/cx'
import { leavingStyle, useLeaving } from '../../lib/use-leaving'
import type { Rgb } from '../../theme/color'
import { useTheme } from '../../theme/store'
import { sampleCover } from './cover-color'
import { glowFor, tintFor, washFor } from './wash'

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

/** Where the wash is drawn: behind the whole page (Classic), or inside the Listening room's card. */
type WashPlace = 'page' | 'card'

// One flat wash. On the page it is strongest at the top and gone by the bottom; in the room's card
// it spreads from the top left, where the artwork sits, into the canvas. The color is a runtime
// value handed over as a custom property, so no color is written in this file.
function WashLayer({
  color,
  place,
  leaving,
}: {
  color: string
  place: WashPlace
  leaving?: boolean
}) {
  return (
    <div
      className={cx(
        'absolute inset-0',
        place === 'page'
          ? 'bg-linear-to-b from-(--now-wash) to-transparent'
          : 'bg-[radial-gradient(90%_120%_at_15%_10%,var(--now-wash)_0%,var(--now-wash)_35%,var(--color-canvas)_100%)]',
        leaving && 'leaving',
      )}
      style={{ '--now-wash': color, ...(leaving ? leavingStyle : {}) } as CSSProperties}
    />
  )
}

/**
 * A soft wash taken from the cover. On the page (`place="page"`) it covers the content area under
 * the top bar and beside the sidebar and sits behind the page; in the Listening room it fills its
 * parent, the stage card, which has to be `relative` and `isolate`. Either way it has no pointer
 * events and is hidden from assistive technology. `washFor` mixes the cover into the theme's
 * canvas until the text on it still reads, so it changes with the theme as well as the cover, and
 * the card's text keeps the same contrast the page's does.
 */
export function NowPlayingWash({ art, place = 'page' }: { art: string; place?: WashPlace }) {
  const theme = useTheme()
  const cover = useCoverColor(art)
  const wash = useMemo(() => (cover ? washFor(cover, theme.colors) : null), [cover, theme])
  const leaving = useLeaving(wash)

  return (
    <div
      aria-hidden="true"
      data-now-playing-wash={wash ?? ''}
      className={cx(
        'pointer-events-none -z-10',
        place === 'page'
          ? 'fixed top-[calc(var(--topbar-height)+var(--safe-top))] right-0 bottom-0 left-[calc(var(--sidebar-width)+var(--safe-left))] max-phone:left-0'
          : 'absolute inset-0 overflow-hidden rounded-[inherit] bg-canvas',
      )}
    >
      {wash && <WashLayer color={wash} place={place} />}
      {leaving?.value && <WashLayer color={leaving.value} place={place} leaving />}
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
        // The shadow is an arbitrary property, not a `shadow-[…]` utility: Tailwind takes a shadow
        // utility apart to swap its color, and a color that is a variable comes out as no shadow.
        'absolute inset-0 rounded-[14px] bg-(color:--now-glow) [box-shadow:0_0_12px_4px_var(--now-glow)] max-phone:[box-shadow:0_0_12px_2px_var(--now-glow)]',
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

/**
 * Classic's phone mini player, tinted with the cover the way the Now Playing page is washed with
 * it. `tintFor` mixes the cover into the bar's own surface only as far as its title and artist
 * still read. It fills its parent, which has to be a stacking context (the footer is fixed with a z-index), and
 * cross-fades on a track change like the wash.
 */
export function CoverTint({ art, className }: { art: string; className?: string }) {
  const theme = useTheme()
  const cover = useCoverColor(art)
  const tint = useMemo(() => (cover ? tintFor(cover, theme.colors) : null), [cover, theme])
  const leaving = useLeaving(tint)

  return (
    <div
      aria-hidden="true"
      data-cover-tint={tint ?? ''}
      className={cx('pointer-events-none absolute inset-0 -z-10 overflow-hidden', className)}
    >
      {tint && <TintLayer color={tint} />}
      {leaving?.value && <TintLayer color={leaving.value} leaving />}
    </div>
  )
}

function TintLayer({ color, leaving }: { color: string; leaving?: boolean }) {
  return (
    <div
      className={cx('absolute inset-0 bg-(--cover-tint)', leaving && 'leaving')}
      style={{ '--cover-tint': color, ...(leaving ? leavingStyle : {}) } as CSSProperties}
    />
  )
}
