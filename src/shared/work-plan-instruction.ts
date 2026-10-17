import {
  SESSION_ACTION_OUTCOME_INSTRUCTIONS,
  SESSION_ACTION_PRESET_INSTRUCTIONS
} from './session-action-presets'
import {
  WORK_PLAN_ROLE_PRESET,
  workPlanOutcomeOf,
  type WorkPlan,
  type WorkPlanNode,
  type WorkPlanOutcome
} from './work-plan-types'

/**
 * What a node actually runs with. A transform is only meaningful against the outcome, so the
 * role's default is the outcome-relative one whenever the plan says when it is done; the plain
 * default stays for a plan that has only a title.
 */
export function workPlanDoneWhenText(outcome: WorkPlanOutcome): string {
  const stated = outcome.doneWhen.map((entry) => entry.text.trim()).filter(Boolean)
  return stated.length > 0 ? stated.join('; ') : outcome.title.trim()
}

export function renderWorkPlanInstruction(template: string, outcome: WorkPlanOutcome): string {
  return template
    .replaceAll('{{outcome.title}}', outcome.title.trim())
    .replaceAll('{{doneWhen}}', workPlanDoneWhenText(outcome))
}

export function workPlanNodeInstruction(plan: WorkPlan, node: WorkPlanNode): string {
  if (node.kind === 'finish') {
    return ''
  }
  const typed = node.instruction?.trim()
  if (typed) {
    return renderWorkPlanInstruction(typed, workPlanOutcomeOf(plan))
  }
  const presetId = node.kind === 'review' ? 'review' : WORK_PLAN_ROLE_PRESET[node.role]
  if (!presetId) {
    return ''
  }
  const relative =
    workPlanOutcomeOf(plan).doneWhen.length > 0
      ? SESSION_ACTION_OUTCOME_INSTRUCTIONS[presetId]
      : undefined
  const fallback: string | undefined = relative ?? SESSION_ACTION_PRESET_INSTRUCTIONS[presetId]
  return fallback ? renderWorkPlanInstruction(fallback, workPlanOutcomeOf(plan)) : ''
}
