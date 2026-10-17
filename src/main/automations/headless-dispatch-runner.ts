import type {
  Automation,
  AutomationDispatchResult,
  AutomationPrecheckResult,
  AutomationRun
} from '../../shared/automations-types'
import {
  didAutomationPrecheckPass,
  formatAutomationPrecheckFailure
} from '../../shared/automation-precheck'
import type { HeadlessAutomationDispatcher } from './headless-dispatch'
import type { AutomationRunTargetResult } from './run-target-resolution'
import type { AutomationRunWriter } from './automation-run-writer'
import {
  AutomationLaunchUnverifiableError,
  type AutomationLaunchTerminalBinding
} from '../../shared/automation-launch-outcome'

export type HeadlessAutomationDispatchContext = {
  automation: Automation
  run: AutomationRun
  target: Extract<AutomationRunTargetResult, { ok: true }>
  dispatcher: HeadlessAutomationDispatcher
  runs: AutomationRunWriter
  runPrecheck: () => Promise<AutomationPrecheckResult | null>
  markDispatchResult: (result: AutomationDispatchResult) => Promise<AutomationRun>
  watchRun: (run: AutomationRun) => void
  assertDispatchAllowed: () => void
}

function describeDispatchError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function runHeadlessAutomationDispatch(
  ctx: HeadlessAutomationDispatchContext
): Promise<AutomationRun> {
  const { automation, target, runs } = ctx
  // Why: `dispatching` before precheck and launch, so a crash in between is reconciled
  // at the next start instead of the still-due occurrence launching a second agent.
  const run = runs.updateRun({
    runId: ctx.run.id,
    status: 'dispatching',
    workspaceId: automation.workspaceId,
    error: null
  })
  const precheckResult =
    run.trigger === 'scheduled' && automation.precheck ? await ctx.runPrecheck() : null
  if (precheckResult && !didAutomationPrecheckPass(precheckResult)) {
    return runs.updateRun({
      runId: run.id,
      status: 'skipped_precheck',
      workspaceId: automation.workspaceId,
      precheckResult,
      error: formatAutomationPrecheckFailure(precheckResult)
    })
  }
  let launchRunTarget:
    | (AutomationLaunchTerminalBinding & Pick<AutomationDispatchResult, 'resume'>)
    | undefined
  try {
    ctx.assertDispatchAllowed()
    const launch = await ctx.dispatcher({ automation, run, target })
    launchRunTarget = {
      workspaceId: launch.workspaceId,
      workspaceDisplayName: launch.workspaceDisplayName ?? null,
      terminalSessionId: launch.terminalSessionId,
      terminalPaneKey: launch.terminalPaneKey ?? null,
      terminalPtyId: launch.terminalPtyId ?? null,
      ownsTerminal: launch.ownsTerminal === true,
      resume: launch.resume
    }
    const updated = runs.updateRun({
      runId: run.id,
      status: 'dispatched',
      ...launchRunTarget,
      error: null
    })
    if (!launch.completion) {
      // Why: a dispatcher that reports no completion promise would otherwise
      // leave the run at 'dispatched' for the process lifetime.
      ctx.watchRun(updated)
      return updated
    }
    void launch.completion
      .then((completion) =>
        ctx.markDispatchResult({
          runId: run.id,
          status: completion.status,
          ...launchRunTarget,
          precheckResult,
          outputSnapshot: completion.outputSnapshot ?? null,
          error: completion.error ?? null
        })
      )
      .catch(async (error) => {
        const held = await ctx.markDispatchResult({
          runId: run.id,
          status: 'dispatched',
          launchOutcome: 'unverifiable',
          ...launchRunTarget,
          error: describeDispatchError(error)
        })
        ctx.watchRun(held)
      })
      .catch((error) => {
        console.error('[automations] failed to persist held headless run:', error)
      })
    return updated
  } catch (error) {
    const knownTerminal =
      launchRunTarget ??
      (error instanceof AutomationLaunchUnverifiableError ? error.terminal : undefined)
    const unverifiable =
      knownTerminal !== undefined || error instanceof AutomationLaunchUnverifiableError
    const updated = runs.updateRun({
      runId: run.id,
      status: unverifiable ? (knownTerminal ? 'dispatched' : 'dispatching') : 'dispatch_failed',
      ...(unverifiable ? { launchOutcome: 'unverifiable' as const } : {}),
      workspaceId: automation.workspaceId,
      ...knownTerminal,
      error: describeDispatchError(error)
    })
    if (unverifiable && knownTerminal) {
      ctx.watchRun(updated)
    }
    return updated
  }
}
