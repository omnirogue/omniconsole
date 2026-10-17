// When the last restore sweep started an agent: a background-lane start that resumes a provider
// session or an interrupted restore (nobody asked for it on screen). Background work that can
// wait, such as session summaries, holds off for a while after one so it never piles onto a
// sweep that is already loading the Mac.

let lastRestoreSweepStartAt: number | null = null

export function noteRestoreSweepAgentStart(now = Date.now()): void {
  lastRestoreSweepStartAt = now
}

export function lastRestoreSweepAgentStartAt(): number | null {
  return lastRestoreSweepStartAt
}

export function _resetRestoreSweepActivityForTests(): void {
  lastRestoreSweepStartAt = null
}
