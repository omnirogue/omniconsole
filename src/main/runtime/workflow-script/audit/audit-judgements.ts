import { createHash } from 'node:crypto'
import { JEV_MODEL } from '../../../../shared/jev-confidence'
import type { AuditFinding } from '../../../../shared/workflow-audit-contracts'
import {
  assertAuditCluster,
  distinctAuditSourceIds
} from '../../../../shared/workflow-audit-validation'
import {
  validateDecisionResult,
  snapshotDecisionRequest,
  type DecisionQuestion,
  type DecisionRequest
} from '../../../../shared/structured-decisions'
import { redactString } from '../../../observability/redactor'
import { jevDecide, type JevRankOptions } from '../../../structured-decisions/jev-rank'
import {
  AUDIT_JUDGEMENT_VERSION,
  AUDIT_THRESHOLD_VERSION,
  auditAvailabilityQuestion,
  auditPairQuestion,
  auditRankQuestion
} from './audit-judgement-contract'

export type AuditJudgementPair = { kind: 'agreement' | 'duplicate'; aId: string; bId: string }
export type AuditJudgementRequest = {
  callId: string
  findings: readonly AuditFinding[]
  pairs: readonly AuditJudgementPair[]
  verifiedSourceIds: readonly string[]
  rankThemes?: boolean
}
export type AuditJudgementObservation = {
  callId: string
  model: string
  questionVersion: string
  thresholdVersion: string
  route: 'generative'
  status: 'unknown' | 'voided'
  reason:
    | 'uncalibrated'
    | 'missing-redaction'
    | 'unverified-evidence'
    | 'invalid-input'
    | 'unavailable'
    | 'invalid-response'
  stateHash: string | null
  durationMs: number
  missingQuestionIds: string[]
  usage: { inputTokens: number; outputTokens: number } | null
  predictions: Record<
    string,
    | { type: 'score'; score: number; probabilities: Record<string, number> }
    | { type: 'noul'; noul: number }
  >
}
export type AuditJudgementOptions = JevRankOptions & {
  /** Corpus-specific redaction must remove names and identifiers before provider egress. */
  redact?: (text: string) => string
  record: (observation: AuditJudgementObservation) => void | Promise<void>
}

function buildRequest(
  input: AuditJudgementRequest,
  redact: (text: string) => string
): DecisionRequest {
  assertAuditCluster({ version: 1, findings: input.findings }, input.findings)
  const labels = new Map(input.findings.map((finding, index) => [finding.id, `F${index + 1}`]))
  const sourceLabels = new Map<string, string>()
  const summaries = input.findings.map((finding) => {
    const sourceIds = distinctAuditSourceIds(finding)
    for (const sourceId of sourceIds) {
      if (!sourceLabels.has(sourceId)) {
        sourceLabels.set(sourceId, `S${sourceLabels.size + 1}`)
      }
    }
    return {
      label: labels.get(finding.id)!,
      untrustedSummary: redactString(redact(`${finding.title}\n${finding.description}`)),
      distinctSourceCount: String(sourceIds.length),
      verifiedSources: sourceIds.map((id) => sourceLabels.get(id)!)
    }
  })
  const questions: Record<string, DecisionQuestion> = {}
  if (input.rankThemes !== false) {
    for (const [index, finding] of input.findings.entries()) {
      const label = labels.get(finding.id)!
      questions[`rank_${index}`] = auditRankQuestion(label)
      questions[`rank_${index}_availability`] = auditAvailabilityQuestion(
        `addressing finding ${label} would improve completed work`
      )
    }
  }
  for (const [index, pair] of input.pairs.entries()) {
    const left = labels.get(pair.aId)
    const right = labels.get(pair.bId)
    if (!left || !right || left === right) {
      throw new Error('Audit pair must name two supplied findings')
    }
    questions[`pair_${index}`] = auditPairQuestion(pair.kind, left, right)
    questions[`pair_${index}_availability`] = auditAvailabilityQuestion(
      `findings ${left} and ${right} describe the same underlying issue`
    )
  }
  return snapshotDecisionRequest({
    capability: 'workflow.audit.shadow',
    model: JEV_MODEL,
    state: { summaries },
    questions
  })
}

/** Shadow predictions never order, merge or discard findings; callers keep their model judgments. */
export async function observeAuditJudgements(
  input: AuditJudgementRequest,
  options: AuditJudgementOptions
): Promise<AuditJudgementObservation> {
  const began = Date.now()
  const observation: AuditJudgementObservation = {
    callId: input.callId,
    model: JEV_MODEL,
    questionVersion: AUDIT_JUDGEMENT_VERSION,
    thresholdVersion: AUDIT_THRESHOLD_VERSION,
    route: 'generative',
    status: 'unknown',
    reason: 'missing-redaction',
    stateHash: null,
    durationMs: 0,
    missingQuestionIds: [],
    usage: null,
    predictions: {}
  }
  const record = async () => {
    observation.durationMs = Date.now() - began
    await options.record(observation)
    return observation
  }
  if (!options.redact) {
    return record()
  }
  const verified = new Set(input.verifiedSourceIds)
  if (
    input.findings.some((finding) =>
      finding.evidence.some(({ sourceId }) => !verified.has(sourceId))
    )
  ) {
    observation.reason = 'unverified-evidence'
    return record()
  }
  let request: DecisionRequest
  try {
    request = buildRequest(input, options.redact)
    observation.stateHash = createHash('sha256').update(JSON.stringify(request)).digest('hex')
  } catch {
    observation.reason = 'invalid-input'
    return record()
  }
  const result = await jevDecide(request, options)
  if ('failed' in result) {
    observation.reason = 'unavailable'
    return record()
  }
  try {
    observation.missingQuestionIds = Object.keys(request.questions).filter(
      (key) => !(key in (result.answers ?? {}))
    )
    const validated = validateDecisionResult(result, request)
    if (result.model !== JEV_MODEL) {
      throw new Error('Unpinned JEV result')
    }
    observation.usage = validated.usage
    for (const [id, answer] of Object.entries(validated.answers)) {
      if (answer.type === 'score') {
        observation.predictions[id] = {
          type: 'score',
          score: answer.score,
          probabilities: answer.probabilities
        }
      } else if (answer.type === 'noul') {
        observation.predictions[id] = { type: 'noul', noul: answer.noul }
      }
    }
    observation.reason = 'uncalibrated'
  } catch {
    observation.status = 'voided'
    observation.reason = 'invalid-response'
  }
  return record()
}
