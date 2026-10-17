import type { Store } from '../persistence'
import type { Automation, AutomationPrecheckResult } from '../../shared/automations-types'
import { runAutomationPrecheck } from './precheck-runner'
import { unavailableAutomationPrecheckResult } from './unavailable-precheck-result'
import type { AutomationRunTargetResult } from './run-target-resolution'

/** Prechecks gate scheduled runs only; a manual run is the person asking for it now. */
export async function runScheduledAutomationPrecheck(
  store: Store,
  automationId: string,
  runId: string,
  resolveTarget: (automation: Automation) => AutomationRunTargetResult
): Promise<AutomationPrecheckResult | null> {
  const automation = store.listAutomations().find((entry) => entry.id === automationId)
  if (!automation) {
    throw new Error('Automation not found.')
  }
  const run = store.listAutomationRuns(automationId).find((entry) => entry.id === runId)
  if (!run) {
    throw new Error('Automation run not found.')
  }
  if (run.trigger !== 'scheduled' || !automation.precheck) {
    return null
  }
  const target = resolveTarget(automation)
  if (!target.ok) {
    return unavailableAutomationPrecheckResult(automation.precheck, target.error)
  }
  return await runAutomationPrecheck({
    precheck: automation.precheck,
    target:
      automation.executionTargetType === 'ssh'
        ? { type: 'ssh', cwd: target.cwd, connectionId: automation.executionTargetId }
        : { type: 'local', cwd: target.cwd }
  })
}
