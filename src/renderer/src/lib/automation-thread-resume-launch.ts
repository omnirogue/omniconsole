import { listAutomationRunsForTarget } from '@/components/automations/automation-host-client'
import type {
  LaunchAgentBackgroundSessionArgs,
  LaunchAgentBackgroundSessionResult
} from '@/lib/agent-background-session-contract'
import {
  collectOpenProviderThreadIds,
  decideAutomationThreadResume
} from '@/lib/automation-thread-resume'
import { launchAgentBackgroundSession } from '@/lib/launch-agent-background-session'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import type { Automation, AutomationRun } from '../../../shared/automations-types'
import type { AutomationRunResume } from '../../../shared/automation-run-resume-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'

export type AutomationAgentSessionLaunch = {
  result: LaunchAgentBackgroundSessionResult | null
  /** Recorded on the run when a thread resume was requested, whatever came of it. */
  resume: AutomationRunResume | null
}

/**
 * The fresh-launch half of a routine dispatch: when the routine reuses sessions and
 * its pane is gone, resume the routine's own recorded thread; otherwise start fresh.
 *
 * Why the account home is left to main: the renderer cannot see which home the launch
 * will run under, and main's Codex resume preparation already verifies the rollout's
 * provenance and pins that home — or drops the resume argv, in which case the hook
 * reports a different thread id and the run's resume outcome becomes 'fresh'.
 */
export async function launchAutomationAgentSession(args: {
  automation: Automation
  run: AutomationRun
  worktreeId: string
  launch: Omit<LaunchAgentBackgroundSessionArgs, 'resume'>
}): Promise<AutomationAgentSessionLaunch> {
  const fresh = (): Promise<LaunchAgentBackgroundSessionResult | null> =>
    launchAgentBackgroundSession(args.launch)
  if (!args.automation.reuseSession) {
    return { result: await fresh(), resume: null }
  }
  const decision = decideAutomationThreadResume({
    automationId: args.automation.id,
    agentId: args.automation.agentId,
    worktreeId: args.worktreeId,
    currentRunId: args.run.id,
    // Why: the dispatch loop only ever executes for the desktop authority, so its
    // history read addresses the local runtime explicitly (same as pane reuse).
    runs: await listAutomationRunsForTarget({ kind: 'local' }, args.automation.id),
    localWorkspace:
      getExecutionHostIdForWorktree(useAppStore.getState(), args.worktreeId) ===
      LOCAL_EXECUTION_HOST_ID,
    openThreadIds: collectOpenProviderThreadIds(useAppStore.getState())
  })
  if (!decision) {
    return { result: await fresh(), resume: null }
  }
  if (decision.kind === 'fresh') {
    return {
      result: await fresh(),
      resume: { requested: decision.requested, outcome: 'fresh', reason: decision.reason }
    }
  }
  const requested = decision.providerSession.id
  // A rejected launch can already have started a process; it cannot authorize another spawn.
  const result = await launchAgentBackgroundSession({
    ...args.launch,
    resume: { providerSession: decision.providerSession }
  })
  if (!result) {
    return { result: null, resume: { requested, outcome: 'failed', reason: 'no launch plan' } }
  }
  // Why 'resumed' now: the hook names the thread the pane actually opened; the
  // completion observer demotes this to 'fresh' if main dropped the resume argv.
  return { result, resume: { requested, outcome: 'resumed' } }
}
