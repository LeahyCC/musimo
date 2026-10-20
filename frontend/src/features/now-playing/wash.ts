import { contrastRatio, mixRgb, parseHex, relativeLuminance, toHex } from '../../theme/color'
import type { Rgb } from '../../theme/color'
import { CONTRAST_PAIRS, MIN_CONTRAST } from '../../theme/contrast'
import type { Theme } from '../../theme/themes'

/* The rules for the colors behind Now Playing. The wash is the cover's color mixed into the theme's
   own canvas until every text color that is read on the canvas still reads. The glow is a stronger
   mix that is only drawn where no canvas text sits, so it has no contrast to keep. */

/** The most of the cover that can show through, and the steps it is backed off by. */
const MAX_MIX = 0.3
const STEP = 0.03

/** How much of the cover the glow takes. Fixed, not backed off: it is chosen to be clearly visible
    on the default theme's dark canvas and on a light one, and no text is ever drawn on it. */
export const GLOW_MIX = 0.6

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

/**
 * The glow for a cover: `#rrggbb`, the cover mixed `GLOW_MIX` of the way into the theme's canvas,
 * or null when the canvas is not a color. Unlike `washFor` it does not look at contrast, because
 * the glow is only drawn behind the artwork, where the page sets no text on the canvas. Keeping it
 * there is the caller's job.
 */
export function glowFor(cover: Rgb, colors: Theme['colors']): string | null {
  const canvas = parseHex(colors['--color-canvas'])

  return canvas ? toHex(mixRgb(canvas, cover, GLOW_MIX)) : null
}

/** The most of the cover the phone mini player's tint can take. */
const TINT_MAX_MIX = 0.8

/**
 * The cover taken toward black on a dark surface, or toward white on a light one, until it is as
 * light as the surface. Its hue survives, so mixing it in colors the surface without making it
 * lighter or darker, which is what would cost the text its contrast.
 */
function toneTo(cover: Rgb, surface: Rgb, dark: boolean): Rgb {
  const target = relativeLuminance(surface)
  const end: Rgb = dark ? { r: 0, g: 0, b: 0, a: 1 } : { r: 255, g: 255, b: 255, a: 1 }
  let low = 0
  let high = 1
  for (let step = 0; step < 24; step += 1) {
    const middle = (low + high) / 2
    const light = relativeLuminance(mixRgb(cover, end, middle))
    if (dark ? light > target : light < target) low = middle
    else high = middle
  }
  return mixRgb(cover, end, high)
}

/**
 * The tint for Classic's phone mini player: `#rrggbb`, the cover's hue mixed into the mini player's
 * own surface (`--color-hover`), or null when the surface is not a color or no mix keeps its text
 * readable. The cover is first toned to the surface's lightness (`toneTo`), so a pale cover on a
 * dark theme gives a dark tint of its own hue rather than a grey. The bar sets its title in
 * `--color-text` and its artist in `--color-muted`, so those two are held, each to AA or to what
 * it had on the plain surface if that was less, and the mix backs off in steps until they are.
 */
export function tintFor(cover: Rgb, colors: Theme['colors']): string | null {
  const surface = parseHex(colors['--color-hover'])
  const text = parseHex(colors['--color-text'])
  if (!surface || !text) return null
  const toned = toneTo(cover, surface, relativeLuminance(text) > relativeLuminance(surface))

  const floors: { ink: Rgb; floor: number }[] = []
  for (const key of ['--color-text', '--color-muted'] as const) {
    const ink = parseHex(colors[key])
    if (ink) floors.push({ ink, floor: Math.min(MIN_CONTRAST, contrastRatio(ink, surface)) })
  }

  for (let mix = TINT_MAX_MIX; mix > STEP / 2; mix -= STEP) {
    const painted = parseHex(toHex(mixRgb(surface, toned, mix)))
    if (painted && floors.every(({ ink, floor }) => contrastRatio(ink, painted) >= floor))
      return toHex(painted)
  }

  return null
}
