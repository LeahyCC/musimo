import { siteLabel } from './download-target'

export type SourceHealth = {
  source: string
  status: string
  detail: string
}

export type ListedSource = {
  id: string
  label: string
  /** `catalog` is the Deezer search connection. `account` is the Deezer account. */
  kind?: string
}

export type SourceProblem = {
  id: string
  label: string
  /** The readiness row title. The catalog and the account use their own names. */
  title: string
  /** Short word for a settings row: Paused, Blocked or Error. */
  mark: 'Paused' | 'Blocked' | 'Error'
  detail: string
  paused: boolean
}

const PAUSED_LINE = 'Paused after repeated blocking errors.'

/** Account downloads are stored apart from the catalog probe, which keeps the name deezer. */
const ACCOUNT_HEALTH = 'deezer_audio'
const ACCOUNT_PAUSE = 'deezer'

/**
 * One problem per source that is paused or last failed. A healthy source is left out.
 * YouTube is included when it has a problem. The readiness list draws that one on its own row.
 * A pause of the Deezer account belongs on the account row once that row is listed. The catalog
 * row stays the probe.
 */
export function sourceProblems(
  health: readonly SourceHealth[],
  paused: readonly { source: string; label: string }[],
  listed: readonly ListedSource[] = [],
): SourceProblem[] {
  const byHealth = new Map(health.map((row) => [row.source, row]))
  const byPaused = new Map(paused.map((row) => [row.source, row.label]))
  const byListed = new Map(listed.map((row) => [row.id, row]))
  const accountListed = byListed.has(ACCOUNT_HEALTH)
  const extras = [
    ...new Set([...health.map((row) => row.source), ...paused.map((row) => row.source)]),
  ].filter((id) => !byListed.has(id))
  const problems: SourceProblem[] = []
  for (const id of [...byListed.keys(), ...extras]) {
    const row = byHealth.get(id)
    const isPaused =
      id === ACCOUNT_PAUSE && accountListed
        ? false
        : byPaused.has(id) || (id === ACCOUNT_HEALTH && byPaused.has(ACCOUNT_PAUSE))
    const unhealthy = row !== undefined && row.status !== 'healthy'
    if (!isPaused && !unhealthy) continue
    const listedRow = byListed.get(id)
    const pauseLabel = id === ACCOUNT_HEALTH ? byPaused.get(ACCOUNT_PAUSE) : undefined
    const label = listedRow?.label || byPaused.get(id) || pauseLabel || siteLabel(id)
    const detail = isPaused
      ? unhealthy && row?.detail
        ? `${PAUSED_LINE} ${row.detail}`
        : PAUSED_LINE
      : row?.detail || 'This source had a problem.'
    const ownName = listedRow?.kind === 'catalog' || listedRow?.kind === 'account'
    problems.push({
      id,
      label,
      title: ownName ? label : `${label} downloads`,
      mark: isPaused ? 'Paused' : row?.status === 'blocked' ? 'Blocked' : 'Error',
      detail,
      paused: isPaused,
    })
  }
  return problems
}

/** Marks for the catalog order list. That list calls the Deezer account deezer. */
export function orderTrouble(problems: readonly SourceProblem[]): Record<string, string> {
  const marks: Record<string, string> = {}
  for (const problem of problems) {
    if (problem.mark === 'Paused') continue
    if (problem.id === ACCOUNT_HEALTH) marks[ACCOUNT_PAUSE] = problem.mark
    else if (problem.id !== ACCOUNT_PAUSE) marks[problem.id] = problem.mark
  }
  return marks
}
