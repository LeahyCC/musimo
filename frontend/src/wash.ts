import { contrastRatio, mixRgb, parseHex, toHex } from './theme/color'
import type { Rgb } from './theme/color'
import { CONTRAST_PAIRS, MIN_CONTRAST } from './theme/contrast'
import type { Theme } from './theme/themes'

/* The rule for the color behind Now Playing: the cover's color, mixed into the theme's own canvas
   until every text color that is read on the canvas still reads. */

/** The most of the cover that can show through, and the steps it is backed off by. */
const MAX_MIX = 0.3
const STEP = 0.03

/**
 * The wash for a cover: `#rrggbb`, or null when no mix keeps the text readable (or the theme's
 * canvas is not a color at all), in which case the page has no wash.
 *
 * It starts from a 30% mix and backs off in 3% steps. A mix passes when every text color the theme
 * sets against `--color-canvas` (see `CONTRAST_PAIRS`) keeps at least WCAG AA, or, for a pair the
 * theme already has under AA on the plain canvas, at least what it had. A wash is never the reason
 * a pair gets worse, in a light theme or a dark one.
 */
export function washFor(cover: Rgb, colors: Theme['colors']): string | null {
  const canvas = parseHex(colors['--color-canvas'])
  if (!canvas) return null

  const floors: { ink: Rgb; floor: number }[] = []
  for (const pair of CONTRAST_PAIRS) {
    if (pair.background !== '--color-canvas') continue
    const ink = parseHex(colors[pair.foreground])
    if (ink) floors.push({ ink, floor: Math.min(MIN_CONTRAST, contrastRatio(ink, canvas)) })
  }

  for (let mix = MAX_MIX; mix > STEP / 2; mix -= STEP) {
    const hex = toHex(mixRgb(canvas, cover, mix))
    // Judged as painted: after the channels are rounded to whole numbers.
    const painted = parseHex(hex)
    if (painted && floors.every(({ ink, floor }) => contrastRatio(ink, painted) >= floor))
      return hex
  }

  return null
}
