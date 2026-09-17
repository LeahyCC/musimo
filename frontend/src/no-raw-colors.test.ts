import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const src = fileURLToPath(new URL('.', import.meta.url))

/* Files allowed to name a color, because the color is not a themed surface. Anything handed to
   visimo or drawn on the WebGPU stage belongs to a scene, and the migration plan keeps scenes out
   of the theme. Phase 1 found none: the stage passes visimo a preset id and a size, and the
   artwork fallback is an <img>. Add a file here only with the reason beside it. */
const ALLOWED = new Set<string>()

/* `-[#` is how an arbitrary Tailwind color value starts, whatever utility carries it, so it
   catches `bg-[#17201b]` and `text-[#fff]` alike. */
const patterns = [
  { what: 'hex color', find: /#[0-9a-fA-F]{3,8}\b/ },
  { what: 'rgb() or hsl()', find: /\b(?:rgba?|hsla?)\(/ },
  { what: 'arbitrary color utility', find: /-\[#/ },
]

/* Only the sheet is checked for these. In a component the same words are ordinary English in a
   label, and the migration does not want a test that argues about copy. */
const named =
  /(?<![\w#-])(?:white|black|red|orange|yellow|green|blue|purple|pink|gray|grey|silver|gold|crimson|tomato|salmon|teal|navy|olive|maroon|aqua|fuchsia|lime|magenta|cyan|brown|beige|ivory|khaki|violet|indigo)(?![\w-])/i

const sources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    // The theme registry a later card adds is the one place that spells the default theme out.
    if (entry.isDirectory()) return entry.name === 'theme' ? [] : sources(path)

    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })

/* Blanks the token block and the comments without moving anything onto another line, so a finding
   still reports the line the reader will see. `//` only opens a comment when something other than
   a colon precedes it, which leaves an https:// URL intact. */
const blank = (match: string): string => match.replace(/[^\n]/g, ' ')

const withoutNoise = (text: string): string =>
  text
    .replace(/@theme[^{]*\{[^}]*\}/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

const findings = (path: string): string[] => {
  const name = relative(src, path).replaceAll('\\', '/')
  if (ALLOWED.has(name)) return []

  const checks = name.endsWith('.css')
    ? [...patterns, { what: 'named color', find: named }]
    : patterns

  return withoutNoise(readFileSync(path, 'utf8'))
    .split('\n')
    .flatMap((line, index) => {
      const hit = checks.find((check) => check.find.test(line))

      return hit ? [`src/${name}:${index + 1} ${hit.what}: ${line.trim()}`] : []
    })
}

describe('no raw colors', () => {
  it('leaves every color in the app to a --color-* token', () => {
    const files = [join(src, 'style.css'), ...sources(src)]

    expect(files.flatMap(findings)).toEqual([])
  })
})
