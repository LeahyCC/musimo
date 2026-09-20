import { describe, expect, it } from 'vitest'

import { controlsSchema, jobSchema } from './api'
import { destinationBroken, pausedSources, siteLabel } from './download-target'
import { initialSelection, landingNote } from './links'

type Preview = Parameters<typeof initialSelection>[0]

const entry = (id: string, owned = false) => ({
  id,
  title: `Song ${id}`,
  artist: 'Band',
  album: '',
  date: '',
  duration: 100,
  art: '',
  owned,
  lands: '',
})

const preview = (site: string, over: Partial<Preview>): Preview => ({
  token: 't',
  site,
  single: false,
  profile: false,
  title: 'Title',
  truncated: false,
  partial: false,
  quality_note: '',
  entries: [entry('a'), entry('b', true), entry('c')],
  ...over,
})

describe('what is ticked when a link sheet opens', () => {
  it('starts a profile on Bandcamp, SoundCloud and Audius with nothing ticked', () => {
    for (const site of ['Bandcamp', 'SoundCloud', 'Audius']) {
      expect(initialSelection(preview(site, { profile: true }))).toEqual(new Set())
    }
  })

  it('ticks a release or playlist except the songs already owned', () => {
    for (const site of ['Bandcamp', 'SoundCloud', 'Audius', 'Jamendo']) {
      expect(initialSelection(preview(site, {}))).toEqual(new Set(['a', 'c']))
    }
  })

  it('ticks a lone track even when a copy is owned, and even on a profile flag', () => {
    const owned = { single: true, entries: [entry('a', true)] }
    expect(initialSelection(preview('Audiomack', owned))).toEqual(new Set(['a']))
    expect(initialSelection(preview('Audiomack', { ...owned, profile: true }))).toEqual(
      new Set(['a']),
    )
  })
})

describe('site names', () => {
  it('uses the name the server sent and only builds one for an older server', () => {
    expect(siteLabel('archive', 'Internet Archive')).toBe('Internet Archive')
    expect(siteLabel('bandcamp', 'Bandcamp')).toBe('Bandcamp')
    expect(siteLabel('bandcamp')).toBe('Bandcamp')
    expect(siteLabel('soundcloud', '')).toBe('Soundcloud')
  })

  it('reads the label a job carries, and none from an older server', () => {
    const job = {
      id: 'a',
      format: 'original',
      target: '/x',
      stage: 'queued',
      desired: 'run',
      meta: { id: 1, title: 't', artist: 'a', album: 'b', art: '', duration: 1 },
      candidates: [],
      selected: '',
      check_match: false,
      attempts: 0,
      retry_at: 0,
      progress: 0,
      downloaded: 0,
      total: 0,
      speed: 0,
      eta: null,
      error_code: '',
      error: '',
      retryable: false,
      error_hint: '',
      error_fix: '',
      tool_tail: '',
      tool_version: '',
      warnings: [],
      final_path: '',
      codec: '',
      actual_bitrate: 0,
      created_at: 0,
      updated_at: 0,
      hidden: false,
      track_id: 1,
    }
    expect(jobSchema.parse({ ...job, source_label: 'Bandcamp' }).source_label).toBe('Bandcamp')
    expect(jobSchema.parse(job).source_label).toBeUndefined()
  })
})

describe('paused sources', () => {
  it('names every paused source from the server', () => {
    const controls = controlsSchema.parse({
      paused: false,
      source_paused: true,
      paused_sources: ['bandcamp', 'youtube'],
      source_labels: { bandcamp: 'Bandcamp', youtube: 'YouTube' },
    })
    expect(pausedSources(controls)).toEqual([
      { source: 'bandcamp', label: 'Bandcamp' },
      { source: 'youtube', label: 'YouTube' },
    ])
  })

  it('still shows YouTube for a server that only sends the old flag', () => {
    const controls = controlsSchema.parse({ paused: false, source_paused: true })
    expect(pausedSources(controls)).toEqual([{ source: 'youtube', label: 'YouTube' }])
  })

  it('shows nothing when nothing is paused', () => {
    expect(pausedSources(controlsSchema.parse({ paused: false, source_paused: false }))).toEqual([])
    expect(pausedSources(undefined)).toEqual([])
  })
})

describe('a destination that cannot be written to', () => {
  const disks = [
    { path: '/music', exists: true, writable: true },
    { path: '/ro', exists: true, writable: false },
    { path: '/gone', exists: false, writable: true },
  ]

  it('is broken when it is read-only, missing or not a known mount', () => {
    expect(destinationBroken(disks, '/ro')).toBe(true)
    expect(destinationBroken(disks, '/gone')).toBe(true)
    expect(destinationBroken(disks, '/other')).toBe(true)
  })

  it('is fine when it can be written to, and not judged before the disks are known', () => {
    expect(destinationBroken(disks, '/music')).toBe(false)
    expect(destinationBroken(undefined, '/ro')).toBe(false)
    expect(destinationBroken(disks, '')).toBe(false)
  })
})

describe('where a mix or show will be filed', () => {
  const mix = (id: string, lands: string) => ({ ...entry(id), lands })

  it('says nothing for songs', () => {
    expect(landingNote([])).toBe('')
    expect(landingNote([entry('a'), entry('b')])).toBe('')
  })

  it('names the whole path for one mix', () => {
    expect(landingNote([mix('a', 'Mixes/DJ Rex/2024-03-02 - Mix 1')])).toBe(
      'Saved as Mixes/DJ Rex/2024-03-02 - Mix 1',
    )
  })

  it('names the folder for several, and skips the songs among them', () => {
    const chosen = [
      mix('a', 'Mixes/DJ Rex/2024-03-02 - Mix 1'),
      entry('b'),
      mix('c', 'Mixes/Ann/x'),
    ]
    expect(landingNote(chosen)).toBe('Saved under Mixes/, in a folder for each uploader')
  })
})
