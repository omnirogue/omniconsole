import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'

const manualSleepExitPtyIds = new Set<string>()

/** Marks a PTY whose exit is a person's "Put to sleep", so its visible pane does not wake at once. */
export function markManualSessionSleepExit(ptyId: string): void {
  manualSleepExitPtyIds.add(ptyId)
}

export function unmarkManualSessionSleepExit(ptyId: string): void {
  manualSleepExitPtyIds.delete(ptyId)
}

/** One-shot read by the pane's exit handler. */
export function consumeManualSessionSleepExit(ptyId: string): boolean {
  return manualSleepExitPtyIds.delete(ptyId)
}

/**
 * The record a person's per-session sleep leaves behind. Why `done`: that is the passive, in-place
 * wake class — opening the pane resumes it there, and worktree activation never relaunches it into
 * a new tab. Why tab-open-only: a phone opening the workspace must not respawn what was slept.
 */
export function toManualSessionSleepRecord(
  record: SleepingAgentSessionRecord
): SleepingAgentSessionRecord {
  const next: SleepingAgentSessionRecord = { ...record, state: 'done', restoreOnTabOpenOnly: true }
  // Why: a passive record carrying `interrupted` would read as an active interrupted turn.
  delete next.interrupted
  return next
}

/**
 * The record automatic hibernation leaves: the manual lazy shape (done, tab-open-only) re-keyed to
 * its own tab and marked to resume on that tab's first reveal. Opening the tab (or its row) resumes
 * it; a phone opening the workspace neither mounts its tab nor fires its mounted pane's armed wake
 * (wake-sleeping-agents-in-background.ts), and worktree activation never relaunches it.
 */
export function toAutomaticSleepRecord(
  record: SleepingAgentSessionRecord,
  tabId: string
): SleepingAgentSessionRecord {
  return { ...toManualSessionSleepRecord(record), tabId, resumeOnFirstReveal: true }
}
