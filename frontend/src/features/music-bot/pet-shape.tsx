import { createElement } from 'react'
import type { CSSProperties, ReactNode } from 'react'

import type { PetProps } from './pet'
import { anim } from './pet-anim'
import type { PetKind } from './pet-settings'

type Face = { eyeY: number; eL: number; eR: number; e: number; mY: number | null; body: boolean }
const FACE: Record<PetKind, Face> = {
  cat: { eyeY: 50, eL: 34, eR: 66, e: 11, mY: 68, body: false },
  bird: { eyeY: 43, eL: 38, eR: 62, e: 10, mY: null, body: false },
  robot: { eyeY: 40, eL: 37, eR: 63, e: 12, mY: 52, body: true },
  blob: { eyeY: 57, eL: 37, eR: 63, e: 11, mY: 72, body: false },
}
type Rect = readonly [number, number, number, number]
const PHONES: Record<PetKind, { band: Rect; cups: readonly Rect[] }> = {
  cat: {
    band: [8, 12, 84, 56],
    cups: [
      [1, 40, 14, 24],
      [85, 40, 14, 24],
    ],
  },
  bird: {
    band: [10, 14, 80, 52],
    cups: [
      [6, 34, 14, 22],
      [80, 34, 14, 22],
    ],
  },
  robot: {
    band: [4, 8, 92, 52],
    cups: [
      [0, 30, 15, 26],
      [85, 30, 15, 26],
    ],
  },
  blob: {
    band: [8, 20, 84, 56],
    cups: [
      [2, 48, 14, 22],
      [84, 48, 14, 22],
    ],
  },
}
const BODY_TOP: Record<PetKind, string> = { cat: '7%', bird: '2%', robot: '5%', blob: '7%' }

export function ShapePet({ kind, state, size: S, motion, ring }: Omit<PetProps, 'paint'>) {
  const off = state === 'offline'
  const body = off ? 'var(--color-muted)' : 'var(--pet-color, var(--color-accent))'
  const ink = off ? 'var(--color-canvas)' : 'var(--pet-ink, var(--color-accent-ink))'
  const shade = `color-mix(in oklab, ${body} 76%, ${ink})`
  // A lighter tint for the bird's chest and the blob's shine. On-media is the light every theme
  // keeps for text over artwork, which is the one token that is always near white.
  const light = `color-mix(in oklab, ${body} 62%, var(--color-on-media))`
  const t = Math.max(1.5, S * 0.034)
  const A = (name: string, rest: string) => anim(motion, name, rest)
  let k = 0
  const box = (
    x: number,
    y: number,
    w: number,
    h: number,
    style: CSSProperties,
    ...children: ReactNode[]
  ) =>
    // Children go in as arguments, not an array, so the fixed parts need no keys of their own.
    createElement(
      'div',
      {
        key: k++,
        style: {
          position: 'absolute',
          left: `${x}%`,
          top: `${y}%`,
          width: `${w}%`,
          height: `${h}%`,
          ...style,
        },
      },
      ...children,
    )
  const F = FACE[kind]
  const feat = F.body ? body : ink
  const droopEars = state === 'sorry' || state === 'sleeping'

  // Body parts, back to front.
  const parts: ReactNode[] = []
  if (kind === 'cat') {
    const inner = (left: string, clip: string) => (
      <i
        style={{
          position: 'absolute',
          left,
          top: '24%',
          width: '46%',
          height: '56%',
          background: shade,
          clipPath: clip,
        }}
      />
    )
    parts.push(
      box(
        14,
        8,
        30,
        34,
        {
          background: body,
          clipPath: 'polygon(30% 0, 100% 78%, 0 100%)',
          transform: `rotate(${droopEars ? -34 : -4}deg)`,
          transformOrigin: '80% 100%',
        },
        inner('22%', 'polygon(30% 0, 100% 78%, 0 100%)'),
      ),
      box(
        56,
        8,
        30,
        34,
        {
          background: body,
          clipPath: 'polygon(70% 0, 100% 100%, 0 78%)',
          transform: `rotate(${droopEars ? 34 : 4}deg)`,
          transformOrigin: '20% 100%',
        },
        inner('32%', 'polygon(70% 0, 100% 100%, 0 78%)'),
      ),
      box(79, 52, 11, 34, { background: shade, borderRadius: 99, transform: 'rotate(18deg)' }),
      box(12, 26, 76, 66, { background: body, borderRadius: '46% 46% 40% 40% / 52% 52% 42% 42%' }),
      box(46.5, 58, 7, 5.5, { background: ink, borderRadius: '45% 45% 60% 60%' }),
    )
  } else if (kind === 'bird') {
    const flap = state === 'happy'
    parts.push(
      box(43, 8, 9, 18, { background: body, borderRadius: 99, transform: 'rotate(-18deg)' }),
      box(51, 11, 8, 15, { background: body, borderRadius: 99, transform: 'rotate(22deg)' }),
      box(36, 87, 6, 11, { background: shade, borderRadius: 2 }),
      box(58, 87, 6, 11, { background: shade, borderRadius: 2 }),
      box(3, 46, 20, 28, {
        background: shade,
        borderRadius: '60% 20% 60% 60%',
        transform: 'rotate(18deg)',
        transformOrigin: '90% 20%',
        ...(flap ? A('pet-flap-l', '.45s ease-in-out infinite') : {}),
      }),
      box(77, 46, 20, 28, {
        background: shade,
        borderRadius: '20% 60% 60% 60%',
        transform: 'rotate(-18deg)',
        transformOrigin: '10% 20%',
        ...(flap ? A('pet-flap-r', '.45s ease-in-out infinite') : {}),
      }),
      box(14, 22, 72, 70, { background: body, borderRadius: '50%' }),
      box(30, 60, 40, 27, { background: light, borderRadius: '50%' }),
      box(45, 50, 10, 10, {
        background: ink,
        borderRadius: '30% 0 30% 0',
        transform: 'rotate(45deg)',
        ...(state === 'talking' ? A('pet-talk', '.4s ease-in-out infinite alternate') : {}),
      }),
    )
    if (state === 'happy')
      parts.push(box(46.5, 58, 7, 4, { background: ink, borderRadius: '0 0 99px 99px' }))
  } else if (kind === 'robot') {
    const tip =
      state === 'thinking' || state === 'busy' ? A('pet-pulse', '.8s ease-in-out infinite') : {}
    parts.push(
      box(48.5, 5, 3, 15, { background: shade }),
      box(43.5, 0, 13, 13, {
        background: off ? body : 'var(--color-accent-hot)',
        borderRadius: '50%',
        boxShadow: `0 0 0 ${t * 0.6}px ${shade}`,
        ...tip,
      }),
      box(4, 33, 10, 22, { background: shade, borderRadius: '30%' }),
      box(86, 33, 10, 22, { background: shade, borderRadius: '30%' }),
      box(12, 18, 76, 52, { background: body, borderRadius: '22%' }),
      box(28, 73, 44, 21, { background: body, borderRadius: '18% 18% 12% 12%' }),
      box(20, 26, 60, 36, { background: ink, borderRadius: '20%' }),
      box(46, 79, 8, 8, { background: ink, borderRadius: '50%' }),
    )
  } else {
    parts.push(
      box(10, 30, 80, 62, { background: body, borderRadius: '50% 50% 44% 44% / 64% 64% 36% 36%' }),
      box(24, 38, 13, 9, { background: light, borderRadius: '50%', transform: 'rotate(-24deg)' }),
    )
  }

  // Eyes.
  const e = F.e
  const blink = A('pet-blink', '4.2s ease-in-out infinite')
  const eye = (cx: number, cy: number, size: number, extra: CSSProperties = {}) =>
    box(cx - size / 2, cy - size / 2, size, size, {
      background: feat,
      borderRadius: kind === 'robot' ? '32%' : '50%',
      ...extra,
    })
  const arc = (cx: number, cy: number, side: 'borderBottom' | 'borderTop') =>
    box(cx - e * 0.7, cy - e * 0.45, e * 1.4, e * 1.2, {
      border: `${t}px solid transparent`,
      [side]: `${t}px solid ${feat}`,
      borderRadius: '50%',
      boxSizing: 'border-box',
    })
  const bar = (cx: number, cy: number, w: number, extra: CSSProperties = {}) =>
    box(cx - w / 2, cy - (t / S) * 50, w, (t / S) * 100, {
      background: feat,
      borderRadius: 99,
      ...extra,
    })
  const eyes: ReactNode[] = []
  for (const side of ['L', 'R'] as const) {
    const cx = side === 'L' ? F.eL : F.eR
    const cy = F.eyeY
    if (state === 'idle' || state === 'talking') eyes.push(eye(cx, cy, e, blink))
    else if (state === 'listening') eyes.push(arc(cx, cy + e * 0.15, 'borderBottom'))
    else if (state === 'happy') eyes.push(arc(cx, cy + e * 0.25, 'borderTop'))
    else if (state === 'sleeping') eyes.push(bar(cx, cy + e * 0.2, e * 1.3))
    else if (state === 'thinking') eyes.push(eye(cx + e * 0.22, cy - e * 0.25, e * 0.85))
    else if (state === 'busy')
      eyes.push(
        box(cx - e / 2 + e * 0.25, cy - e * 0.18, e, e * 0.42, {
          background: feat,
          borderRadius: 99,
        }),
      )
    else if (state === 'offline') eyes.push(bar(cx, cy + e * 0.1, e * 1.1))
    else if (state === 'confused') {
      eyes.push(eye(cx, cy, side === 'L' ? e * 1.25 : e * 0.7))
      if (side === 'R') eyes.push(bar(cx, cy - e * 1.05, e * 1.2, { transform: 'rotate(-14deg)' }))
    } else {
      eyes.push(eye(cx, cy + e * 0.2, e * 0.75))
      if (kind !== 'robot')
        eyes.push(
          bar(cx, cy - e * 0.85, e * 1.15, { transform: `rotate(${side === 'L' ? -16 : 16}deg)` }),
        )
    }
  }

  // Mouth.
  const mouth: ReactNode[] = []
  if (F.mY !== null) {
    const my = F.mY
    if (state === 'idle' || state === 'busy' || state === 'offline')
      mouth.push(bar(50, my, state === 'busy' ? 6 : 8))
    else if (state === 'listening')
      mouth.push(
        box(45, my - 4, 10, 6, {
          borderBottom: `${t}px solid ${feat}`,
          borderRadius: '0 0 50% 50% / 0 0 100% 100%',
          boxSizing: 'border-box',
        }),
      )
    else if (state === 'happy')
      mouth.push(
        box(43, my - 2.5, 14, 8, { background: feat, borderRadius: '0 0 50% 50% / 0 0 100% 100%' }),
      )
    else if (state === 'talking')
      mouth.push(
        box(45.5, my - 3.5, 9, 7, {
          background: feat,
          borderRadius: '50%',
          ...A('pet-talk', '.42s ease-in-out infinite alternate'),
        }),
      )
    else if (state === 'sleeping')
      mouth.push(
        box(47, my - 3, 6, 6, {
          border: `${t}px solid ${feat}`,
          borderRadius: '50%',
          boxSizing: 'border-box',
        }),
      )
    else if (state === 'sorry')
      mouth.push(
        box(45, my - 1, 10, 6, {
          borderTop: `${t}px solid ${feat}`,
          borderRadius: '50% 50% 0 0 / 100% 100% 0 0',
          boxSizing: 'border-box',
        }),
      )
    else if (state === 'confused') mouth.push(bar(51, my, 9, { transform: 'rotate(-14deg)' }))
    else mouth.push(bar(54, my, 6))
  }

  // Headphones belong to the body, so they move with it.
  const phones: ReactNode[] = []
  if (state === 'listening') {
    const [bx, by, bw, bh] = PHONES[kind].band
    phones.push(
      box(bx, by, bw, bh, {
        border: `${S * 0.055}px solid transparent`,
        borderTopColor: 'var(--color-text)',
        borderRadius: '50%',
        boxSizing: 'border-box',
      }),
    )
    for (const [x, y, w, h] of PHONES[kind].cups)
      phones.push(box(x, y, w, h, { background: 'var(--color-text)', borderRadius: '34%' }))
  }

  const bodyAnim: CSSProperties = {
    idle: A('pet-breathe', '3.6s ease-in-out infinite'),
    listening: A('pet-sway', '2.2s ease-in-out infinite alternate'),
    sleeping: A('pet-breathe', '5s ease-in-out infinite'),
    thinking: { transform: 'rotate(3deg)' },
    talking: A('pet-bob', '1.1s ease-in-out infinite'),
    happy: A('pet-hop', '.95s ease-in-out infinite'),
    confused: { transform: 'rotate(-9deg)', ...A('pet-tilt', '2.4s ease-in-out infinite') },
    sorry: {
      transform: 'translateY(3%) rotate(2deg)',
      ...A('pet-droop', '3s ease-in-out infinite'),
    },
    busy: {},
    offline: { opacity: 0.9 },
  }[state]

  const outline: CSSProperties = ring
    ? {
        filter: ['1.5px 0', '-1.5px 0', '0 1.5px', '0 -1.5px']
          .map((offset) => `drop-shadow(${offset} 0 var(--color-canvas))`)
          .join(' '),
      }
    : {}

  // Accessories outside the body.
  const fs = S * 0.3
  const glyph = (
    x: number,
    y: number,
    text: string,
    size: number,
    color: string,
    extra: CSSProperties = {},
  ) =>
    box(
      x,
      y,
      0,
      0,
      { overflow: 'visible' },
      <span
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          fontSize: size,
          lineHeight: 1,
          fontWeight: 700,
          color,
          display: 'block',
          transformOrigin: '50% 50%',
          ...extra,
        }}
      >
        {text}
      </span>,
    )
  const acc: ReactNode[] = []
  if (state === 'listening')
    acc.push(glyph(94, 4, '♪', fs, 'var(--color-accent)', A('pet-rise', '3.4s ease-out infinite')))
  if (state === 'sleeping') {
    acc.push(
      glyph(80, 4, 'z', fs * 0.8, 'var(--color-muted)', A('pet-rise', '3s ease-out infinite')),
    )

    acc.push(
      glyph(
        92,
        -6,
        'z',
        fs * 0.62,
        'var(--color-muted)',
        A('pet-rise', '3s ease-out 1.5s infinite backwards'),
      ),
    )
  }

  if (state === 'thinking') {
    acc.push(
      box(66, 14, 8, 8, {
        background: 'var(--color-raised)',
        border: '1px solid var(--color-line-strong)',
        borderRadius: '50%',
      }),
      box(
        68,
        -10,
        40,
        24,
        {
          background: 'var(--color-raised)',
          border: '1px solid var(--color-line-strong)',
          borderRadius: 99,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '12%',
        },
        ...[0, 1, 2].map((i) => (
          <i
            key={i}
            style={{
              width: S * 0.06,
              height: S * 0.06,
              borderRadius: '50%',
              background: 'var(--color-text)',
              ...anim(motion, 'pet-dot', `1.2s ease-in-out ${i * 0.2}s infinite`),
            }}
          />
        )),
      ),
    )
  }

  if (state === 'talking') {
    const line = (width: string) => (
      <i
        style={{
          height: Math.max(1.5, S * 0.035),
          borderRadius: 99,
          background: 'var(--color-muted)',
          width,
        }}
      />
    )
    acc.push(
      box(
        68,
        -10,
        40,
        24,
        {
          background: 'var(--color-raised)',
          border: '1px solid var(--color-line-strong)',
          borderRadius: '40% 40% 40% 8%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: '14%',
          padding: '0 16%',
          boxSizing: 'border-box',
        },
        <span key="a" style={{ display: 'contents' }}>
          {line('100%')}
        </span>,
        <span key="b" style={{ display: 'contents' }}>
          {line('60%')}
        </span>,
      ),
    )
  }

  if (state === 'happy') {
    acc.push(
      glyph(
        -8,
        14,
        '✦',
        fs * 0.7,
        'var(--color-accent-hot)',
        A('pet-twinkle', '1.4s ease-in-out infinite'),
      ),
    )

    acc.push(
      glyph(
        92,
        0,
        '✦',
        fs * 0.55,
        'var(--color-accent-hot)',
        A('pet-twinkle', '1.4s ease-in-out .7s infinite'),
      ),
    )
  }
  if (state === 'confused')
    acc.push(
      glyph(84, -14, '?', fs * 1.05, 'var(--color-text)', {
        transform: 'rotate(12deg)',
        ...A('pet-pulse', '1.6s ease-in-out infinite'),
      }),
    )
  if (state === 'sorry')
    acc.push(
      box(
        84,
        22,
        9,
        13,
        {
          background: 'var(--color-muted)',
          borderRadius: '0 50% 50% 50%',
          transform: 'rotate(45deg)',
        },
        <i
          key="x"
          style={{ position: 'absolute', inset: 0, ...A('pet-drip', '2.4s ease-in infinite') }}
        />,
      ),
    )
  if (state === 'busy')
    acc.push(
      box(80, 54, 26, 26, {
        border: `${Math.max(2, S * 0.05)}px solid color-mix(in oklab, var(--color-muted) 45%, transparent)`,
        borderTopColor: 'var(--color-accent)',
        borderRadius: '50%',
        boxSizing: 'border-box',
        ...A('pet-spin', '1s linear infinite'),
      }),
    )
  if (state === 'offline')
    acc.push(
      box(84, 90, 16, 3, { background: 'var(--color-muted)', borderRadius: 2 }),
      box(99, 84, 9, 15, { background: 'var(--color-muted)', borderRadius: 2 }),
      box(108, 87, 6, 2.6, { background: 'var(--color-muted)' }),
      box(108, 94, 6, 2.6, { background: 'var(--color-muted)' }),
    )

  return (
    <span
      className="relative block"
      style={{ width: S, height: S, ...outline }}
      data-pet-state={state}
    >
      <span
        className="absolute left-0 block size-full"
        style={{
          top: BODY_TOP[kind],
          transformOrigin: '50% 100%',
          willChange: bodyAnim.animation ? 'transform' : undefined,
          ...bodyAnim,
        }}
      >
        {parts}
        {eyes}
        {mouth}
        {phones}
      </span>
      {acc}
    </span>
  )
}
