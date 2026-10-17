import {
  advertisingDecisionEnvelope,
  advertisingDecisionKind,
  advertisingDecisionLabels,
  advertisingRoutinePolicy,
  type AdvertisingDecisionEnvelope,
  type AdvertisingRoutinePolicy,
  type AdvertisingEvidence,
  type BoundAdvertisingDecision
} from '../../shared/typesafe-advertising'
import type {
  DecisionOutcome,
  DecisionQuestions,
  DecisionRequest,
  DecisionValue
} from '../../shared/structured-decisions'
import { captureConsoleWorkflowPerson } from '../backoffice/console-workflow-person'
import { assertLocalMetaReadAuthorized } from './local-meta-read-authority'
import type { AdvertisingEvidenceScope } from './typesafe-advertising-local-scope'
import {
  advertisingDigest,
  advertisingEvidenceRevision,
  fetchAdvertisingEvidence,
  readAdvertisingCandidates
} from './typesafe-advertising-evidence'

export type AdvertisingEvaluationInput = {
  routineId: string
  runId: string
  content: string
  policy: AdvertisingRoutinePolicy
  scope?: AdvertisingEvidenceScope
}
export type AdvertisingEvaluator = (request: DecisionRequest) => Promise<DecisionOutcome>

function questionsFor(evidence: AdvertisingEvidence[]): DecisionQuestions {
  return Object.fromEntries(
    evidence.map((item, index) => [
      `object_${index}`,
      {
        type: 'choice' as const,
        instructions: `Choose the recommendation for object_${index} only from its source evidence. Missing metrics are unknown. This is a recommendation, never execution permission. Do not infer human approval or invent budget amounts. Use NO_ACTION if the evidence is insufficient.${item.source === 'local.meta.graph' ? ' Collection freshness is not metric-computation freshness. Today and attribution are provisional; computation time and attribution lag are unknown.' : ''}`,
        criteria: {
          KEEP_RUNNING:
            'Keep an already active object running unchanged when supported by observed results.',
          TURN_ON:
            'Recommend turning on a paused object at its existing budget only when evidence supports it.',
          PAUSE:
            'Recommend pausing an active object only when reliable observed performance supports it.',
          INCREASE_BUDGET:
            'Recommend a separate human review for a budget increase. No amount or write is authorized.',
          DECREASE_BUDGET:
            'Recommend a separate human review for a budget decrease. Profitable budgets require explicit permission.',
          NO_ACTION:
            'Make no change because the evidence is incomplete, uncertain or does not support a specific change.'
        }
      }
    ])
  )
}

function decisionFor(
  input: AdvertisingEvaluationInput,
  evidence: AdvertisingEvidence,
  sourceRevision: string,
  answer: unknown
): BoundAdvertisingDecision {
  if (!answer || typeof answer !== 'object') {
    throw new Error('The decision response is incomplete.')
  }
  const value = answer as Record<string, unknown>
  const kind = advertisingDecisionKind.parse(value.choice)
  if (
    value.type !== 'choice' ||
    typeof value.confidence !== 'number' ||
    !Number.isFinite(value.confidence) ||
    value.confidence < input.policy.minConfidence ||
    value.confidence > 1
  ) {
    throw new Error('Decision confidence is below this routine’s required threshold.')
  }
  const probabilities = value.probabilities as Record<string, number> | undefined
  const labels = advertisingDecisionKind.options
  if (
    !probabilities ||
    Object.keys(probabilities).length !== labels.length ||
    labels.some(
      (label) =>
        typeof probabilities[label] !== 'number' ||
        !Number.isFinite(probabilities[label]) ||
        probabilities[label] < 0 ||
        probabilities[label] > 1
    ) ||
    Math.abs(labels.reduce((sum, label) => sum + probabilities[label], 0) - 1) > 0.02
  ) {
    throw new Error(
      'The decision probability distribution does not match the advertising contract.'
    )
  }
  if (
    ((kind === 'PAUSE' || kind === 'KEEP_RUNNING') && evidence.status !== 'ACTIVE') ||
    (kind === 'TURN_ON' && evidence.status !== 'PAUSED')
  ) {
    throw new Error('The decision conflicts with the current native delivery state.')
  }
  const statusChange = kind === 'PAUSE' || kind === 'TURN_ON'
  const localReadOnly = evidence.source === 'local.meta.graph'
  if (
    statusChange &&
    [
      evidence.metrics.spend,
      evidence.metrics.revenue,
      evidence.metrics.purchases,
      evidence.metrics.linkClicks
    ].some((metric) => metric === null)
  ) {
    throw new Error(
      'A status recommendation requires complete spend, revenue, purchase and link-click evidence.'
    )
  }
  if (kind === 'TURN_ON' && evidence.metrics.dailyBudget === null) {
    throw new Error('A turn-on recommendation requires a known current daily budget.')
  }
  const evidenceRevision = advertisingEvidenceRevision(evidence)
  return {
    id: advertisingDigest({
      runId: input.runId,
      routineId: input.routineId,
      sourceRevision,
      evidenceRevision,
      kind
    }),
    target: evidence.target,
    kind,
    confidence: value.confidence,
    probabilities: probabilities as BoundAdvertisingDecision['probabilities'],
    evidence,
    evidenceRevision,
    reasoningSummary: `${advertisingDecisionLabels[kind]} based on the source report for ${evidence.dateStart} (${evidence.timezone}). Metrics considered: spend, attributed revenue, purchases, registrations, leads, carts, checkouts and link clicks. This recommendation does not establish profitability or permission.${localReadOnly ? ' Local Meta access is read-only; this account has no signed action binding. Today’s metrics are provisional: provider computation time and attribution lag are unknown.' : ''}`,
    parameters: statusChange ? { status: kind === 'PAUSE' ? 'PAUSED' : 'ACTIVE' } : {},
    requiresHumanApproval: !['KEEP_RUNNING', 'NO_ACTION'].includes(kind),
    recommendationOnly: !statusChange || localReadOnly,
    verificationRequirements: statusChange
      ? [
          'Refresh and match source evidence before execution',
          localReadOnly
            ? 'Review the separately authorized local native status preview; missing cash and sibling evidence remain unknown'
            : 'Review the signed native action preview',
          'Confirm exact native status with provider readback'
        ]
      : []
  }
}

export async function evaluateAdvertisingRoutine(
  input: AdvertisingEvaluationInput,
  evaluate: AdvertisingEvaluator
): Promise<AdvertisingDecisionEnvelope> {
  const policy = advertisingRoutinePolicy.parse(input.policy)
  const base: AdvertisingDecisionEnvelope = {
    protocol: 'typesafe-advertising.v1',
    routineId: input.routineId,
    runId: input.runId,
    evaluatedAt: Date.now(),
    principal: 'unavailable',
    sourceRevision: advertisingDigest({ policy }),
    policy,
    status: 'blocked',
    reason: null,
    provider: null,
    model: null,
    decisions: []
  }
  try {
    const captured = await captureConsoleWorkflowPerson()
    if (!captured.ok) {
      throw new Error('Sign in to read this company’s advertising evidence.')
    }
    base.principal = captured.data.principal
    const targets = readAdvertisingCandidates(input.content, policy)
    const evidence = await fetchAdvertisingEvidence(targets, policy, undefined, input.scope)
    if (!captured.data.isCurrent()) {
      throw new Error('The signed-in person changed during evidence collection.')
    }
    base.sourceRevision = advertisingDigest({
      policy,
      evidence: evidence.map(advertisingEvidenceRevision)
    })
    const outcome = await evaluate({
      capability: 'advertising.routine',
      routineId: input.routineId,
      state: Object.fromEntries(
        evidence.map((item, index) => [`object_${index}`, item])
      ) as DecisionValue,
      questions: questionsFor(evidence)
    })
    if (outcome.status !== 'evaluated' || outcome.mode !== 'live') {
      throw new Error('Structured advertising decisions are unavailable for this routine.')
    }
    if (!captured.data.isCurrent()) {
      throw new Error('The signed-in person changed during decision evaluation.')
    }
    if (evidence.some((item) => item.source === 'local.meta.graph')) {
      if (!input.scope) {
        throw new Error('Local advertising evidence requires its bound routine execution scope.')
      }
      await assertLocalMetaReadAuthorized(input.scope, policy)
      if (!captured.data.isCurrent() || !input.scope.isCurrent()) {
        throw new Error('The signed-in person or routine changed during decision evaluation.')
      }
    }
    base.provider = outcome.result.provider
    base.model = outcome.result.model
    if (Object.keys(outcome.result.answers).length !== evidence.length) {
      throw new Error('The decision response returned a different set of advertising objects.')
    }
    const decisions = evidence.map((item, index) =>
      decisionFor(
        { ...input, policy },
        item,
        base.sourceRevision,
        outcome.result.answers[`object_${index}`]
      )
    )
    return advertisingDecisionEnvelope.parse({ ...base, status: 'ready', decisions })
  } catch (error) {
    base.reason =
      error instanceof Error && !error.message.includes('[')
        ? error.message.slice(0, 1000)
        : 'The advertising decision did not match its validated contract.'
    return advertisingDecisionEnvelope.parse(base)
  }
}
