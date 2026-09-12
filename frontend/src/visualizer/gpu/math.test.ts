import { describe, expect, it } from 'vitest'

import { cameraBasis, lookAt, multiply, perspective, transform } from './math'

const dot = (a: readonly number[], b: readonly number[]) =>
  (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0)

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

describe('camera basis', () => {
  it('points forward at the target with right and up square to it', () => {
    const basis = cameraBasis([0, 0, 3], [0, 0, 0], [0, 1, 0])
    expect(basis.forward).toEqual([0, 0, -1])
    expect(basis.right[0]).toBeCloseTo(1, 6)
    expect(basis.up[1]).toBeCloseTo(1, 6)
  })

  it('stays orthonormal from anywhere on an orbit', () => {
    for (const yaw of [0, 0.7, 2.2, 4.9]) {
      for (const lift of [-2, 0, 1.5]) {
        const eye = [Math.sin(yaw) * 5, lift, Math.cos(yaw) * 5] as const
        const basis = cameraBasis(eye, [0, 0, 0], [0, 1, 0])
        expect(dot(basis.forward, basis.forward)).toBeCloseTo(1, 6)
        expect(dot(basis.right, basis.right)).toBeCloseTo(1, 6)
        expect(dot(basis.up, basis.up)).toBeCloseTo(1, 6)
        expect(dot(basis.forward, basis.right)).toBeCloseTo(0, 6)
        expect(dot(basis.right, basis.up)).toBeCloseTo(0, 6)
      }
    }
  })

  it('borrows another axis when the camera looks straight along the up vector', () => {
    const basis = cameraBasis([0, 5, 0], [0, 0, 0], [0, 1, 0])
    expect(basis.forward).toEqual([0, -1, 0])
    expect(dot(basis.right, basis.right)).toBeCloseTo(1, 6)
    expect(dot(basis.up, basis.up)).toBeCloseTo(1, 6)
    expect(dot(basis.forward, basis.right)).toBeCloseTo(0, 6)
  })
})
