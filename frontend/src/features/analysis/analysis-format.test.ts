import { describe, expect, it } from 'vitest'

import type { AnalysisSong } from '../../api'
import {
  clock,
  gigabytes,
  percent,
  roughly,
  seenAgo,
  spoken,
  startCommand,
  tempoText,
  workerLine,
} from './analysis-format'

const song = (changes: Partial<AnalysisSong>): AnalysisSong => ({
  id: 'tr-0123456789abcdef',
  title: 'Song',
  artist: 'Artist',
  album: 'Album',
  duration: 200,
  bpm: 128.4,
  reading: 128.4,
  check: 128.2,
  sure: true,
  why: '',
  energy: 0.05,
  band: 'medium',
  sections: [19, 95, 171],
  ...changes,
})

describe('song analysis wording', () => {
  it('names one command per device', () => {
    expect(startCommand('cpu')).toBe('docker compose --profile analysis up -d audio-worker')
    expect(startCommand('gpu')).toBe('docker compose --profile analysis-gpu up -d audio-worker-gpu')
  })

  it('says a time the way a person would', () => {
    expect(spoken(20)).toBe('under a minute')
    expect(spoken(61)).toBe('1 min')
    expect(spoken(59 * 60)).toBe('59 min')
    expect(spoken(8.5 * 3600)).toBe('about 8 h 30 min')
    expect(spoken(8 * 3600)).toBe('about 8 h')
    expect(spoken(3 * 3600 - 10)).toBe('about 3 h')
    expect(spoken(79 * 3600)).toBe('about 79 h')
    expect(spoken(-1)).toBe('')
    expect(spoken(Number.NaN)).toBe('')
    expect(roughly(8 * 3600)).toBe('About 8 h')
    expect(roughly(12 * 60)).toBe('About 12 min')
    expect(roughly(5)).toBe('Under a minute')
  })

  it('describes the worker', () => {
    expect(
      workerLine({
        version: '0.5.0',
        device: 'cuda',
        gpu: 'NVIDIA GeForce RTX 5080',
        decoders: 4,
        memory_limit: 4 * 1024 ** 3,
        cpus: 4,
        note: '',
        seen_at: '',
        seconds_ago: 3,
        running: true,
      }),
    ).toBe('graphics card (NVIDIA GeForce RTX 5080), 4 decoders, 4 GB')

    expect(
      workerLine({
        version: '',
        device: 'cpu',
        gpu: '',
        decoders: 1,
        memory_limit: null,
        cpus: null,
        note: '',
        seen_at: '',
        seconds_ago: 3,
        running: true,
      }),
    ).toBe('CPU, 1 decoder')
    expect(gigabytes(2147483648)).toBe('2 GB')
    expect(gigabytes(10.7 * 1024 ** 3)).toBe('11 GB')
    expect(gigabytes(null)).toBe('')
    expect(seenAgo(0.4)).toBe('just now')
    expect(seenAgo(14)).toBe('14 s ago')
    expect(seenAgo(600)).toBe('10 min ago')
  })

  it('keeps progress between 0 and 100', () => {
    expect(percent(82, 100)).toBe(82)
    expect(percent(5, 0)).toBe(0)
    expect(percent(120, 100)).toBe(100)
  })

  it('shows what was read for an unsure song', () => {
    expect(tempoText(song({}))).toBe('128 BPM')
    expect(tempoText(song({ bpm: null, reading: 141.2, sure: false }))).toBe('read 141, unsure')
    expect(tempoText(song({ bpm: null, reading: null, sure: false }))).toBe('no tempo')
    expect(clock(19.6)).toBe('0:19')
    expect(clock(171)).toBe('2:51')
  })
})
