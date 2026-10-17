import { inspectProcessSignal } from './daemon-process-inspection'
import type { ProcessSignalEvidence } from './daemon-incarnation-evidence-types'

export type PtyProcessGoneProbeDeps = {
  platform?: NodeJS.Platform
  signalProcess?: (pid: number) => ProcessSignalEvidence
}

/**
 * True only when the OS positively reports that no process owns `pid` (ESRCH from
 * `kill(pid, 0)`). Every other answer — EPERM, an unusable pid, an unexpected errno,
 * Windows — means "cannot tell" and returns false: collapsing doubt into death would
 * drop a live terminal (see AGENTS.md, "Never collapse can't tell into dead").
 *
 * Why win32 is skipped: ConPTY roots are owned through job objects and Windows reuses
 * pids eagerly, so a bare pid probe there is not the proof this relies on.
 */
export function isPtyProcessGone(
  pid: number | null | undefined,
  deps: PtyProcessGoneProbeDeps = {}
): boolean {
  if ((deps.platform ?? process.platform) === 'win32') {
    return false
  }
  // Why the guard: kill(0|-n, 0) addresses process groups, never one PTY root.
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    return false
  }
  return (deps.signalProcess ?? inspectProcessSignal)(pid) === 'missing'
}
