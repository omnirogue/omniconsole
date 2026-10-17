import type { SessionChain, SessionChainStepRole } from './session-chain-types'
import type { SessionOutcome } from './session-outcome-types'
import { reconcileSessionOutcomeSet } from './session-outcome-state'
import { workPlanReportDoneWhen, workPlanReportStages } from './work-plan-report-topology'

export type TaskOutcomeRow = {
  chainId: string
  outcomeId: string
  owner: string
  title: string
  satisfied: number
  total: number
  lastStageGlyph: string
  status: SessionOutcome['status']
}

const ROLE_GLYPHS: Record<SessionChainStepRole, string> = {
  producer: '◇',
  worker: '◇',
  reviewer: '✓',
  repair: '✨'
}

export function taskOutcomeRows(chains: readonly SessionChain[], taskId: string): TaskOutcomeRow[] {
  return chains.flatMap((chain) => {
    if (!chain.outcomeSet) {
      return []
    }
    const set = reconcileSessionOutcomeSet(chain.outcomeSet)
    return set.outcomes
      .filter((outcome) => outcome.taskRef?.taskId === taskId || set.continuation.taskId === taskId)
      .map((outcome) => {
        const steps = chain.steps.filter(
          (step) =>
            (outcome.stepIds ?? []).includes(step.id) &&
            (step.kind === 'handoff' ? (chain.planVersion ?? 1) : (step.planVersion ?? 1)) ===
              (chain.planVersion ?? 1)
        )
        const last = steps.at(-1)
        const glyph =
          last?.kind === 'handoff' ? '👤' : last?.role ? ROLE_GLYPHS[last.role] : undefined
        const conditions = workPlanReportDoneWhen(outcome)
        return {
          chainId: chain.id,
          outcomeId: outcome.id,
          owner: JSON.stringify(chain.placement ?? chain.hostId ?? 'local'),
          title: outcome.title,
          satisfied: conditions.filter((condition) => condition.satisfied).length,
          total: conditions.length,
          lastStageGlyph:
            glyph ?? workPlanReportStages({ ...chain, steps }, { now: 0 }).at(-1)?.glyph ?? '',
          status: outcome.status
        }
      })
  })
}

export function taskOutcomeCounts(
  chains: readonly SessionChain[],
  taskId: string
): { satisfied: number; total: number } {
  const rows = taskOutcomeRows(chains, taskId)
  return { satisfied: rows.filter((row) => row.status === 'satisfied').length, total: rows.length }
}
