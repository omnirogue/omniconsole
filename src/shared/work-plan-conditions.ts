import type { SessionChain } from './session-chain-types'
import type { WorkPlan } from './work-plan-types'
import { workPlanOutcomeOf } from './work-plan-types'
import type { WorkPlanRuntimeStep } from './work-plan-runtime-adapter'
import type { SessionOutcomeCondition, SessionOutcomeDefinition } from './session-outcome-types'

export function workPlanDoneWhenConditions(
  plan: WorkPlan,
  steps: WorkPlanRuntimeStep[],
  outcomeId: string
): SessionOutcomeCondition[] {
  return workPlanOutcomeOf(plan).doneWhen.map((entry) => {
    const base = { id: entry.id, label: entry.text }
    if (entry.evidence === 'file') {
      return {
        ...base,
        kind: 'file',
        target: entry.path!,
        ...(workPlanOutcomeOf(plan).outputKind === 'plan'
          ? { fileVersions: [{ path: entry.path!, schema: 'work-plan-v1' as const }] }
          : {})
      }
    }
    if (entry.evidence === 'human') {
      return { ...base, kind: 'review', target: outcomeId }
    }
    if (entry.evidence === 'command') {
      return {
        ...base,
        kind: 'command',
        target: entry.command!.program,
        verification: entry.command
      }
    }
    const verify = steps.findLast(
      (step) =>
        step.presetId === 'verify' &&
        step.verdict?.kind === 'verify' &&
        step.verdict.consumed === 'gate' &&
        step.verdict.over.includes(entry.id)
    )
    if (!verify) {
      throw new Error(
        `Done When "${entry.text}" needs a Verify worker whose verdict.over includes ${entry.id}.`
      )
    }
    return { ...base, kind: 'report', target: verify.id }
  })
}

/**
 * Everything the lowered definition must prove, and how it finishes.
 *
 * The Done When entries are the Outcome's own criteria. A finish that hands the work to
 * PEOPLE adds obligations that are not criteria the plan invented — a delivery receipt, and
 * one reply per named reviewer (`next-outcome-definition-compile.ts`) — so they are kept
 * beside them rather than replaced, and the definition finishes as the handoff it is.
 */
export function workPlanDefinitionContract(
  plan: WorkPlan,
  steps: WorkPlanRuntimeStep[],
  definition: SessionOutcomeDefinition,
  existing?: SessionChain
): { conditions: SessionOutcomeCondition[]; finish: SessionOutcomeDefinition['finish'] } {
  const finishConditions = plan.nodes.some(
    (node) => node.kind === 'finish' && node.finishWith?.people.length
  )
    ? definition.conditions.filter(
        (condition) => condition.kind === 'handoff' || Boolean(condition.recipientId)
      )
    : []
  const doneWhen = workPlanDoneWhenConditions(plan, steps, definition.id).map((condition) => {
    const prior = existing?.outcomeSet?.outcomes[0]?.conditions.find((c) => c.id === condition.id)
    // A new strategy proves the same criterion; changing its target would invalidate v1 receipts.
    return prior?.kind === 'report' &&
      condition.kind === 'report' &&
      steps.some(
        (step) =>
          step.id === prior.target &&
          step.presetId === 'verify' &&
          step.verdict?.kind === 'verify' &&
          step.verdict.consumed === 'gate'
      )
      ? { ...condition, target: prior.target }
      : condition
  })
  return {
    conditions: [...doneWhen, ...finishConditions],
    // Routing never adds success criteria; the chain end carries the hand-back choice.
    finish: finishConditions.length
      ? 'human-handoff'
      : doneWhen.some((condition) => condition.kind === 'review')
        ? 'my-review'
        : 'complete'
  }
}
