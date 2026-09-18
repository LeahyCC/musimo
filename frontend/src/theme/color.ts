/* Colour arithmetic, and nothing that knows what a theme is. The editor uses the contrast ratio to
   warn when a text pair falls under WCAG AA; which pairs those are is a theme rule and lives with
   the theme, not here. */

export type Rgb = {
  /** 0-255. */
  r: number
  g: number
  b: number
  /** 0-1. */
  a: number
}

/** 3, 4, 6 or 8 digits. Stored themes are held to 6 or 8 by the schema; this also reads `#fff`. */
const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

export function parseHex(value: string): Rgb | null {
  const text = value.trim()
  if (!HEX.test(text)) return null
  const digits = text.slice(1)
  // A short form is each digit doubled: #1a2 is #11aa22.
  const full = digits.length < 6 ? digits.replace(/./g, (digit) => digit + digit) : digits
  const channel = (at: number): number => Number.parseInt(full.slice(at, at + 2), 16)

  return {
    r: channel(0),
    g: channel(2),
    b: channel(4),
    a: full.length === 8 ? channel(6) / 255 : 1,
  }
}

/* WCAG 2.2 relative luminance: undo the sRGB transfer curve, then weight the channels by how much
   the eye gets from each. */
const linear = (value: number): number => {
  const channel = value / 255

  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

export const relativeLuminance = (color: Rgb): number =>
  0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)

/* 1 for two identical colors, 21 for black on white. Alpha is ignored: WCAG measures what is
   actually painted, and what sits behind a translucent color is not knowable from the pair. */
export function contrastRatio(one: Rgb, two: Rgb): number {
  const first = relativeLuminance(one)
  const second = relativeLuminance(two)

  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

/** The same ratio from two hex strings, or null if either one is not a color. */
export function hexContrast(one: string, two: string): number | null {
  const first = parseHex(one)
  const second = parseHex(two)

  return first && second ? contrastRatio(first, second) : null
}
