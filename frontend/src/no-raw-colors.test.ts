import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const src = fileURLToPath(new URL('.', import.meta.url))

/* A hex color is 3, 4, 6 or 8 digits. The lookbehind leaves a numeric entity and an in-page link
   alone. The function list is every CSS color function, which also catches an arbitrary Tailwind
   value whatever utility carries it. `color-mix(` is not in the list: mixing tokens is how a
   translucent color is meant to be written. */
const patterns = [
  {
    what: 'hex color',
    find: /(?<![&\w]|href=["'])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/,
  },
  { what: 'color function', find: /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/ },
]

/* Only the sheet is checked for these. In a component the same words are ordinary English in a
   label, and the migration does not want a test that argues about copy. A leading dot is a class
   name, not a color. */
const named =
  /(?<![\w#.-])(?:white|black|red|orange|yellow|green|blue|purple|pink|gr[ae]y|silver|gold|crimson|tomato|salmon|coral|teal|navy|olive|maroon|aqua|fuchsia|lime|magenta|cyan|brown|tan|beige|ivory|khaki|violet|indigo|rebeccapurple|(?:dark|light|medium|pale|deep|hot)[a-z]+)(?![\w-])/i

const sources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    // The theme registry is the one place that spells a theme's colors out, and the only file
    // excused. The migration finished with nothing else needing an exception: the stage hands
    // visimo a preset id, and artwork is an <img>.
    if (relative(src, path).replaceAll('\\', '/') === 'theme/themes.ts') return []

    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })

const blank = (match: string): string => match.replace(/[^\n]/g, ' ')

/* Blanks the comments and then the token block without moving anything onto another line, so a
   finding still reports the line the reader will see. Comments go first: one inside the token
   block may hold a brace, and one elsewhere may mention the block by name. In TypeScript `//` only
   opens a comment at the start of a line or after a space, which leaves a URL, a protocol-relative
   `url()` and a "//" string intact. */
const withoutNoise = (text: string, css: boolean): string => {
  const uncommented = text.replace(/\/\*[\s\S]*?\*\//g, blank)

  return css
    ? uncommented.replace(/@theme[^{]*\{[^}]*\}/g, blank)
    : uncommented.replace(/(^|\s)\/\/.*$/gm, '$1')
}

const rawColors = (text: string, css: boolean): string[] => {
  const checks = css ? [...patterns, { what: 'named color', find: named }] : patterns

  return withoutNoise(text, css)
    .split('\n')
    .flatMap((line, index) => {
      const hit = checks.find((check) => check.find.test(line))

      return hit ? [`${index + 1} ${hit.what}: ${line.trim()}`] : []
    })
}

/* Tailwind scans this file like any other, and a whole class name written here would ship in the
   production sheet. The samples below are put together at run time so it never sees one. */
const hash = '#'
const arbitrary = (value: string): string => `<i className="bg-${'['}${value}]" />`

describe('no raw colors', () => {
  it('leaves every color in the app to a --color-* token', () => {
    const files = [join(src, 'style.css'), ...sources(src)]
    const found = files.flatMap((path) => {
      const name = relative(src, path).replaceAll('\\', '/')
      return rawColors(readFileSync(path, 'utf8'), name.endsWith('.css')).map(
        (finding) => `src/${name}:${finding}`,
      )
    })

    expect(found).toEqual([])
  })

  it('catches the ways a raw color gets written', () => {
    const css = [
      `.a { color: ${hash}fff }`,
      `.a { color: ${hash}17201bcc }`,
      '.a { color: rgba(0, 0, 0, 0.5) }',
      '.a { color: oklch(0.7 0.1 150) }',
      '.a { color: color(display-p3 1 0 0) }',
      '.a { color: white }',
      '.a { color: darkgreen }',
      `.a { background: url(//host/x.png) ${hash}000 }`,
      `/* the @theme block */ .a { color: ${hash}123 }`,
    ]
    for (const line of css) expect(rawColors(line, true), line).toHaveLength(1)

    const tsx = [arbitrary(`${hash}17201b`), arbitrary('oklch(0.7_0.1_150)')]
    for (const line of tsx) expect(rawColors(line, false), line).toHaveLength(1)
  })

  it('leaves tokens, mixes, anchors and entities alone', () => {
    const css = [
      `@theme { --color-canvas: ${hash}111716; /* a } in a comment */ --color-text: ${hash}e8ece8; }`,
      '.a { color: color-mix(in oklab, var(--color-accent) 20%, transparent) }',
      '.badge.red { color: var(--color-danger) }',
    ]
    for (const line of css) expect(rawColors(line, true), line).toEqual([])

    const tsx = [
      `<a href="${hash}add">Add</a>`,
      `<span>&${hash}160;</span>`,
      `const u = "https://x" // ${hash}fff`,
    ]
    for (const line of tsx) expect(rawColors(line, false), line).toEqual([])
  })
})
