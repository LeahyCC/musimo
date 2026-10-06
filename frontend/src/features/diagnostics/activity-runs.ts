/** A stretch of the feed made only of one kind of event. */
export type ActivityRun<T extends { kind: string }> = {
  kind: string
  /** In the order given, so the first is the newest when the feed is newest first. */
  events: T[]
}

/**
 * Folds neighbouring events of the same kind into one run, keeping the order. Two runs of one kind
 * with something else between them stay two runs, so the feed still reads as a timeline.
 */
export function groupRuns<T extends { kind: string }>(events: readonly T[]): ActivityRun<T>[] {
  const runs: ActivityRun<T>[] = []
  for (const event of events) {
    const last = runs[runs.length - 1]
    if (last?.kind === event.kind) last.events.push(event)
    else runs.push({ kind: event.kind, events: [event] })
  }
  return runs
}
