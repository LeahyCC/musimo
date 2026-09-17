import { describe, expect, it } from 'vitest'

import { buttonClassName } from './button'
import { textLinkClassName } from './text-link'

describe('buttonClassName', () => {
  it('defaults to the default variant', () => {
    expect(buttonClassName()).toContain('bg-hover')
  })

  it('picks the requested variant', () => {
    expect(buttonClassName('primary')).toContain('bg-accent')
    expect(buttonClassName('danger')).toContain('text-danger')
  })

  it('appends an extra class name', () => {
    expect(buttonClassName('default', 'w-full')).toMatch(/\bw-full$/)
  })
})

describe('textLinkClassName', () => {
  it('carries the text-link look', () => {
    expect(textLinkClassName()).toContain('text-accent')
  })

  it('appends an extra class name', () => {
    expect(textLinkClassName('ml-auto')).toMatch(/\bml-auto$/)
  })
})
