/**
 * The renderer's attribution of one terminal pane's agent launch (latency telemetry,
 * PR 1.0). Main combines it with the auto-continue it armed and its request hints
 * (shared/launch-trigger.ts) and writes the result on `launch.process_spawn`.
 *
 * Telemetry only (load-bearing): nothing branches on the result; it describes a
 * launch that is already starting.
 *
 * Never 'restore-interrupted': the spawn's `interruptedRestore` flag rides on nearly every
 * cold-restore resume, and only main knows whether the pane was mid-turn and auto-continues.
 */
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { LaunchTrigger } from '../../../../shared/launch-trigger'

export type PaneLaunchFacts = {
  /** The spawn resumes a recorded agent session (it carries a launch config). */
  resumesAgentSession: boolean
  /** This pane is waking its own hibernated agent right now. */
  hibernationWakeInFlight: boolean
  /** The pane's sleeping record, when it has one (`origin` undefined = legacy sleep). */
  sleepingRecord: Pick<SleepingAgentSessionRecord, 'origin'> | null
  /** The spawn carries a startup command (an agent launch, not a bare shell). */
  hasStartupCommand: boolean
  /** On screen: the pane's isVisibleRef, the same live predicate pty-exit-hibernate.ts
   *  uses (not document visibility, which a minimized or occluded window turns hidden). */
  visible: boolean
  /** A person brought the pane's tab on screen (person-reveal-evidence.ts). Being the
   *  active tab is not enough: the tab on screen at startup is active too. */
  revealedByPerson: boolean
}

function isSleepRecord(record: PaneLaunchFacts['sleepingRecord']): boolean {
  // Why: quit/live records describe panes that were running when the app or daemon
  // went away; a worktree-sleep (or legacy, origin-less) record is a slept agent.
  return record !== null && (record.origin === 'worktree-sleep' || record.origin === undefined)
}

export function resolvePaneLaunchTrigger(facts: PaneLaunchFacts): LaunchTrigger {
  if (facts.hibernationWakeInFlight) {
    return 'hibernation-wake'
  }
  if (facts.resumesAgentSession) {
    if (isSleepRecord(facts.sleepingRecord)) {
      return 'hibernation-wake'
    }
    if (!facts.visible) {
      // Why hidden = background mount: hidden restored tabs wait for their first reveal
      // (#857), so a hidden pane only mounts when something background-mounts it.
      return 'background-mount'
    }
    // Why evidence, not the active flag: after a restart the startup tab cold-restores
    // visible and active with nobody touching the app; that is a restore, not a reveal.
    return facts.revealedByPerson ? 'person-reveal' : 'cold-restore-mount'
  }
  if (facts.hasStartupCommand) {
    return 'new'
  }
  return 'new'
}
