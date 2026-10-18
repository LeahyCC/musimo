import type { ColorScheme, Theme } from './themes'

/* Follow system, as plain functions. A built-in theme comes as a dark and a light half under one
   family name (`slate-dark`, `slate-light`). Following the system means the family stays and the
   half is whichever one the device asks for. A person's own theme has no other half, so it is
   left as it is. `store.ts` does the storing and listening, and calls these to decide. */

export type ThemeFamily = {
  /** The id without its scheme: `slate`. */
  id: string
  /** The name without its scheme: `Slate`. */
  name: string
  dark: Theme
  light: Theme
}

const HALF = /^(.+)-(dark|light)$/

/** Families are the built-ins that have both halves. A lone `-dark` theme is not a family. */
export function themeFamilies(builtIns: readonly Theme[]): readonly ThemeFamily[] {
  const halves = new Map<string, Partial<Record<ColorScheme, Theme>>>()
  for (const theme of builtIns) {
    const match = HALF.exec(theme.id)
    if (!match) continue
    const [, family, scheme] = match
    if (!family || (scheme !== 'dark' && scheme !== 'light')) continue
    halves.set(family, { ...halves.get(family), [scheme]: theme })
  }

  const families: ThemeFamily[] = []
  for (const [id, { dark, light }] of halves) {
    if (!dark || !light) continue
    families.push({ id, name: dark.name.replace(/ dark$/, ''), dark, light })
  }

  return families
}

/** The family a theme id belongs to, or undefined for a theme of a person's own. */
export function familyOf(
  themeId: string,
  families: readonly ThemeFamily[],
): ThemeFamily | undefined {
  return families.find((family) => family.dark.id === themeId || family.light.id === themeId)
}

/**
 * The theme to show. With Follow system off it is the one chosen. With it on, a family theme
 * becomes the half that matches the device, and anything else stays as chosen.
 */
export function resolveFollowSystem(
  chosenId: string,
  followSystem: boolean,
  systemScheme: ColorScheme,
  families: readonly ThemeFamily[],
): string {
  if (!followSystem) return chosenId

  return familyOf(chosenId, families)?.[systemScheme].id ?? chosenId
}
