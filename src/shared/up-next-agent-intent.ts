/**
 * Review vs handoff: the two intents an agent stage in Up next can carry.
 *
 * A REVIEW stage examines the current work without becoming the next builder: it hands on
 * findings, a pass/fail verdict or a winner, never a new result. A HANDOFF stage gives the work
 * to an agent that performs the next stage and hands on a result. Both are the same one worker
 * primitive on the same engine — a stage still carries its individual template (`review`,
 * `verify`, `improve`, …) — and the intent is derived from that template, so a saved stage, a
 * committed step and a draft always agree on it and no stored workflow needs migrating.
 */

import type { UpNextAgentOutput, UpNextAgentTemplate } from './up-next-types'

export type UpNextAgentIntent = 'review' | 'handoff'

/** What + Agent Review offers: inspect and report, change nothing. */
export const UP_NEXT_REVIEW_TEMPLATES = [
  'review',
  'critique',
  'verify'
] as const satisfies readonly UpNextAgentTemplate[]

/** What + Agent Handoff offers: the next agent takes the work and acts on it. */
export const UP_NEXT_HANDOFF_TEMPLATES = [
  'implement',
  'improve',
  'research',
  'plan',
  'custom'
] as const satisfies readonly UpNextAgentTemplate[]

const FINDINGS: readonly UpNextAgentTemplate[] = ['review', 'critique', 'analyze', 'compare']

/** What a stage hands on: a result, findings, a pass/fail verdict, or a winner. */
export function upNextStageOutput(template: UpNextAgentTemplate): UpNextAgentOutput {
  if (template === 'verify' || template === 'test') {
    return 'verdict'
  }
  if (template === 'judge') {
    return 'winner'
  }
  return FINDINGS.includes(template) ? 'findings' : 'result'
}

/**
 * A stage that hands on anything but a result is a review: it inspected the work. Templates the
 * menus no longer offer (judge, compare, test, …) still classify, so a saved workflow that uses
 * one keeps its meaning.
 */
export function upNextAgentIntent(template: UpNextAgentTemplate): UpNextAgentIntent {
  return upNextStageOutput(template) === 'result' ? 'handoff' : 'review'
}

export function upNextIntentTemplates(intent: UpNextAgentIntent): readonly UpNextAgentTemplate[] {
  return intent === 'review' ? UP_NEXT_REVIEW_TEMPLATES : UP_NEXT_HANDOFF_TEMPLATES
}

/**
 * The templates a stage card may switch between: its own intent's family, plus the stage's
 * current template when it is one the menus no longer offer — an older saved stage keeps
 * reading as what it is instead of silently becoming something else.
 */
export function upNextTemplateChoices(template: UpNextAgentTemplate): UpNextAgentTemplate[] {
  const family = [...upNextIntentTemplates(upNextAgentIntent(template))]
  return family.includes(template) ? family : [...family, template]
}
