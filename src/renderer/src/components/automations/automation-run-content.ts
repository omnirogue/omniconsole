import type { AutomationRun } from '../../../../shared/automations-types'
import {
  readAutomationRunMessage,
  type AutomationRunMessage
} from '../../../../shared/automation-run-message'

export function getAutomationRunContent(run: AutomationRun): string {
  const savedOutput = run.outputSnapshot?.content.trim()
  if (savedOutput) {
    return run.outputSnapshot?.content ?? savedOutput
  }
  if (run.precheckResult) {
    const output = [run.precheckResult.stderr.trim(), run.precheckResult.stdout.trim()]
      .filter(Boolean)
      .join('\n\n')
    if (output) {
      return output
    }
  }
  return run.error ?? run.usage?.unavailableMessage ?? 'No output content available.'
}

/** Whether this run answered an APPLY click; such runs never carry recommendations of their own. */
export function isAutomationApplyRun(
  run: Pick<AutomationRun, 'title' | 'promptOverride'>
): boolean {
  return run.title.includes('· apply ') || (run.promptOverride ?? '').startsWith('APPLY:')
}

/** The run's output as the UI may show it: chrome stripped, block separated, trimmed. */
export function getAutomationRunMessage(run: AutomationRun): AutomationRunMessage {
  const message = readAutomationRunMessage(getAutomationRunContent(run))
  // Why: an apply run echoes the chosen actions back in its prompt and report; those are
  // receipts, not new recommendations.
  return isAutomationApplyRun(run) && message.recommendations !== 'none'
    ? { ...message, actions: [], recommendations: 'none' }
    : message
}
