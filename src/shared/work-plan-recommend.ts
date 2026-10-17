import { workPlanNodeInstruction, workPlanDoneWhenText } from './work-plan-instruction'
import type { WorkPlanOutcome, WorkPlanRole } from './work-plan-types'

export type WorkPlanRecommendation = {
  id:
    | WorkPlanRole
    | 'define-done-when'
    | 'give-to'
    | 'done'
    | 'change-strategy'
    | 'retry-seat'
    | 'ask-me'
  label: string
  instruction: string
  outcomeRevision: number
  planVersion: number
}
export type WorkPlanRecommendationState = {
  outcomeRevision: number
  unsatisfiedDoneWhen: string[]
  lastStage: {
    role: WorkPlanRole
    outputContract: string
    candidateCount: number
    verdict?: { status: string; blockingFindings?: readonly string[] }
    settled: 'completed' | 'blocked' | 'failed' | 'superseded'
    blockedReason?: string
  }
  planVersion: number
  attemptStates: readonly (string | { state: string })[]
}

export function recommendNextTransforms(
  state: WorkPlanRecommendationState,
  outcome: WorkPlanOutcome
): WorkPlanRecommendation[] {
  const result: WorkPlanRecommendation[] = []
  const add = (id: WorkPlanRecommendation['id'], label: string, instruction?: string): void => {
    result.push({
      id,
      label,
      instruction:
        instruction ??
        `Outcome: ${outcome.title}\n${workPlanNodeInstruction(
          { outcome, nodes: [] },
          {
            kind: 'worker',
            id: 'next',
            role: id as WorkPlanRole,
            instruction: '',
            actor: { agent: 'claude' }
          }
        )}`,
      outcomeRevision: state.outcomeRevision,
      planVersion: id === 'change-strategy' ? state.planVersion + 1 : state.planVersion
    })
  }
  if (!outcome.doneWhen.length) {
    add('define-done-when', 'Define Done When', `Define testable evidence for ${outcome.title}.`)
  }
  const last = state.lastStage
  const attempts = state.attemptStates.map((a) => (typeof a === 'string' ? a : a.state))
  const active = attempts.some((a) => ['launching', 'running', 'unverifiable'].includes(a))
  const blocked =
    ['blocked', 'failed', 'superseded'].includes(last.settled) ||
    (last.verdict?.status === 'fail' && !attempts.includes('retryable'))
  if (blocked) {
    if (!active) {
      add(
        'change-strategy',
        '⟲ Change strategy',
        `Propose v${state.planVersion + 1} for ${outcome.title}. Blocked: ${last.blockedReason ?? last.verdict?.blockingFindings?.join('; ') ?? last.settled}. Unsatisfied Done When: ${outcome.doneWhen
          .filter((d) => state.unsatisfiedDoneWhen.includes(d.id))
          .map((d) => d.text)
          .join('; ')}.`
      )
    }
    if (!active) {
      add(
        'retry-seat',
        'Retry seat',
        `Retry the failed seat toward ${outcome.title}: ${workPlanDoneWhenText(outcome)}.`
      )
    }
    add('ask-me', 'Ask me', `Ask me how to unblock ${outcome.title}.`)
    return result
  }
  if (
    state.outcomeRevision === (outcome.revision ?? state.outcomeRevision) &&
    outcome.doneWhen.length &&
    !state.unsatisfiedDoneWhen.length &&
    last.verdict?.status === 'pass'
  ) {
    add('done', 'Done (👤 Me)', `Return the evidence for ${outcome.title} to me.`)
  } else if (['findings', 'fail'].includes(last.verdict?.status ?? '')) {
    add('improve', '✨ Improve (repair)')
    add('verify', '✓ Verify')
  } else if (
    last.candidateCount >= 2 &&
    !(
      ['research', 'analyze', 'summarize'].includes(last.role) &&
      last.outputContract !== 'candidates'
    )
  ) {
    add('judge', '⚖ Judge')
    add('synthesize', '◇ Synthesize')
    add('review', '👀 Review')
  } else if (['implement', 'improve', 'repair'].includes(last.role)) {
    add('verify', '✓ Verify against Outcome')
    add('review', '👀 Review')
    add('test', '🧪 Test')
    add('analyze', '🔬 Analyze gaps')
    add('improve', '✨ Improve')
    add('plan', '📝 Plan remaining work')
  } else if (['research', 'analyze', 'summarize'].includes(last.role)) {
    if (last.candidateCount >= 2) {
      add('synthesize', '◇ Synthesize')
    }
    add('plan', '📝 Plan')
    add('give-to', '→ Give to…', `Give the findings to the next actor pursuing ${outcome.title}.`)
  } else if (last.role === 'plan') {
    add('review', '👀 Review plan')
    if (outcome.outputKind === 'work') {
      add('implement', '🛠 Implement')
    }
    add('give-to', '→ Give to…', `Give the plan for ${outcome.title} to the next actor.`)
  }
  return result
}
