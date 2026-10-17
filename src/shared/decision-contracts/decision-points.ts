import { councilFinalCheckSteps } from '../workflow-council-final-check'
import type { WorkflowSpec } from '../workflow-graph'
import { findJudgeStep } from '../workflow-graph-find'
import {
  CURRENT_CONTRACTS,
  LIVE_FINDING_VERIFY,
  type ContractTable
} from './decision-contract-library'
import type { ContractRef, DecisionKind } from './decision-contract-types'

/** One place a run asks JEV to decide; the key matches the call ids the runtime records. */
/** `live`: a live JEV verify, which resolves to its own contract version (LIVE_FINDING_VERIFY). */
export type DecisionPoint = { key: string; kind: DecisionKind; stepId?: string; live?: true }

/** The JEV decisions a spec makes, mirroring when graph-plan.ts and its steps ask JEV. */
export function workflowDecisionPoints(spec: WorkflowSpec): DecisionPoint[] {
  const points: DecisionPoint[] = spec.oneAnswer
    ? [{ key: 'route', kind: 'one-answer-route', stepId: spec.oneAnswer.step }]
    : []
  if (spec.find) {
    // Find the best runs its own pipeline over its two steps; nothing else plans.
    const judge = findJudgeStep(spec)
    return judge
      ? [
          ...points,
          { key: `${judge.id}/screen`, kind: 'screen-order', stepId: judge.id },
          ...(judge.jev
            ? [{ key: `${judge.id}/ballot`, kind: 'rank-ballot' as const, stepId: judge.id }]
            : [])
        ]
      : points
  }
  for (const step of spec.steps) {
    if (step.byCriterion) {
      points.push({ key: `${step.id}/line`, kind: 'criterion-line', stepId: step.id })
    } else if (step.kind === 'rank' && step.jev && !step.forEach) {
      points.push({ key: `${step.id}/ballot`, kind: 'rank-ballot', stepId: step.id })
    }
    if (step.forEach?.screen?.shortlist) {
      points.push({ key: `${step.id}/shortlist`, kind: 'hard-limit-gate', stepId: step.id })
    } else if (step.forEach?.screen && step.kind === 'review') {
      points.push({ key: `${step.id}/set-aside`, kind: 'set-aside-gate', stepId: step.id })
    }
    if (step.jevVerify && step.forEach && step.kind === 'review') {
      points.push({
        key: `${step.id}/verify`,
        kind: 'finding-verify',
        stepId: step.id,
        ...(step.jevVerify.mode === 'live' ? { live: true as const } : {})
      })
    }
  }
  if (councilFinalCheckSteps(spec)) {
    points.push({ key: 'final-check', kind: 'final-check' })
  }
  return points
}

/** The contract a kind of decision runs under in a spec: the template's own, else the generic one. */
export function templateContractRef(
  spec: Pick<WorkflowSpec, 'template'>,
  kind: DecisionKind,
  table: ContractTable = CURRENT_CONTRACTS
): ContractRef {
  return table.byTemplate[spec.template]?.[kind] ?? table.generic[kind]
}

/** Each decision point's contract: the template's own for that kind, else the generic one. */
export function resolveDecisionContracts(
  spec: WorkflowSpec,
  table: ContractTable = CURRENT_CONTRACTS
): Record<string, ContractRef> {
  return Object.fromEntries(
    workflowDecisionPoints(spec).map((point) => [
      point.key,
      point.live
        ? (LIVE_FINDING_VERIFY[spec.template] ?? LIVE_FINDING_VERIFY.generic)
        : templateContractRef(spec, point.kind, table)
    ])
  )
}
