import type { CSSProperties, ReactNode } from 'react'

import type { PetProps } from './pet'
import { anim } from './pet-anim'
import type { PetState } from './pet-mood'
import type { PetKind } from './pet-settings'

/* ---------- The Windows 95 skin: pixel art on a 16 by 16 grid ---------- */

const PIXEL_MAPS: Record<PetKind, readonly string[]> = {
  cat: [
    '................',
    '................',
    '..OO........OO..',
    '..OBO......OBO..',
    '..OBBO....OBBO..',
    '.OBBBBOOOOBBBBO.',
    '.OBBBBBBBBBBBBO.',
    '.OBBBBBBBBBBBBO.',
    '.OBBBBBBBBBBBBO.',
    '.OBBBBBBBBBBBBO.',
    '.OBBBBBBBBBBBBO.',
    '.OBBBBBBBBBBBBOO',
    '.OBBBBBBBBBBBBOO',
    '..OBBBBBBBBBBOO.',
    '..OBBBBBBBBBBO..',
    '...OOOOOOOOOO...',
  ],
  bird: [
    '................',
    '.......OO.......',
    '......OBBO......',
    '....OOOOOOOO....',
    '...OBBBBBBBBO...',
    '..OBBBBBBBBBBO..',
    '.OBBBBBBBBBBBBO.',
    '.OBBBBBBBBBBBBO.',
    'OSBBBBBBBBBBBBSO',
    'OSSBBBBBBBBBBSSO',
    'OSSBBHHHHHHBBSSO',
    '.OSBBHHHHHHBBSO.',
    '..OBBHHHHHHBBO..',
    '...OBBBBBBBBO...',
    '....OOOOOOOO....',
    '.....O....O.....',
  ],
  robot: [
    '.......OO.......',
    '......OAAO......',
    '.......OO.......',
    '.......OO.......',
    '..OOOOOOOOOOOO..',
    '..OBBBBBBBBBBO..',
    'OOOBIIIIIIIIBOOO',
    'OSOBIIIIIIIIBOSO',
    'OSOBIIIIIIIIBOSO',
    'OSOBIIIIIIIIBOSO',
    'OOOBIIIIIIIIBOOO',
    '..OBBBBBBBBBBO..',
    '..OOOOOOOOOOOO..',
    '....OBBIIBBO....',
    '....OBBBBBBO....',
    '....OOOOOOOO....',
  ],
  blob: [
    '................',
    '................',
    '................',
    '................',
    '......OOOO......',
    '....OOBBBBOO....',
    '...OBBBBBBBBO...',
    '..OBHHBBBBBBBO..',
    '..OBHBBBBBBBBO..',
    '.OBBBBBBBBBBBBO.',
    '.OBBBBBBBBBBBBO.',
    'OBBBBBBBBBBBBBBO',
    'OBBBBBBBBBBBBBBO',
    'OBBBBBBBBBBBBBBO',
    '.OBBBBBBBBBBBBO.',
    '..OOOOOOOOOOOO..',
  ],
}
const ANCHOR: Record<PetKind, { ey: number; eL: number; eR: number; my: number }> = {
  cat: { ey: 8, eL: 4, eR: 10, my: 11 },
  bird: { ey: 6, eL: 4, eR: 10, my: 8 },
  robot: { ey: 7, eL: 5, eR: 9, my: 9 },
  blob: { ey: 9, eL: 5, eR: 9, my: 12 },
}
type Cell = readonly [number, number, string]
type Dot = readonly [number, number]

export function PixelPet({ kind, state, size: S, motion }: Omit<PetProps, 'paint'>) {
  const off = state === 'offline'
  const palette: Partial<Record<string, string>> = {
    O: 'var(--color-line-strong)',
    B: off ? 'var(--color-line)' : 'var(--pet-color, var(--color-accent))',
    I: off ? 'var(--color-line-strong)' : 'var(--pet-ink, var(--color-accent-ink))',
    S: 'var(--color-line)',
    H: 'var(--color-sunken)',
    A: 'var(--color-accent-hot)',
    T: 'var(--color-text)',
    W: 'var(--color-sunken)',
    P: 'var(--color-partial)',
  }
  // A letter the palette does not know draws nothing rather than a guess.
  const ink = (letter: string): string => palette[letter] ?? 'transparent'
  const px = Math.max(1, Math.round(S / 16))
  const a = ANCHOR[kind]
  const fc = kind === 'robot' ? 'B' : 'I'
  const A = (name: string, rest: string) => anim(motion, name, rest)
  const cells = (map: readonly string[], ox = 0, oy = 0): Cell[] =>
    map.flatMap((row, y) =>
      [...row].flatMap((ch, x): Cell[] => (ch === '.' ? [] : [[x + ox, y + oy, ink(ch)]])),
    )
  let k = 0
  // One element per layer: every pixel is a box shadow of a single px-sized square.
  const layer = (list: readonly Cell[], style: CSSProperties = {}) => (
    <i
      key={k++}
      className="absolute block"
      style={
        {
          'left': -px,
          'top': -px,
          'width': px,
          'height': px,
          '--px': `${px}px`,
          'boxShadow': list
            .map(([x, y, c]) => `${(x + 1) * px}px ${(y + 1) * px}px 0 0 ${c}`)
            .join(','),
          ...style,
        } as CSSProperties
      }
    />
  )
  const pts = (list: readonly Dot[], ox: number, oy: number, colour: string): Cell[] =>
    list.map(([dx, dy]) => [ox + dx, oy + dy, ink(colour)] as const)
  const both = (pattern: readonly Dot[]) => [
    ...pts(pattern, a.eL, a.ey, fc),
    ...pts(pattern, a.eR, a.ey, fc),
  ]
  const square: Dot[] = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]
  const layers: ReactNode[] = [layer(cells(PIXEL_MAPS[kind]))]

  if (state === 'idle' || state === 'talking') {
    layers.push(layer(both(square), A('pet-px-blink-a', '4.2s infinite')))
    if (motion !== 'off')
      layers.push(
        layer(
          both([
            [0, 1],
            [1, 1],
          ]),
          { opacity: 0, ...A('pet-px-blink-b', '4.2s infinite') },
        ),
      )
  } else if (state === 'listening')
    layers.push(
      layer(
        both([
          [-1, 0],
          [2, 0],
          [0, 1],
          [1, 1],
        ]),
      ),
    )
  else if (state === 'happy')
    layers.push(
      layer(
        both([
          [0, 0],
          [1, 0],
          [-1, 1],
          [2, 1],
        ]),
      ),
    )
  else if (state === 'sleeping' || state === 'offline')
    layers.push(
      layer(
        both([
          [0, 1],
          [1, 1],
        ]),
      ),
    )
  else if (state === 'thinking')
    layers.push(
      layer(
        both([
          [1, -1],
          [2, -1],
          [1, 0],
          [2, 0],
        ]),
      ),
    )
  else if (state === 'busy')
    layers.push(
      layer(
        both([
          [1, 1],
          [2, 1],
        ]),
      ),
    )
  else if (state === 'confused')
    layers.push(
      layer([
        ...pts(
          [
            [0, -1],
            [1, -1],
            [0, 0],
            [1, 0],
            [0, 1],
            [1, 1],
          ],
          a.eL,
          a.ey,
          fc,
        ),
        ...pts(
          [
            [0, 1],
            [1, 1],
            [0, -1],
            [1, -2],
          ],
          a.eR,
          a.ey,
          fc,
        ),
      ]),
    )
  else {
    const brows: Cell[] =
      kind === 'robot'
        ? []
        : [
            ...pts(
              [
                [0, -1],
                [1, -2],
              ],
              a.eL,
              a.ey,
              fc,
            ),
            ...pts(
              [
                [0, -2],
                [1, -1],
              ],
              a.eR,
              a.ey,
              fc,
            ),
          ]
    layers.push(
      layer([
        ...both([
          [0, 1],
          [1, 1],
        ]),
        ...brows,
      ]),
    )
  }

  // Mouth, or the bird's beak, centred on columns 7 and 8.
  const M = (list: readonly Dot[]) => pts(list, 7, a.my, fc)
  if (kind === 'cat')
    layers.push(
      layer(
        pts(
          [
            [7, 10],
            [8, 10],
          ],
          0,
          0,
          'I',
        ),
      ),
    )
  if (kind === 'bird') {
    if (state === 'talking') {
      layers.push(layer(M(square), A('pet-px-a', '.5s infinite')))
      if (motion !== 'off')
        layers.push(
          layer(
            M([
              [0, 0],
              [1, 0],
              [0, 2],
              [1, 2],
            ]),
            { opacity: 0, ...A('pet-px-b', '.5s infinite') },
          ),
        )
    } else layers.push(layer(M(square)))
  } else if (state === 'talking') {
    layers.push(layer(M(square), A('pet-px-a', '.5s infinite')))
    if (motion !== 'off')
      layers.push(
        layer(
          M([
            [0, 0],
            [1, 0],
          ]),
          { opacity: 0, ...A('pet-px-b', '.5s infinite') },
        ),
      )
  } else {
    const mouth: Record<Exclude<PetState, 'talking'>, Dot[]> = {
      idle: [
        [0, 0],
        [1, 0],
      ],
      busy: [
        [0, 0],
        [1, 0],
      ],
      offline: [
        [0, 0],
        [1, 0],
      ],
      listening: [
        [-1, 0],
        [2, 0],
        [0, 1],
        [1, 1],
      ],
      happy: [
        [-1, 0],
        [0, 0],
        [1, 0],
        [2, 0],
        [0, 1],
        [1, 1],
      ],
      sorry: [
        [0, 0],
        [1, 0],
        [-1, 1],
        [2, 1],
      ],
      confused: [
        [-1, 0],
        [0, 0],
        [1, 1],
        [2, 1],
      ],
      thinking: [
        [1, 0],
        [2, 0],
      ],
      sleeping: [],
    }
    if (mouth[state].length) layers.push(layer(M(mouth[state])))
  }

  const bodyAnim: CSSProperties =
    state === 'listening'
      ? A('pet-px-sway', '1.6s infinite')
      : state === 'happy'
        ? A('pet-px-hop', '.9s infinite')
        : state === 'talking'
          ? A('pet-px-bob', '1.1s infinite')
          : state === 'sorry'
            ? { transform: `translateY(${px}px)` }
            : {}

  const acc: ReactNode[] = []
  if (state === 'listening')
    acc.push(
      layer(
        cells(['..TT.', '..T.T', '..T..', 'TTT..', 'TTT..'], 15, -3),
        A('pet-px-rise', '2.4s infinite'),
      ),
    )
  if (state === 'sleeping') {
    acc.push(
      layer(cells(['TTT', '..T', '.T.', 'T..', 'TTT'], 14, -1), A('pet-px-rise', '3s infinite')),
    )

    acc.push(
      layer(cells(['TTT', '.T.', 'TTT'], 18, -4), A('pet-px-rise', '3s 1.5s infinite backwards')),
    )
  }

  if (state === 'thinking') {
    acc.push(
      layer(
        cells(
          [
            '.OOOOOOOOO.',
            'OWWWWWWWWWO',
            'OWWWWWWWWWO',
            'OWWWWWWWWWO',
            '.OOOOOOOOO.',
            '..OO.......',
            '.OO........',
          ],
          11,
          -7,
        ),
      ),
    )
    for (const i of [0, 1, 2])
      acc.push(layer([[13 + i * 3, -5, ink('T')]], A('pet-px-a', `.9s ${i * 0.3}s infinite`)))
  }
  if (state === 'talking')
    acc.push(
      layer(
        cells(
          [
            'OOOOOOOOO',
            'OWWWWWWWO',
            'OWTTTTTWO',
            'OWWWWWWWO',
            'OWTTTWWWO',
            'OWWWWWWWO',
            'OOOOOOOOO',
            '.OO......',
            '.O.......',
          ],
          12,
          -8,
        ),
      ),
    )
  if (state === 'happy') {
    acc.push(layer(cells(['.A.', 'AAA', '.A.'], -3, 3), A('pet-px-a', '.8s infinite')))
    acc.push(
      layer(cells(['.A.', 'AAA', '.A.'], 16, -1), { opacity: 0, ...A('pet-px-b', '.8s infinite') }),
    )
  }
  if (state === 'confused')
    acc.push(
      layer(
        cells(['.TT.', 'T..T', '...T', '..T.', '....', '..T.'], 14, -6),
        A('pet-px-a', '1.4s infinite'),
      ),
    )
  if (state === 'sorry')
    acc.push(layer(cells(['.P.', 'PPP', 'PPP', '.P.'], 15, 4), A('pet-px-fall', '1.8s infinite')))
  if (state === 'busy')
    acc.push(
      <span
        key="hourglass"
        className="absolute block"
        style={{
          left: 16 * px,
          top: 7 * px,
          width: 7 * px,
          height: 7 * px,
          transformOrigin: '50% 50%',
          ...A('pet-px-flip', '1.6s infinite'),
        }}
      >
        {layer(
          cells(['OOOOOOO', '.OWWWO.', '..OAO..', '...O...', '..OWO..', '.OAAAO.', 'OOOOOOO']),
        )}
      </span>,
    )
  if (state === 'offline')
    acc.push(layer(cells(['....OO..', '....OOOO', 'OOOOOO..', '....OOOO', '....OO..'], 13, 11)))

  return (
    <span
      className="relative block"
      style={{ width: px * 16, height: px * 16 }}
      data-pet-state={state}
    >
      <span
        className="absolute inset-0 block"
        style={
          {
            '--px': `${px}px`,
            'willChange': bodyAnim.animation ? 'transform' : undefined,
            ...bodyAnim,
          } as CSSProperties
        }
      >
        {layers}
      </span>
      {acc}
    </span>
  )
}
