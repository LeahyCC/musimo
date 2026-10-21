import type { AnalysisSong, AnalysisStatus } from '../../api'

/* Wording and arithmetic for the Song analysis page. No domain rules live here: the server
   decides what is sure, which songs are in each group and how long a run should take. */

export type Device = 'cpu' | 'gpu'

/** The one command that starts the worker, from the folder holding compose.yaml. */
export function startCommand(device: Device): string {
  return device === 'gpu'
    ? 'docker compose --profile analysis-gpu up -d audio-worker-gpu'
    : 'docker compose --profile analysis up -d audio-worker'
}

/** A length of time the way a person says it: "under a minute", "12 min", "about 8 h". */
export function spoken(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds < 60) return 'under a minute'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = seconds / 3600
  if (hours < 10) {
    const whole = Math.floor(hours)
    const rest = Math.round((hours - whole) * 60)
    if (rest === 60) return `about ${whole + 1} h`
    return rest ? `about ${whole} h ${rest} min` : `about ${whole} h`
  }
  return `about ${Math.round(hours)} h`
}

/** The start of a sentence: "About 8 h", "About 12 min", "Under a minute". */
export function roughly(seconds: number): string {
  const said = spoken(seconds)
  if (!said) return ''
  if (said.startsWith('about ') || said === 'under a minute')
    return said.charAt(0).toUpperCase() + said.slice(1)
  return `About ${said}`
}

/** Bytes as GB, one decimal: 2147483648 is "2 GB", 4.3e9 is "4 GB". */
export function gigabytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return ''
  const value = bytes / 1024 ** 3
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} GB`
}

export function deviceName(device: string): string {
  return device === 'cuda' ? 'graphics card' : 'CPU'
}

/** "graphics card (NVIDIA GeForce RTX 5080), 4 decoders, 4 GB" for the status strip. */
export function workerLine(worker: NonNullable<AnalysisStatus['worker']>): string {
  const parts = [
    worker.gpu ? `${deviceName(worker.device)} (${worker.gpu})` : deviceName(worker.device),
    `${worker.decoders} decoder${worker.decoders === 1 ? '' : 's'}`,
  ]
  const memory = gigabytes(worker.memory_limit)
  if (memory) parts.push(memory)
  return parts.join(', ')
}

/** How long ago the worker last asked for work. */
export function seenAgo(seconds: number): string {
  if (seconds < 2) return 'just now'
  if (seconds < 90) return `${Math.round(seconds)} s ago`
  return `${spoken(seconds)} ago`
}

/** Progress as a whole percentage, never above 100 and 0 for an empty run. */
export function percent(done: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((done / total) * 100)))
}

/** The BPM a row shows: the sure tempo, or what was read for an unsure song. */
export function tempoText(song: AnalysisSong): string {
  if (song.bpm !== null) return `${Math.round(song.bpm)} BPM`
  if (song.reading !== null) return `read ${Math.round(song.reading)}, unsure`
  return 'no tempo'
}

/** "0:12" for a section start. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

export const GROUPS = [
  { id: 'fastest', label: 'Fastest' },
  { id: 'slowest', label: 'Slowest' },
  { id: 'loudest', label: 'Loudest' },
  { id: 'quietest', label: 'Quietest' },
  { id: 'ambiguous', label: 'Check these' },
] as const

export type GroupId = (typeof GROUPS)[number]['id']
