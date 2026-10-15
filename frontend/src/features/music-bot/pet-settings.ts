import { useSyncExternalStore } from 'react'

import { z } from 'zod'

import { readStoredJson, writeStored } from '../../lib/storage'
import { hexContrast } from '../../theme/color'
import { MIN_CONTRAST } from '../../theme/contrast'
import { BUILT_IN_THEMES } from '../../theme/themes'
import type { ColorScheme } from '../../theme/themes'

/* The pet's look and manners. Like themes they are a preference of this browser, not of the
   library, so they live in `musimo.pet` and nothing here talks to the server.

   Every field falls back on its own: a value this build does not know (an older or newer build
   wrote it, or someone edited it by hand) resets that one field rather than the whole pet. */

const PET_KEY = 'musimo.pet'
export const PET_SETTINGS_VERSION = 1
export const MAX_PET_NAME = 20
export const DEFAULT_PET_NAME = 'Octive'

export const PET_KINDS = ['cat', 'bird', 'robot', 'blob'] as const
export const PET_COLOURS = ['theme', 'musimo', 'slate', 'sunset', 'violet', 'graphite'] as const
export const PET_SIZES = ['small', 'medium', 'large'] as const
export const PET_POSITIONS = ['left', 'centre', 'right'] as const
export const PET_CHATTINESS = ['quiet', 'normal', 'chatty'] as const
export const PET_MOTIONS = ['system', 'full', 'reduced', 'off'] as const

export type PetKind = (typeof PET_KINDS)[number]
export type PetColour = (typeof PET_COLOURS)[number]
export type PetSize = (typeof PET_SIZES)[number]
export type PetPosition = (typeof PET_POSITIONS)[number]
export type PetChattiness = (typeof PET_CHATTINESS)[number]
export type PetMotionSetting = (typeof PET_MOTIONS)[number]
/** What a drawing actually does once the device's own reduced-motion setting is applied. */
export type PetMotion = Exclude<PetMotionSetting, 'system'>

export const DEFAULT_PET_SETTINGS = {
  version: PET_SETTINGS_VERSION,
  kind: 'cat',
  name: DEFAULT_PET_NAME,
  colour: 'theme',
  size: 'medium',
  position: 'left',
  chattiness: 'normal',
  motion: 'system',
  sounds: false,
  hidden: false,
} as const satisfies Record<string, unknown>

const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PET_NAME)
  // A name is shown in labels and copy, so control characters are refused rather than drawn.
  .refine((name) => !/\p{Cc}/u.test(name))

export const petSettingsSchema = z.object({
  version: z.literal(PET_SETTINGS_VERSION).catch(PET_SETTINGS_VERSION),
  kind: z.enum(PET_KINDS).catch(DEFAULT_PET_SETTINGS.kind),
  name: nameSchema.catch(DEFAULT_PET_SETTINGS.name),
  colour: z.enum(PET_COLOURS).catch(DEFAULT_PET_SETTINGS.colour),
  size: z.enum(PET_SIZES).catch(DEFAULT_PET_SETTINGS.size),
  position: z.enum(PET_POSITIONS).catch(DEFAULT_PET_SETTINGS.position),
  chattiness: z.enum(PET_CHATTINESS).catch(DEFAULT_PET_SETTINGS.chattiness),
  motion: z.enum(PET_MOTIONS).catch(DEFAULT_PET_SETTINGS.motion),
  sounds: z.boolean().catch(DEFAULT_PET_SETTINGS.sounds),
  hidden: z.boolean().catch(DEFAULT_PET_SETTINGS.hidden),
})
export type PetSettings = z.infer<typeof petSettingsSchema>

/** Whatever storage held, as settings. Anything that is not an object is the default pet. */
export function parsePetSettings(raw: unknown): PetSettings {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return petSettingsSchema.parse(source)
}

let current: PetSettings = DEFAULT_PET_SETTINGS
let loaded = false
const listeners = new Set<() => void>()

function load() {
  if (loaded) return
  loaded = true
  current = parsePetSettings(readStoredJson(PET_KEY))
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  // Another tab changing the pet repaints this one too.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== PET_KEY) return
    current = parsePetSettings(readStoredJson(PET_KEY))
    listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

const snapshot = () => {
  load()
  return current
}

export const usePetSettings = (): PetSettings =>
  useSyncExternalStore(subscribe, snapshot, () => DEFAULT_PET_SETTINGS)

/**
 * Applies a change straight away. A browser that refuses storage still gets the change for as
 * long as the page is open; the return value says whether it was kept.
 */
export function setPetSettings(patch: Partial<Omit<PetSettings, 'version'>>): boolean {
  load()
  current = parsePetSettings({ ...current, ...patch })
  for (const listener of listeners) listener()
  return writeStored(PET_KEY, JSON.stringify(current))
}

export const resetPetSettings = (): boolean => setPetSettings(DEFAULT_PET_SETTINGS)

/** The swatch's own name, for its label and for the Reset line. */
export const PET_COLOUR_LABELS: Record<PetColour, string> = {
  theme: 'Theme accent',
  musimo: 'Musimo green',
  slate: 'Slate blue',
  sunset: 'Sunset orange',
  violet: 'Violet',
  graphite: 'Graphite teal',
}

export type PetPaint = { body: string; ink: string }

/**
 * A picked colour is a built-in family's accent, taken from the half of that family that matches
 * the active theme's scheme, so a light theme gets the family's darker light accent. The face is
 * the family's accent ink. Where that pair would fall below AA, or for "theme", the result is null
 * and the drawing keeps the active theme's own accent and accent ink.
 */
export function petPaint(colour: PetColour, scheme: ColorScheme): PetPaint | null {
  if (colour === 'theme') return null
  const theme = BUILT_IN_THEMES.find((entry) => entry.id === `${colour}-${scheme}`)
  if (!theme) return null
  const body = theme.colors['--color-accent']
  const ink = theme.colors['--color-accent-ink']
  const ratio = hexContrast(ink, body)
  return ratio !== null && ratio >= MIN_CONTRAST ? { body, ink } : null
}

/** The drawing's size in pixels. Phones keep to small or medium, whichever is smaller. */
export function petPixels(size: PetSize, phone: boolean): number {
  if (phone) return size === 'small' ? 24 : 30
  return { small: 32, medium: 44, large: 56 }[size]
}

/** "Follow this device" is reduced when the device asks for reduced motion, and full otherwise. */
export const petMotion = (setting: PetMotionSetting, deviceReduced: boolean): PetMotion =>
  setting === 'system' ? (deviceReduced ? 'reduced' : 'full') : setting
