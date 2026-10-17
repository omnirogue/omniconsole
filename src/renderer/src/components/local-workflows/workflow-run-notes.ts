/** Each note once, in first-seen order, with how often it repeated (a cap hit every round). */
export function countWorkflowNotes(entries: readonly string[]): [entry: string, count: number][] {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    counts.set(entry, (counts.get(entry) ?? 0) + 1)
  }
  return [...counts]
}

/**
 * One list of the program's notes: its live log, plus the work a Discover cap dropped. The
 * program also logs each dropped line, so a line in both counts as often as the more complete
 * source says, never twice; the dropped list survives a restart, the live log does not.
 */
export function workflowRunNoteEntries(
  log: readonly string[] = [],
  dropped: readonly string[] = []
): string[] {
  const logged = new Map(countWorkflowNotes(log))
  const seen = new Map<string, number>()
  const extra: string[] = []
  for (const entry of dropped) {
    const count = (seen.get(entry) ?? 0) + 1
    seen.set(entry, count)
    if (count > (logged.get(entry) ?? 0)) {
      extra.push(entry)
    }
  }
  return [...log, ...extra]
}
