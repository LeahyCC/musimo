import { z } from 'zod'

import { DEFAULT_THEME } from './themes'
import type { Theme } from './themes'
import { COLOR_TOKENS } from './tokens'
import type { ColorToken } from './tokens'

/* A theme arrives from browser storage or from a file a person picked, so none of it is trusted.
   Known token names only, hex values only, a bounded name and a cap on how many are kept. Anything
   else is refused whole rather than half-applied. */

/** Six or eight digits. Long enough for an alpha channel, short enough to rule out `url(...)`. */
export const HEX_COLOR = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

export const MAX_THEME_NAME = 40
export const MAX_CUSTOM_THEMES = 50
export const CUSTOM_THEMES_VERSION = 1

const hexValue = z.string().regex(HEX_COLOR, 'Colors are six or eight digit hex values')

/* Every token is optional and missing ones are filled from the default below, so a theme saved
   before a token existed still loads instead of being thrown away. Unknown keys are refused: a
   name the app does not paint with would be silently dead, and it is more likely a typo. */
const colorShape = Object.fromEntries(
  COLOR_TOKENS.map((token) => [token.name, hexValue.optional()]),
) as Record<ColorToken, z.ZodOptional<z.ZodString>>

const withDefaults = (colors: Partial<Record<ColorToken, string>>): Record<ColorToken, string> =>
  Object.fromEntries(
    COLOR_TOKENS.map((token) => [
      token.name,
      colors[token.name] ?? DEFAULT_THEME.colors[token.name],
    ]),
  ) as Record<ColorToken, string>

const themeFields = {
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/i, 'A theme id is letters, digits and dashes'),
  name: z.string().trim().min(1).max(MAX_THEME_NAME),
  scheme: z.enum(['dark', 'light']),
}

type ParsedTheme = Omit<Theme, 'colors'> & { colors: Partial<Record<ColorToken, string>> }

const complete = (theme: ParsedTheme): Theme => ({ ...theme, colors: withDefaults(theme.colors) })

export const themeSchema = z
  .strictObject({ ...themeFields, colors: z.strictObject(colorShape) })
  .transform(complete)

/* A theme read back from storage is held to the same values but forgiven an unknown color key,
   which `z.object` drops. A release that retires a token would otherwise make every saved theme
   unreadable at once. A file a person imports still goes through the strict schema above. */
export const storedThemeSchema = z
  .object({
    ...themeFields,
    colors: z.object(colorShape),
  })
  .transform(complete)

/** The envelope alone, so each theme inside it can be read, and refused, on its own. */
export const storedThemesSchema = z.object({
  version: z.literal(CUSTOM_THEMES_VERSION),
  themes: z.array(z.unknown()),
})

/** What `musimo.custom-themes` holds. The version is what lets a later format migrate. */
export const customThemesSchema = z.strictObject({
  version: z.literal(CUSTOM_THEMES_VERSION),
  themes: z.array(themeSchema).max(MAX_CUSTOM_THEMES),
})

export type CustomThemes = z.infer<typeof customThemesSchema>
