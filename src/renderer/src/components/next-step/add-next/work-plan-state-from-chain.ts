import type { SessionChain, SessionChainAgentStep } from '../../../../../shared/session-chain-types'
import { reconcileSessionOutcomeSet } from '../../../../../shared/session-outcome-state'
import { readSessionRun } from '../../../../../shared/session-run-lifecycle'
import { workPlanFromChain } from '../../../../../shared/work-plan-read'
import type { WorkPlanRecommendationState } from '../../../../../shared/work-plan-recommend'
import { workPlanParallelSeats, type WorkPlan } from '../../../../../shared/work-plan-types'
import { nextStepSubjectTitle, type NextStepSubject } from '../next-step-subject'

function currentAnchor(chain: SessionChain | null, plan: WorkPlan) {
  const steps =
    chain?.steps.filter(
      (step): step is SessionChainAgentStep =>
        step.kind !== 'handoff' && (step.planVersion ?? 1) === (chain?.planVersion ?? 1)
    ) ?? []
  const attempt = chain?.outcomeSet?.attempts.findLast(
    (entry) => (entry.planVersion ?? 1) === (chain.planVersion ?? 1)
  )
  const attempted = steps.find((step) => attempt?.actionId === `step_${step.id}`)
  const completed = steps.findLast((step) => chain?.outcomeSet?.completedSteps?.includes(step.id))
  const step = attempted ?? completed
  return (
    plan.nodes.find((node) => node.id === (step?.planNodeId ?? step?.id)) ??
    plan.nodes.findLast((node) => node.kind !== 'finish')
  )
}

export function anchorWorkPlan(
  chain: SessionChain | null,
  subject: NextStepSubject
): { plan: WorkPlan; anchorNodeId: string | null } {
  const plan: WorkPlan = chain?.outcomeSet
    ? workPlanFromChain(chain)
    : {
        outcome: { title: nextStepSubjectTitle(subject), doneWhen: [], outputKind: 'work' },
        nodes: []
      }
  return { plan, anchorNodeId: currentAnchor(chain, plan)?.id ?? null }
}

export function workPlanStateFromChain(
  chain: SessionChain,
  plan: WorkPlan,
  now = Date.now()
): WorkPlanRecommendationState {
  const outcome = chain.outcomeSet && reconcileSessionOutcomeSet(chain.outcomeSet).outcomes[0]
  const last = currentAnchor(chain, plan)
  const stepIds = new Set(
    chain.steps
      .filter(
        (step) =>
          step.kind !== 'handoff' &&
          (step.planVersion ?? 1) === (chain.planVersion ?? 1) &&
          (step.planNodeId ?? step.id) === last?.id
      )
      .map((step) => step.id)
  )
  const receipt = chain.verdicts?.findLast((entry) => stepIds.has(entry.stepId) && !entry.skipped)
  const verdict = receipt?.verdict as { status?: unknown; blockingFindings?: unknown } | undefined
  const attempts = chain.outcomeSet?.attempts ?? []
  const latest = attempts.findLast(
    (attempt) => (attempt.planVersion ?? 1) === (chain.planVersion ?? 1)
  )
  // The ONE policy says whether this plan is stuck. A recovering or waiting run is the host's to
  // continue, so it offers no "change strategy"; only an honest failure, or a request the owner
  // has not met, is a last stage that settled badly.
  const run = chain.outcomeSet
    ? readSessionRun(chain.outcomeSet, { now, planVersion: chain.planVersion ?? 1 })
    : null
  const stuck = run?.phase === 'failed' || run?.phase === 'needs-you'
  const blockedReason = stuck
    ? (run?.attention[0]?.ask ?? run?.failure?.reason ?? outcome?.blockedReason ?? latest?.error)
    : (chain.blocked?.reason ?? (chain.state === 'failed' ? chain.error : undefined))
  const role =
    last?.kind === 'worker' ? last.role : last?.kind === 'review' ? 'review' : 'implement'
  return {
    outcomeRevision: outcome?.revision ?? 1,
    planVersion: chain.planVersion ?? 1,
    unsatisfiedDoneWhen: plan.outcome.doneWhen
      .filter((condition) => !outcome?.evidence.some((entry) => entry.conditionId === condition.id))
      .map((condition) => condition.id),
    attemptStates: attempts,
    lastStage: {
      role,
      outputContract: ['research', 'analyze', 'summarize'].includes(role)
        ? 'reports'
        : 'candidates',
      candidateCount: last ? workPlanParallelSeats(plan, last) : 1,
      settled:
        run?.phase === 'needs-you' || chain.blocked
          ? 'blocked'
          : run?.phase === 'failed' || chain.state === 'failed'
            ? 'failed'
            : latest?.state === 'superseded'
              ? 'superseded'
              : 'completed',
      ...(blockedReason ? { blockedReason } : {}),
      ...(typeof verdict?.status === 'string'
        ? {
            verdict: {
              status: verdict.status,
              ...(Array.isArray(verdict.blockingFindings)
                ? {
                    blockingFindings: verdict.blockingFindings.filter(
                      (v): v is string => typeof v === 'string'
                    )
                  }
                : {})
            }
          }
        : {})
    }
  }
}
