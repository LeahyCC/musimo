import type { BotReply } from '../../api'
import type { BotQueueAction } from '../player/player'

/* The music bot's words around a server answer: the filter chips on a result, the follow-up a chip
   sends when it is removed, the one line the pet says, and how a failure is explained. The server
   decides which songs fit; nothing here adds or invents any. Copy never rates how a song sounds,
   because the pet cannot hear it. */

type Plan = BotReply['plan']

export type FilterChip = {
  /** A small muted prefix such as "Years". Empty for a chip that names itself. */
  label: string
  value: string
  /** What removing the chip asks for. It goes through the model like anything typed. */
  followUp: string
}

const minutes = (seconds: number) => Math.round(seconds / 60)

/** "48 min" or "1 h 0 min", the result card's totals. */
export function lengthText(seconds: number): string {
  const total = minutes(seconds)
  return total >= 60 ? `${Math.floor(total / 60)} h ${total % 60} min` : `${total} min`
}

function yearsText(plan: Plan): string | null {
  const { year_from: from, year_to: to } = plan
  if (from !== null && to !== null) return from === to ? `${from}` : `${from}–${to}`
  if (from !== null) return `${from} or later`
  if (to !== null) return `${to} or earlier`
  return null
}

const HISTORY_CHIPS: Record<Exclude<Plan['history'], 'any'>, FilterChip> = {
  played: { label: '', value: 'Played before', followUp: 'include songs I have never played' },
  unplayed: { label: '', value: 'Unplayed', followUp: 'allow songs I have played' },
  familiar: { label: '', value: 'Most played first', followUp: 'any play count' },
}

/** One chip per active filter, in the order the design lists them. */
export function filterChips(plan: Plan): FilterChip[] {
  const chips: FilterChip[] = []
  if (plan.favourites)
    chips.push({ label: '', value: 'Favourites', followUp: 'not just my favourites' })
  for (const genre of plan.genres)
    chips.push({ label: 'Genre ', value: genre, followUp: `any genre, not just ${genre}` })
  for (const artist of plan.artists)
    chips.push({ label: 'Artist ', value: artist, followUp: `any artist, not just ${artist}` })
  for (const artist of plan.exclude_artists)
    chips.push({ label: 'Excluding ', value: artist, followUp: `allow ${artist} again` })
  const years = yearsText(plan)
  if (years) chips.push({ label: 'Years ', value: years, followUp: 'any year' })
  if (plan.history !== 'any') chips.push(HISTORY_CHIPS[plan.history])
  if (plan.exclude_played_days === 1)
    chips.push({ label: '', value: 'Not played today', followUp: 'allow songs played today' })
  else if (plan.exclude_played_days > 1)
    chips.push({
      label: '',
      value: `Not played in ${plan.exclude_played_days} days`,
      followUp: 'allow recently played songs',
    })
  if (plan.min_seconds)
    chips.push({
      label: 'Songs over ',
      value: `${minutes(plan.min_seconds)} min`,
      followUp: 'any song length',
    })
  if (plan.max_seconds !== null)
    chips.push({
      label: 'Songs under ',
      value: `${Math.max(1, minutes(plan.max_seconds))} min`,
      followUp: 'any song length',
    })
  if (plan.target_seconds)
    chips.push({
      label: 'Length ',
      value: `about ${minutes(plan.target_seconds)} min`,
      followUp: 'no length target',
    })
  return chips
}

/** The compact line an older result keeps once a newer one replaces it. */
export function cardLine(reply: BotReply): string {
  const count = reply.tracks.length
  const parts = [
    `${count} ${count === 1 ? 'song' : 'songs'}`,
    `${minutes(reply.total_seconds)} min`,
  ]
  const filters = filterChips(reply.plan)
    .slice(0, 2)
    .map((chip) => chip.value)
  return [...parts, ...(filters.length ? [filters.join(', ')] : [])].join(' · ')
}

/** Whether a result is short of the length asked for. */
export const shortMinutes = (reply: BotReply) =>
  reply.shortfall_seconds > 0 ? Math.max(1, minutes(reply.shortfall_seconds)) : 0

/** The pet's own line above a result. The numbers stay in the card, which the server wrote. */
export function resultLine(reply: BotReply): string {
  if (reply.plan.explanation.trim()) return reply.plan.explanation.trim()
  if (!reply.tracks.length)
    return 'I looked everywhere. Nothing in your library matches all of that.'
  if (shortMinutes(reply))
    return 'The shelf is a little bare for this one. Here’s everything that fits.'
  return 'Here’s what I found in your library.'
}

/** Up to three follow-ups that each loosen one filter, offered when nothing matched. */
export const loosenChips = (plan: Plan): FilterChip[] =>
  filterChips(plan)
    .filter((chip) => chip.followUp !== 'no length target')
    .slice(0, 3)

/* Model output alone never moves the player. Only a plain, unambiguous command does. */
const DIRECT: Record<'pause' | 'resume' | 'skip', readonly string[]> = {
  pause: ['pause', 'pause music', 'pause playback'],
  resume: ['resume', 'resume music', 'resume playback'],
  skip: ['skip', 'skip song', 'skip track', 'next song', 'next track'],
}

export function isDirectCommand(text: string, action: 'pause' | 'resume' | 'skip'): boolean {
  const said = text
    .toLowerCase()
    .replace(/[.!?]+$/, '')
    .trim()
  return DIRECT[action].includes(said)
}

export const COMMAND_HELP =
  'I only take plain player commands, so nothing’s accidental. Say pause, resume or skip.'

export type BotFailure = {
  /** The pet's own short line, said before the explanation. */
  aside: string
  text: string
  tone: 'danger' | 'warn'
  /** What the one button under the explanation does. */
  next: 'retry' | 'send-again' | 'replace' | null
}

/**
 * Puts a failure in the pet's voice. The explanation is the player's or the server's own message
 * wherever one exists, so the 500-song limit reads the same here as in the player.
 */
export function explainFailure(message: string, during: 'request' | 'apply'): BotFailure {
  if (/queue (changed|moved)|player changed/i.test(message))
    return {
      aside: 'Hold on, things moved while I was checking.',
      text: 'The queue changed while I was working, so I didn’t change anything. Send the request again to use the current queue.',
      tone: 'warn',
      next: 'send-again',
    }
  if (/queue is full/i.test(message))
    return { aside: 'No room on the shelf!', text: message, tone: 'danger', next: 'replace' }
  if (/invalid plan|incomplete plan|invalid JSON|too much data/i.test(message))
    return {
      aside: 'My brain scrambled that one.',
      text: 'The model’s answer didn’t make sense, so nothing changed. Try again, or say it a different way.',
      tone: 'danger',
      next: 'retry',
    }
  if (/selection changed|file is unavailable/i.test(message))
    return {
      aside: 'Something in that list moved.',
      text: message,
      tone: 'warn',
      next: 'send-again',
    }
  return {
    aside: during === 'apply' ? 'That didn’t go through.' : 'Sorry, that didn’t work.',
    text: message,
    tone: 'danger',
    next: during === 'apply' ? null : 'retry',
  }
}

/**
 * What the card says once an action has gone through. "Playing now" only when the player says it
 * is: a browser that blocks autoplay loads the songs without starting them, and says so.
 */
export function appliedText(action: BotQueueAction, count: number, playing: boolean): string {
  const songs = `${count} ${count === 1 ? 'song' : 'songs'}`
  return {
    play: `${playing ? 'Playing now.' : 'Loaded, not playing yet.'} These ${songs} replaced your queue.`,
    next: `Queued next: ${songs}, after the song that is playing.`,
    append: `Added ${songs} to the end of your queue.`,
    replace: `Up next is now these ${songs}. The current song keeps playing.`,
  }[action]
}

export const ACTION_LABELS: Record<BotQueueAction, string> = {
  play: 'Play',
  next: 'Play next',
  append: 'Add to queue',
  replace: 'Replace upcoming',
}

/** How many recent answers' songs the chat remembers, and the most it sends. */
export const SHOWN_GENERATIONS = 3
export const SHOWN_LIMIT = 500

/**
 * The songs of the last few library answers, newest first. Asking again sends them so the server
 * prefers others; it never excludes them and nothing is stored beyond this tab. A refinement only
 * narrows songs already shown, and a question shows none, so neither counts.
 */
export function rememberShown(generations: string[][], reply: BotReply): string[][] {
  if (reply.plan.action !== 'search' || reply.plan.scope !== 'library' || !reply.tracks.length)
    return generations
  return [reply.tracks.map((track) => track.id), ...generations].slice(0, SHOWN_GENERATIONS)
}

/** The remembered songs as one list, newest first, each once, at most SHOWN_LIMIT. */
export function shownIds(generations: string[][]): string[] {
  return [...new Set(generations.flat())].slice(0, SHOWN_LIMIT)
}
