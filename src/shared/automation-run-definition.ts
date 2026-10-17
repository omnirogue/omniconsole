import type { Automation, AutomationRun } from './automations-types'
import {
  automationDefinitionContext,
  DEFAULT_AUTOMATION_NOTIFY,
  type AutomationDefinitionContext
} from './automation-definition-context'

export type AutomationRunDefinitionSnapshot = AutomationDefinitionContext &
  Partial<Pick<Automation, 'executionTargetType' | 'executionTargetId' | 'schedulerOwner'>>

export function captureAutomationRunDefinition(
  automation: Automation
): AutomationRunDefinitionSnapshot {
  return structuredClone({
    ...automationDefinitionContext(automation),
    delivery: automation.delivery ?? [{ kind: 'chat' }],
    notify: automation.notify ?? DEFAULT_AUTOMATION_NOTIFY,
    outputFormat: automation.outputFormat ?? 'markdown',
    executionTargetType: automation.executionTargetType,
    executionTargetId: automation.executionTargetId,
    schedulerOwner: automation.schedulerOwner
  })
}

/** Even an empty snapshot owns its defaults; later edits cannot add recipients to a past run. */
export function automationRunDefinition(automation: Automation, run: AutomationRun): Automation {
  const definition = run.definitionSnapshot ?? automation
  return {
    ...automation,
    ...definition,
    delivery: definition.delivery,
    notify: definition.notify,
    outputFormat: definition.outputFormat
  }
}
