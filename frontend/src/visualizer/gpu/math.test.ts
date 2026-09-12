import { describe, expect, it } from 'vitest'

import { lookAt, multiply, perspective, transform } from './math'

describe('camera maths', () => {
  it('maps the near plane to depth 0 and the far plane to depth 1', () => {
    const projection = perspective(Math.PI / 3, 16 / 9, 0.1, 10)
    const near = transform(projection, [0, 0, -0.1])
    const far = transform(projection, [0, 0, -10])
    expect(near[2] / near[3]).toBeCloseTo(0)
    expect(far[2] / far[3]).toBeCloseTo(1)
    expect(near[3]).toBeCloseTo(0.1)
  })

  it('looks from the eye at the target down -z', () => {
    const view = lookAt([0, 0, 3], [0, 0, 0], [0, 1, 0])
    expect(transform(view, [0, 0, 0]).slice(0, 3)).toEqual([0, 0, -3])
    expect(transform(view, [1, 0, 3]).slice(0, 3)).toEqual([1, 0, 0])
  })

  it('multiplies in column-major order', () => {
    const projection = perspective(Math.PI / 3, 1, 0.1, 10)
    const view = lookAt([0, 0, 3], [0, 0, 0], [0, 1, 0])
    const combined = multiply(projection, view)
    const direct = transform(
      projection,
      transform(view, [0.5, 0, 0]).slice(0, 3) as [number, number, number],
    )
    const viaMatrix = transform(combined, [0.5, 0, 0])
    for (let i = 0; i < 4; i++) expect(viaMatrix[i]).toBeCloseTo(direct[i] ?? 0)
  })
})
