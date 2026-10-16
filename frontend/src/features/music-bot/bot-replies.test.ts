import { describe, expect, it } from 'vitest'

import { botReplySchema, libraryTrackSchema } from '../../api'
import type { BotReply } from '../../api'
import {
  appliedText,
  cardLine,
  explainFailure,
  filterChips,
  isDirectCommand,
  lengthText,
  loosenChips,
  resultLine,
  shortMinutes,
  withoutSong,
} from './bot-replies'

const plan: Record<string, unknown> = {
  action: 'search',
  scope: 'library',
  artists: [],
  exclude_artists: [],
  genres: [],
  year_from: null,
  year_to: null,
  favourites: false,
  history: 'any',
  exclude_played_days: 0,
  min_seconds: 0,
  max_seconds: null,
  target_seconds: 0,
  limit: 100,
  similar_to_current: false,
  explanation: '',
}

function reply(
  changes: Record<string, unknown> = {},
  songs = 3,
  extra: Partial<BotReply> = {},
): BotReply {
  const tracks = Array.from({ length: songs }, (_, index) =>
    libraryTrackSchema.parse({ id: `tr-${index}`, title: `Song ${index}`, duration: 240 }),
  )
  return botReplySchema.parse({
    plan: { ...plan, ...changes },
    tracks,
    total_seconds: songs * 240,
    shortfall_seconds: 0,
    summary: `${songs} songs. Based on saved library tags.`,
    elapsed_ms: 10,
    ...extra,
  })
}

describe('botReplySchema', () => {
  it('fills the song characteristic fields an older server leaves out', () => {
    const parsed = reply().plan
    expect(parsed.tempo).toBe('')
    expect(parsed.tempo_min).toBeNull()
    expect(parsed.energy_compared).toBe('')
    expect(parsed.sound).toBe('')
    expect(reply({ energy: 'low', tempo_max: 100, sound: 'dreamy guitar' }).plan).toMatchObject({
      energy: 'low',
      tempo_max: 100,
      sound: 'dreamy guitar',
    })
  })
})

describe('filterChips', () => {
  it('shows nothing for an open search', () => {
    expect(filterChips(reply().plan)).toEqual([])
  })

  it('names every active filter, each with a follow-up that removes it', () => {
    const chips = filterChips(
      reply({
        favourites: true,
        genres: ['hip hop'],
        exclude_artists: ['The Sugarhill Gang'],
        year_from: 1980,
        year_to: 1989,
        exclude_played_days: 1,
        target_seconds: 3600,
      }).plan,
    )
    expect(chips.map((chip) => `${chip.label}${chip.value}`)).toEqual([
      'Favourites',
      'Genre hip hop',
      'Excluding The Sugarhill Gang',
      'Years 1980–1989',
      'Not played today',
      'Length about 60 min',
    ])

    expect(chips.find((chip) => chip.value === 'The Sugarhill Gang')?.followUp).toBe(
      'allow The Sugarhill Gang again',
    )

    expect(chips.find((chip) => chip.value === 'Not played today')?.followUp).toBe(
      'allow songs played today',
    )
  })

  it('reads open-ended years', () => {
    expect(filterChips(reply({ year_from: 2000 }).plan)[0]?.value).toBe('2000 or later')
    expect(filterChips(reply({ year_to: 1970 }).plan)[0]?.value).toBe('1970 or earlier')
  })
})

describe('result wording', () => {
  it('sums up a replaced result in one line', () => {
    expect(cardLine(reply({ favourites: true, year_from: 1990, year_to: 1999 }, 16))).toBe(
      '16 songs · 64 min · Favourites, 1990–1999',
    )
  })

  it('reads lengths as the card shows them', () => {
    expect(lengthText(48 * 60)).toBe('48 min')
    expect(lengthText(3600)).toBe('1 h 0 min')
    expect(lengthText(473 * 60)).toBe('7 h 53 min')
  })

  it('never claims more than the tags', () => {
    for (const line of [
      resultLine(reply()),
      resultLine(reply({}, 0)),
      resultLine(reply({}, 2, { shortfall_seconds: 720 })),
    ]) {
      expect(line).not.toMatch(/hear|sound|vibe|mood|energy/i)
    }
    expect(resultLine(reply({ explanation: 'Rewound a decade.' }))).toBe('Rewound a decade.')
  })

  it('reports a shortfall in whole minutes', () => {
    expect(shortMinutes(reply({}, 2, { shortfall_seconds: 720 }))).toBe(12)
    expect(shortMinutes(reply())).toBe(0)
  })

  it('offers to loosen up to three filters, never the length', () => {
    const offered = loosenChips(
      reply(
        {
          favourites: true,
          genres: ['bossa nova'],
          year_from: 2000,
          year_to: 2009,
          history: 'unplayed',
          target_seconds: 3600,
        },
        0,
      ).plan,
    )
    expect(offered).toHaveLength(3)
    expect(offered.map((chip) => chip.followUp)).not.toContain('no length target')
  })

  it('says what each action did', () => {
    expect(appliedText('play', 15, true)).toBe('Playing now. These 15 songs replaced your queue.')
    // Loaded is not playing: a blocked autoplay must not read as music.
    expect(appliedText('play', 15, false)).toBe('These 15 songs replaced your queue.')
    expect(appliedText('replace', 1, true)).toMatch(/current song keeps playing/)
  })
})

describe('isDirectCommand', () => {
  it('takes only plain player commands', () => {
    expect(isDirectCommand('Pause.', 'pause')).toBe(true)
    expect(isDirectCommand('next track', 'skip')).toBe(true)
    expect(isDirectCommand('could you stop this for a sec', 'pause')).toBe(false)
    expect(isDirectCommand('skip', 'pause')).toBe(false)
  })
})

describe('explainFailure', () => {
  it('turns a moved queue into Send again', () => {
    expect(explainFailure('The queue changed. Ask again before applying.', 'apply')).toMatchObject({
      tone: 'warn',
      next: 'send-again',
    })
  })

  it('keeps the player’s own words for the 500-song limit', () => {
    const message =
      'The queue is full. It holds 500 songs and this would make 572. Nothing was added.'
    expect(explainFailure(message, 'apply')).toEqual({
      aside: 'No room on the shelf!',
      text: message,
      tone: 'danger',
      next: 'replace',
    })
  })

  it('explains an unusable model answer and offers a retry', () => {
    const failure = explainFailure(
      'The model returned an invalid plan. Nothing changed. Try another model.',
      'request',
    )
    expect(failure.next).toBe('retry')
    expect(failure.text).toMatch(/nothing changed/i)
  })

  it('passes other messages through', () => {
    expect(
      explainFailure('Cannot reach Ollama. Check its address in Settings.', 'request'),
    ).toMatchObject({
      text: 'Cannot reach Ollama. Check its address in Settings.',
      next: 'retry',
    })
  })
})

describe('withoutSong', () => {
  it('rewrites the count, the minutes and the shortfall in the server’s own words', () => {
    const before = reply({ target_seconds: 3600, favourites: true }, 3, {
      summary:
        '3 songs, 12.0 minutes. Based on saved library tags. Favourites are songs in your Liked playlist. 48.0 minutes short; no exclusions were relaxed.',
      shortfall_seconds: 2880,
    })
    const after = withoutSong(before, 'tr-1')
    expect(after.tracks.map((track) => track.id)).toEqual(['tr-0', 'tr-2'])
    expect(after.total_seconds).toBe(480)
    expect(after.shortfall_seconds).toBe(3120)
    expect(after.summary).toBe(
      '2 songs, 8.0 minutes. Based on saved library tags. Favourites are songs in your Liked playlist. 52.0 minutes short; no exclusions were relaxed.',
    )
    expect(shortMinutes(after)).toBe(52)
  })

  it('adds a shortfall where removing a song opens one, and keeps the rest of the summary', () => {
    const before = reply({ target_seconds: 700 }, 3, {
      summary:
        '3 songs, 12.0 minutes. Based on saved library tags. Similarity uses artist or genre tags, not audio analysis.',
    })
    expect(withoutSong(before, 'tr-0').summary).toBe(
      '2 songs, 8.0 minutes. Based on saved library tags. 3.7 minutes short; no exclusions were relaxed. Similarity uses artist or genre tags, not audio analysis.',
    )
  })

  it('reads one song in the singular and leaves an unknown id alone', () => {
    const before = reply({}, 2, { summary: '2 songs, 8.0 minutes. Based on saved library tags.' })
    expect(withoutSong(before, 'tr-0').summary).toBe(
      '1 song, 4.0 minutes. Based on saved library tags.',
    )
    expect(withoutSong(before, 'tr-none')).toBe(before)
  })
})
