import { describe, expect, it } from 'vitest'

import { catalogCardSource, firstLiveSource, siteLabel } from './download-target'
import type { CatalogSourceChoice } from './download-target'

const choice = (over: Partial<CatalogSourceChoice> = {}): CatalogSourceChoice => ({
  source_order: ['deezer', 'youtube'],
  disabled_sources: [],
  deezer_audio: true,
  deezer_arl: '',
  ...over,
})

const queued = {
  catalog: 'deezer',
  stage: 'queued',
  lap: 0,
  selected: '',
  source: 'youtube',
  source_label: 'YouTube',
}

describe('first catalog source', () => {
  it('skips a source that is turned off', () => {
    expect(
      firstLiveSource(
        choice({ source_order: ['soundcloud', 'deezer'], disabled_sources: ['youtube'] }),
        [],
      ),
    ).toBe('soundcloud')

    expect(
      firstLiveSource(
        choice({
          source_order: ['youtube', 'soundcloud'],
          disabled_sources: ['youtube'],
        }),
        [],
      ),
    ).toBe('soundcloud')
  })

  it('keeps youtube when it is first and on', () => {
    expect(
      firstLiveSource(choice({ source_order: ['youtube', 'soundcloud'], deezer_audio: false }), []),
    ).toBe('youtube')
  })

  it('skips deezer until the account can save a file', () => {
    expect(firstLiveSource(choice({ source_order: ['deezer', 'soundcloud'] }), [])).toBe(
      'soundcloud',
    )

    expect(
      firstLiveSource(
        choice({ source_order: ['deezer', 'youtube'], deezer_arl: 'a'.repeat(192) }),
        [],
      ),
    ).toBe('deezer')

    expect(
      firstLiveSource(
        choice({
          source_order: ['deezer', 'youtube'],
          deezer_audio: false,
          deezer_arl: 'a'.repeat(192),
        }),
        [],
      ),
    ).toBe('youtube')
  })

  it('skips a paused source when another row can run', () => {
    expect(
      firstLiveSource(choice({ source_order: ['youtube', 'soundcloud'], deezer_audio: false }), [
        'youtube',
      ]),
    ).toBe('soundcloud')
  })

  it('names the paused row when nothing else can run', () => {
    expect(
      firstLiveSource(choice({ source_order: ['youtube'], deezer_audio: false }), ['youtube']),
    ).toBe('youtube')

    expect(
      firstLiveSource(
        choice({ source_order: ['youtube', 'soundcloud'], disabled_sources: ['youtube'] }),
        ['soundcloud'],
      ),
    ).toBe('soundcloud')
  })
})

describe('catalog card source', () => {
  it('uses the job source until settings are loaded', () => {
    expect(
      catalogCardSource(
        { ...queued, source: 'soundcloud', source_label: 'SoundCloud' },
        undefined,
        [],
      ),
    ).toEqual({ source: 'soundcloud', label: 'SoundCloud' })
  })

  it('does not flip when the stored source is already the first live row', () => {
    const shown = catalogCardSource(
      queued,
      choice({ source_order: ['youtube', 'soundcloud'], deezer_audio: false }),
      [],
    )
    expect(shown).toEqual({ source: 'youtube', label: 'YouTube' })
    expect(siteLabel(shown.source, shown.label)).toBe('YouTube')
  })

  it('follows a source turned off while the job is still queued', () => {
    const shown = catalogCardSource(
      queued,
      choice({ source_order: ['youtube', 'soundcloud'], disabled_sources: ['youtube'] }),
      [],
      { soundcloud: 'SoundCloud' },
    )
    expect(siteLabel(shown.source, shown.label)).toBe('SoundCloud')
  })

  it('keeps a hand-picked recording, a link, and a source the worker already asked', () => {
    const soundcloud = choice({ source_order: ['soundcloud'], deezer_audio: false })
    expect(
      catalogCardSource(
        { ...queued, source: 'youtube', selected: 'abcdefghijk', source_label: 'YouTube' },
        soundcloud,
        [],
      ).source,
    ).toBe('youtube')

    expect(
      catalogCardSource(
        { ...queued, catalog: 'link', source: 'bandcamp', source_label: 'Bandcamp' },
        soundcloud,
        [],
      ).source,
    ).toBe('bandcamp')

    expect(
      catalogCardSource(
        { ...queued, source: 'deezer', source_label: 'Deezer', lap: 1 },
        soundcloud,
        [],
      ).source,
    ).toBe('deezer')

    expect(
      catalogCardSource(
        { ...queued, stage: 'matching', source: 'youtube', source_label: 'YouTube' },
        soundcloud,
        [],
      ).source,
    ).toBe('youtube')
  })

  it('does not invent youtube when every row is off', () => {
    expect(
      catalogCardSource(
        queued,
        choice({ source_order: ['youtube'], disabled_sources: ['youtube'], deezer_audio: false }),
        [],
      ).source,
    ).toBe('')
  })
})
